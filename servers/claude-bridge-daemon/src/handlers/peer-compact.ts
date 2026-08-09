import { mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  COMPACT_RACE_PERCENT,
  DEFAULT_VERIFY_TIMEOUT_MS,
  markTranscript,
  readPeerContext,
  watchForCompact,
} from "../compact-verify.ts";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import { busyOf, readAgents } from "../hosts/agents-json.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import {
  ALL_ACK_CHANNELS,
  type AckVerdict,
  compactAcks,
  requestFromPeer,
  verifyAckFile,
} from "./ack-protocol.ts";
import type { HandlerContext } from "./context.ts";
import { bridgeIdOf } from "./peer-identity.ts";
import { ambiguousPeerMessage, resolvePeerRef } from "./peer-ref.ts";

/**
 * peer_compact — orchestrated `/compact` inject into a live peer.
 *
 * §5.3 sequence:
 *   1. Write a bridge inbox message to the peer through the canonical
 *      envelope writer — the operator playbook tells peers to react by
 *      writing their compact anchor and then touching
 *      `~/.claude-bridge/control/compact-ack/<sessionId>.json`.
 *   2. Poll for the ack file within `anchorTimeoutMs` (default 300 s — see
 *      DEFAULT_ANCHOR_TIMEOUT_MS; a real anchor takes minutes, measured 122 s
 *      on a peer with substantial context).
 *      No ack → refuse; the peer wasn't ready and injecting /compact
 *      without a durable anchor would lose context.
 *   3. Ack received → `driver.sendKeys(sessionKey, "/compact")`.
 *   4. Log `peer_compacted` event; publish lifecycle event to
 *      subscribers.
 *
 * The AUTO watchdog stays gated behind `config.compactWatchdog.enabled`
 * (default false) — this handler is only invoked directly. Ownership
 * of the flip is the owner's.
 *
 * THE INVARIANT THAT WAS NOT ONE (corrected v0.11.25):
 *
 *   This comment used to argue that no idle check was needed, because THE ACK
 *   IS ITSELF THE PROOF OF IDLE — a peer only reaches its inbox between turns,
 *   so a peer that acked was not mid-generation.
 *
 *   The premise is true and the conclusion does not follow. The ack proves the
 *   peer was idle WHEN IT ACKED. Between the ack and the inject the peer is
 *   free to start another turn, and on 2026-08-09 it did: the ack landed, the
 *   daemon injected 0.4 s after the peer began a Bash tool call, and Claude
 *   Code queued the `/compact` instead of running it. It ran 5 min 52 s later,
 *   after an autocompact had already emptied the context — the second
 *   compression at 9 %.
 *
 *   A proof about one instant is not a proof about the next one. The fix is not
 *   a better idle check (see `compact-verify.ts` for why one cannot be built);
 *   it is to stop claiming success from the send and read the outcome out of
 *   the peer's own transcript.
 */

/*
 * CHARTER §8 — where the audit surface actually is.
 *
 * This comment used to claim that the line above was "the only send-keys path
 * in the daemon". It stopped being true when `wake.ts` gained one, and nobody
 * noticed, because the sentence was load-bearing for an audit point and was
 * maintained by memory. A count written into prose is a count that goes stale
 * silently.
 *
 * The audit surface is `TmuxDriver.sendKeys` — ONE function, which every
 * injection goes through and which owns the clear-first invariant since
 * v0.11.6. How many callers it has is a question for the code, and the code
 * answers it:
 *
 *     grep -rn 'sendKeys(' servers/claude-bridge-daemon/src
 */

/**
 * How long a peer gets to produce its anchor.
 *
 * Was 30 s, and that number was never once tested against the real task,
 * because the anchor request never arrived (see `writeAnchorRequestMsg`) and
 * every run failed long before the peer could have answered. With delivery
 * fixed, the first honest measurement on 2026-08-06: request at 06:39:37, ack
 * at 06:41:39 — **122 seconds**, on a peer that started work immediately.
 *
 * The peer is not pressing a button. It reads the request, writes a compact
 * anchor — a document meant to survive the loss of its context — and only then
 * touches the ack. Minutes, not seconds. A timeout under that does not protect
 * anything; it just reports `anchor_timeout` for work that was going fine, and
 * the operator reads it as "the peer is not answering".
 */
const DEFAULT_ANCHOR_TIMEOUT_MS = 300_000;
const DEFAULT_ACK_POLL_MS = 500;

export const PeerCompactArgsSchema = z
  .object({
    peer: z.string().min(1),
    anchorTimeoutMs: z.number().int().positive().max(300_000).optional(),
    ackPollMs: z.number().int().positive().max(10_000).optional(),
    /** Skip the anchor request → treat the ack file as pre-existing. */
    skipAnchorRequest: z.boolean().default(false),
    /**
     * How long to watch the peer's transcript for the compact to actually run.
     *
     * A parameter, not a constant, because the two honest measurements are
     * 122 s and 130 s on peers around 760k tokens, and the fleet has peers at
     * 846k. A number tuned to today's largest peer is a number that starts
     * lying the day somebody grows past it.
     */
    verifyTimeoutMs: z.number().int().positive().max(600_000).optional(),
    reason: z.string().optional(),
  })
  .strict();

export type PeerCompactArgs = z.infer<typeof PeerCompactArgsSchema>;

/**
 * The compact side of the shared ack protocol.
 *
 * Every helper this file used to own — the directory, the freshness check, the
 * stale sweep, the startup sweep, the poll, the consume, the request envelope —
 * now lives in `ack-protocol.ts`, because `team_stop` needs the same protocol
 * and a second copy is how the first one drifts. The behaviour is unchanged;
 * the v0.11.3 regression tests are the referee for that claim.
 */

/**
 * Public name kept for `daemon.ts` and the v0.11.3 stale-ack regression tests.
 *
 * It swept ONE channel until v0.11.18 — compact's — because compact was the
 * only channel when it was written, and each later channel was added to the
 * per-request sweep without anybody coming back here. A daemon that died
 * mid-stop therefore left a stop-ack lying in wait, which is the very case this
 * function exists for.
 *
 * Enumerating the channels here has the same shape as the defect it fixes, so
 * the list comes from `ALL_ACK_CHANNELS` in `ack-protocol.ts`: a fourth channel
 * is swept because it exists, not because somebody remembered.
 */
export async function sweepAllAcksAtStartup(): Promise<number> {
  let swept = 0;
  for (const channel of ALL_ACK_CHANNELS) swept += await channel.sweepAllAtStartup();
  return swept;
}

/** Public name kept for the v0.11.3 stale-ack regression tests. */
export const verifyAck = verifyAckFile;

export type { AckVerdict };

/**
 * The anchor request, in the one envelope shape the recipient can read.
 *
 * This used to build its own object and write it with a raw `atomicWriteJson`,
 * and that object disagreed with `MessageEnvelopeSchema` in five places at
 * once: `from` and `to` were `{handle, name}` rather than strings, the
 * timestamp was `ts` rather than `sentAt`, `content` was an object, and `kind`
 * was `compact-anchor-request`, which is not in the enum.
 *
 * The recipient reads its inbox through `readEnvelope`, which `safeParse`s and
 * returns null on failure. So the file landed in `pending/`, the watcher fired,
 * the push pump ran — and `listPending` did not include it. No push, no
 * piggyback, no delivery, no error anywhere. `peer_compact` therefore never
 * completed once since it shipped in v0.10.0-rc: every run ended in
 * `anchor_timeout`, and the timeout was read as "the peer is not answering"
 * for two days, through three wrong hypotheses (deaf peer, open TUI dialog,
 * dropped `--channels` flag).
 *
 * `requestFromPeer` writes through `writeEnvelope`, which `parse`s rather than
 * `safeParse`s, so a malformed envelope throws at the WRITER instead of
 * vanishing at the reader. The write site knows what it meant; the read site
 * only knows something did not fit.
 *
 * On 2026-08-08 the identical defect was found in `team_stop`, which had never
 * been given this fix. Hence the shared module: the lesson now has one home.
 */
async function writeAnchorRequestMsg(peerId: string, threadId: string): Promise<string> {
  return requestFromPeer(
    peerId,
    threadId,
    [
      "Compact anchor requested by the control plane. Write your compact anchor, then",
      "write ~/.claude-bridge/control/compact-ack/<sessionId>.json containing:",
      "",
      `    {"threadId": "${threadId}", "anchor": "<where you put it>"}`,
      "",
      "The daemon injects `/compact` only after that file appears, so nothing is",
      "compacted without a durable anchor behind it.",
      "",
      "The `threadId` matters: an ack that answers a DIFFERENT request is refused.",
      "An empty `touch` still works — it is accepted on freshness alone — but two",
      "compacts racing on one peer can only be told apart by the thread.",
    ].join("\n"),
  );
}

// Resolution lives in peer-ref.ts — a duplicate name must refuse, not pick.

/** The team of whoever sent this request — the search domain for short names. */
function callerTeamOf(req: RequestEnvelope, ctx: HandlerContext): string | null {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}

export async function handlePeerCompact(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = PeerCompactArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf(req, ctx));
  if (resolved.kind === "ambiguous") {
    return errResult(
      req.id,
      req.tool,
      "ambiguous_peer",
      ambiguousPeerMessage(args.peer, resolved.candidates),
      { peer: args.peer, candidates: resolved.candidates },
    );
  }
  const found = resolved.kind === "found" ? resolved : null;
  if (!found) {
    return errResult(
      req.id,
      req.tool,
      "peer_not_found",
      `No peer with id/name '${args.peer}' in daemon state`,
      { peer: args.peer },
    );
  }
  const handle = found.handle;
  const record = ctx.state.peers[handle];
  if (!record) {
    return errResult(req.id, req.tool, "peer_gone", "Peer disappeared before compact started", {
      handle,
    });
  }
  /**
   * THE BRIDGE ADDRESS — the defect R3 found by renaming (v0.11.21).
   *
   * v0.11.18 discovered that the daemon addresses a peer's inbox by the
   * registry key while the peer drains its own session id, and fixed it in
   * `peer_stop` and `peer_restart`. `peer_compact` was named in that finding
   * and did not get the fix: it wrote the anchor request into
   * `inbox/<handle>/pending/` and then polled `compact-ack/<handle>.json` for a
   * reply, while the message it sent told the peer to answer under its OWN
   * session id.
   *
   * For 24 of the 26 records on this fleet the two are the same string, so it
   * worked; for a handle-keyed peer the compact could only ever end in
   * `anchor_timeout` — and `team_layout` is what makes handle-keyed peers.
   *
   * The rename is what exposed it. `sessionId` meant both things, so the code
   * read as correct in both readings.
   */
  const bridgeId = bridgeIdOf(record);
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;
  const sendKeys = ctx.hostDriver.sendKeys?.bind(ctx.hostDriver);
  if (!sendKeys) {
    return errResult(
      req.id,
      req.tool,
      "sendkeys_unsupported",
      `Host driver '${ctx.hostDriver.name}' does not support send-keys on this platform`,
      { hostDriver: ctx.hostDriver.name },
    );
  }

  const anchorTimeoutMs = args.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
  const ackPollMs = args.ackPollMs ?? DEFAULT_ACK_POLL_MS;
  const threadId = `compact:${bridgeId}:${Date.now().toString(36)}`;

  await mkdir(compactAcks.dir(), { recursive: true });

  // The clock the ack is judged against. Taken BEFORE the request is written,
  // so an ack the peer produces the instant it reads the message still counts.
  const requestedAtMs = Date.now();

  let anchorMsgId: string | null = null;
  let sweptStale: string | null = null;
  if (!args.skipAnchorRequest) {
    // Clear the ground first. Everything after this point is an answer to THIS
    // request, without anyone having to reason about it.
    sweptStale = await compactAcks.sweepStale(bridgeId, "stale");
    if (sweptStale) {
      await writeEvent({
        event: "peer_compact_stale_ack_swept",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle,
          movedTo: sweptStale,
          note: "An ack was already on disk before this request. It answered something else — v0.11.2 and earlier would have injected /compact over it.",
        },
      });
    }
    try {
      anchorMsgId = await writeAnchorRequestMsg(bridgeId, threadId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeEvent({
        event: "peer_compact_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { handle, stage: "anchor_request", err: msg },
      });
      return errResult(req.id, req.tool, "anchor_request_write_failed", msg, { handle });
    }
    await writeEvent({
      event: "peer_compact_anchor_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, threadId, anchorMsgId, timeoutMs: anchorTimeoutMs },
    });
  }

  const deadline = Date.now() + anchorTimeoutMs;
  // `skipAnchorRequest` exists to act on an ack somebody arranged out of band,
  // so its ack legitimately predates this request — but only just. Anything
  // older than the anchor window is the stale-ack defect wearing the one hat
  // that makes it look intentional.
  const ackFloorMs = args.skipAnchorRequest ? requestedAtMs - anchorTimeoutMs : requestedAtMs;
  const verdict = await compactAcks.poll(bridgeId, deadline, ackPollMs, ackFloorMs, threadId);
  if (!verdict.accepted) {
    await writeEvent({
      event: "peer_compact_anchor_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle,
        sessionKey,
        threadId,
        timeoutMs: anchorTimeoutMs,
        // WHY there was no usable ack, not just that there wasn't one. "An ack
        // was there and it was not yours" and "nobody answered" call for
        // different next steps, and for two days the tool reported only the
        // second while the first was happening.
        ackVerdict: verdict.reason,
        ackWrittenAt: verdict.writtenAt ?? null,
        ackThreadId: verdict.ackThreadId ?? null,
      },
    });
    // Three different situations used to arrive as one sentence, and for two
    // days everyone read that sentence as "the peer is deaf".
    const why =
      verdict.reason === "too_old"
        ? `an ack exists but predates this request (written ${verdict.writtenAt}) — it answers something else`
        : verdict.reason === "wrong_thread"
          ? `an ack exists but belongs to thread '${verdict.ackThreadId}', not '${threadId}' — another compact is running on this peer`
          : `no ack appeared within ${anchorTimeoutMs}ms`;
    return errResult(
      req.id,
      req.tool,
      "anchor_timeout",
      `Peer '${handle}' was not compacted: ${why}. Nothing was injected.`,
      {
        handle,
        threadId,
        ackVerdict: verdict.reason,
        ackWrittenAt: verdict.writtenAt ?? null,
        ackThreadId: verdict.ackThreadId ?? null,
      },
    );
  }

  /**
   * How full is the peer, and is this a race? (v0.11.25, ⑤)
   *
   * Not a gate — a name. Above `COMPACT_RACE_PERCENT` the peer may start its
   * own autocompact at any moment, and then two compressions run against one
   * context. Measured twice on 2026-08-09: the designer's peer at 1 001 614
   * tokens, and the keeper at 85 % which began autocompacting in the middle of
   * a manual orchestration. The operator keeps the decision; what changes is
   * that the answer says the risk out loud instead of leaving them to find out.
   */
  const snapshot = await readPeerContext(bridgeId);
  const contextPercentBefore = snapshot.usedPercentage;
  const raceRisk =
    contextPercentBefore !== null && contextPercentBefore >= COMPACT_RACE_PERCENT
      ? {
          level: "compact_race_risk" as const,
          percentUsed: contextPercentBefore,
          note: `Peer is at ${contextPercentBefore}% context. Claude Code may autocompact on its own before this /compact runs, which compresses the same context twice.`,
        }
      : null;
  const transcriptPath = snapshot.transcriptPath;

  /**
   * IS THE PEER MID-TURN? (v0.11.26, the third source)
   *
   * v0.11.25 said this could not be asked. It surveyed the pane, which during
   * streaming is indistinguishable from idle, and `turnInProgress`, whose last
   * JSONL event at inject time was `assistant`. Both measurements hold; the
   * conclusion did not, because `claude agents --json` was never tried. It
   * answers in about 600 ms without a TTY.
   *
   * Asked HERE and not earlier: the anchor ack proves the peer was responsive
   * a moment ago, not that it is free now — writing the ack is itself a turn,
   * and it may still be finishing.
   *
   * DELIBERATE DEVIATION from `unknown counts as busy`. That rule is right
   * where the alternative is a retry; here refusing on `unknown` would make
   * every peer the source does not list — anything adopted without a measured
   * session id — permanently uncompactable. So only a POSITIVE `busy` stops
   * the inject. `unknown` proceeds and is recorded, because v0.11.25's
   * after-the-fact verification already covers the case this gate misses.
   */
  const peerSessionId = record.observed.sessionId ?? undefined;
  const agentBusy = busyOf(await readAgents(), peerSessionId);
  if (agentBusy === "busy") {
    await writeEvent({
      event: "peer_compact_skipped_busy",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle,
        sessionKey,
        threadId,
        anchorMsgId,
        contextPercentBefore,
        source: "claude agents --json",
        note: "The peer is mid-turn. Injecting now would put /compact in its queue, to run at a time nobody chose — the 2026-08-09 incident.",
      },
    });
    return okResult(req.id, req.tool, {
      handle,
      sessionKey,
      threadId,
      anchorMsgId,
      contextPercentBefore,
      raceRisk,
      verified: false,
      outcome: "skipped_busy",
      agentBusy,
      note: "Nothing was injected: `claude agents --json` reports this peer as busy, and a command sent into a busy pane is queued rather than run. The peer's anchor has been written, so a retry once it is idle costs only the inject.",
    });
  }

  // Charter §8 audit checkpoint — record the EXACT keys we're about to inject
  // BEFORE the send-keys call.
  await writeEvent({
    event: "peer_compact_inject",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      handle,
      sessionKey,
      threadId,
      injectedKeys: "[daemon] /compact",
      contextPercentBefore,
      raceRisk: raceRisk?.level ?? null,
      transcriptPath,
    },
  });

  // The offset must be taken BEFORE the keys go in. Everything appended after
  // this byte is a consequence of our inject; everything before it is history.
  const fromOffset = transcriptPath ? await markTranscript(transcriptPath) : 0;

  try {
    await sendKeys(sessionKey, "/compact");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_compact_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, stage: "send_keys", err: msg },
    });
    return errResult(req.id, req.tool, "send_keys_failed", msg, { handle, sessionKey });
  }
  await compactAcks.consume(bridgeId);

  /**
   * The keys are in. Now find out whether anything HAPPENED.
   *
   * Until v0.11.25 the next two statements were `peer_compacted` and a return.
   * That is the false success the P0 was made of: `sendKeys` reports on a
   * terminal, and the question is about a peer.
   */
  // `agentBusy` travels with every outcome: a result that says `unknown` is a
  // result whose pre-inject gate had no opinion, and a reader needs that to
  // interpret a `compact_queued` afterwards.
  const common = {
    handle,
    sessionKey,
    threadId,
    anchorMsgId,
    contextPercentBefore,
    raceRisk,
    agentBusy,
  };
  if (!transcriptPath) {
    // No statusLine capture for this peer → no transcript path → nothing to
    // watch. Say so in the result rather than reporting the old, cheap success:
    // an unverifiable compact and a verified one must not read the same.
    await writeEvent({
      event: "peer_compact_unverified",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        ...common,
        why: "no statusLine capture for this peer, so its transcript path is unknown",
        setupPointer: "docs/SETUP-LIVE-DATA.md",
      },
    });
    return okResult(req.id, req.tool, {
      ...common,
      verified: false,
      outcome: "unverifiable",
      note: "Keys were delivered to the input line, but this peer has no statusLine capture, so the daemon cannot read its transcript to confirm the compact ran. See docs/SETUP-LIVE-DATA.md.",
    });
  }

  const watch = await watchForCompact({
    transcriptPath,
    fromOffset,
    payload: "/compact",
    timeoutMs: args.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
  });

  if (watch.kind === "executed") {
    if (watch.preemptedByAuto) {
      // THE INCIDENT, caught this time. Claude Code compacted first and ours
      // ran on top of it. Loud, and in the audit trail — not a footnote in a
      // success payload.
      await writeEvent({
        event: "peer_compact_preempted_by_auto",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          ...common,
          auto: watch.preemptedByAuto,
          ours: { at: watch.at, preTokens: watch.preTokens, postTokens: watch.postTokens },
          queuedAt: watch.queuedAt,
          note: "Claude Code autocompacted before our /compact was dequeued, so the peer was compressed twice — the second time on an already-compacted context. This is the 2026-08-09 incident.",
        },
      });
    }
    await writeEvent({
      event: "peer_compacted",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        ...common,
        reason: args.reason ?? null,
        compactedAt: watch.at,
        preTokens: watch.preTokens,
        postTokens: watch.postTokens,
        queuedAt: watch.queuedAt,
      },
    });
    await publishLifecycleEvent({
      event: "peer_compacted",
      handle: handle,
      sessionKey,
      details: { threadId, reason: args.reason ?? null, compactedAt: watch.at },
    });

    /**
     * Wake the peer — Zdeněk's item, and now with a measured rule behind it.
     *
     * A peer does not necessarily resume after `/compact`; it sits at the
     * prompt. Measured across three cases on 2026-08-09: it continues by itself
     * exactly when something is still waiting in its queue, and sits silent
     * when the queue is empty. The daemon cannot see that queue, and a
     * duplicate wake costs one short turn while a missed one costs a peer that
     * nobody notices is asleep. So: always.
     *
     * PLAIN TEXT, never a slash command. A payload beginning with `/` opens the
     * command palette, and this line is meant for the agent, not for Claude
     * Code's command parser.
     */
    const wakeLine = wakeAfterCompactLine();
    try {
      await sendKeys(sessionKey, wakeLine);
    } catch (e) {
      // A failed wake does not undo a successful compact. Record it and report
      // it in the payload so the operator knows to look.
      const msg = e instanceof Error ? e.message : String(e);
      await writeEvent({
        event: "peer_compact_wake_failed",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { ...common, err: msg },
      });
      return okResult(req.id, req.tool, {
        ...common,
        verified: true,
        outcome: "compacted",
        compactedAt: watch.at,
        preTokens: watch.preTokens,
        postTokens: watch.postTokens,
        queuedAt: watch.queuedAt,
        preemptedByAuto: watch.preemptedByAuto,
        woken: false,
        wakeError: msg,
      });
    }
    return okResult(req.id, req.tool, {
      ...common,
      verified: true,
      outcome: "compacted",
      compactedAt: watch.at,
      preTokens: watch.preTokens,
      postTokens: watch.postTokens,
      queuedAt: watch.queuedAt,
      preemptedByAuto: watch.preemptedByAuto,
      woken: true,
    });
  }

  // Everything below this line is a compact that did NOT happen inside the
  // window. None of it is `peer_compacted`, and none of it is silent.
  await writeEvent({
    event: "peer_compact_unresolved",
    level: watch.kind === "silent" ? "warn" : "error",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { ...common, watch },
  });

  if (watch.kind === "queued-unresolved") {
    return errResult(
      req.id,
      req.tool,
      "compact_queued",
      `Peer '${handle}' was BUSY: Claude Code queued the /compact at ${watch.queuedAt} instead of running it, and it had not run ${watch.waitedMs} ms later. It cannot be taken back out of the queue — it WILL run, at a moment nobody chose, against whatever context exists then. Watch the peer or re-check with peer_compact once it is idle.`,
      { ...common, queuedAt: watch.queuedAt, waitedMs: watch.waitedMs },
    );
  }
  if (watch.kind === "preempted-unresolved") {
    return errResult(
      req.id,
      req.tool,
      "compact_preempted_by_auto",
      `Claude Code autocompacted peer '${handle}' by itself at ${watch.auto.at} (${watch.auto.preTokens} → ${watch.auto.postTokens} tokens) and OUR /compact has still not run. When it does it will compress an already-compacted context. This is the 2026-08-09 incident, caught in flight.`,
      { ...common, auto: watch.auto, queuedAt: watch.queuedAt, waitedMs: watch.waitedMs },
    );
  }
  return errResult(
    req.id,
    req.tool,
    "compact_not_observed",
    `Keys reached the input line of peer '${handle}', but its transcript shows no compact and no queued command after ${watch.waitedMs} ms. Nothing is known to have happened — do not assume it did.`,
    { ...common, waitedMs: watch.waitedMs },
  );
}

/**
 * What the peer is told after its context was compressed.
 *
 * One line, plain text, no leading slash — see the call site for why. It names
 * the anchor first because that is the only thing that survived, and asks for a
 * report because a compacted peer that says nothing is indistinguishable from a
 * dead one.
 */
export function wakeAfterCompactLine(): string {
  return "[daemon] Compact complete — re-onboard from your anchor, read your inbox (peer_inbox_read) and report to whoever requested the compact.";
}

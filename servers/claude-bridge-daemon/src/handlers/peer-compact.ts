import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
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
 *   2. Poll for the ack file within `anchorTimeoutMs` (default 30 s).
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
 * THE INVARIANT — why there is no "is the peer idle?" check:
 *
 *   THE ACK IS ITSELF THE PROOF OF IDLE. A peer only reaches its inbox between
 *   turns, so a peer that acked was, by construction, not mid-generation. The
 *   tool therefore never injects `/compact` into a running turn without having
 *   to observe anything — and that matters, because "idle" is not reliably
 *   observable from outside.
 *
 * A peer that is busy simply does not answer in time and the run ends in
 * `anchor_timeout` with nothing injected. That is the correct outcome, not a
 * failure to handle the case (edge case B4, ratified 2026-08-06).
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

  // Charter §8 audit checkpoint — record the EXACT keys we're about to inject
  // BEFORE the send-keys call.
  await writeEvent({
    event: "peer_compact_inject",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { handle, sessionKey, threadId, injectedKeys: "[daemon] /compact" },
  });

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
  await writeEvent({
    event: "peer_compacted",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { handle, sessionKey, threadId, reason: args.reason ?? null },
  });
  await publishLifecycleEvent({
    event: "peer_compacted",
    handle: handle,
    sessionKey,
    details: { threadId, reason: args.reason ?? null },
  });
  return okResult(req.id, req.tool, { handle, sessionKey, threadId, anchorMsgId });
}

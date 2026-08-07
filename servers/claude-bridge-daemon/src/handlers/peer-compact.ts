import { randomBytes } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { controlDir, syntheticSenderId, writeEnvelope } from "@claude-bridge/shared";
import { z } from "zod";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
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
 *   3. Ack received → `driver.sendKeys(sessionKey, "/compact")` — the
 *      only send-keys path in the daemon (charter §8 audit target).
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
const COMPACT_ACK_FILENAME_EXTENSION = ".json";

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

function compactAckDir(): string {
  return join(controlDir(), "compact-ack");
}

function compactAckPath(sessionId: string): string {
  return join(compactAckDir(), `${sessionId}${COMPACT_ACK_FILENAME_EXTENSION}`);
}

function generateMsgId(): string {
  const ms = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ms}-${rand}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move any ack already lying around for this peer out of the way. Once, before
 * we start waiting.
 *
 * This is the load-bearing half of the stale-ack fix, and it is stronger than
 * any comparison: with the directory swept, every ack that appears afterwards
 * is fresh BY CONSTRUCTION. Comparing timestamps still leaves you reasoning
 * about clocks; an empty directory does not.
 *
 * The defect it closes, measured 2026-08-06 on the live fleet: a run at 06:39
 * timed out at 06:41, the peer finished writing its anchor at 06:41:39 and
 * touched the ack anyway, and the NEXT run at 06:43 found that file and
 * injected `/compact` in the same second. Nobody checked that the anchor
 * belonged to that request. A tool whose only purpose is to refuse a compact
 * without a fresh anchor accepted a stale one.
 */
async function sweepStaleAck(sessionId: string, reason: string): Promise<string | null> {
  const src = compactAckPath(sessionId);
  if (!(await fileExists(src))) return null;
  const done = join(compactAckDir(), "done");
  await mkdir(done, { recursive: true });
  const dest = join(done, `${sessionId}-${reason}-${Date.now()}.json`);
  try {
    await rename(src, dest);
  } catch {
    await unlink(src).catch(() => undefined);
  }
  return dest;
}

/**
 * Clear every ack left over from a previous daemon. Called once at startup.
 *
 * A daemon that died mid-compact leaves an ack nobody will ever consume, and
 * the next request for that peer would have found it waiting. The per-request
 * sweep already covers that, so this is defence in depth — but it is also the
 * only thing that cleans up after `skipAnchorRequest`, whose whole job is to
 * act on an ack the daemon did not ask for.
 */
export async function sweepAllAcksAtStartup(): Promise<number> {
  const dir = compactAckDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const done = join(dir, "done");
  await mkdir(done, { recursive: true });
  let swept = 0;
  for (const name of names) {
    if (!name.endsWith(COMPACT_ACK_FILENAME_EXTENSION)) continue;
    try {
      await rename(join(dir, name), join(done, `${name.slice(0, -5)}-startup-${Date.now()}.json`));
      swept++;
    } catch {
      // A directory, or something we do not own. Leave it.
    }
  }
  return swept;
}

export interface AckVerdict {
  accepted: boolean;
  reason: "fresh" | "none" | "too_old" | "wrong_thread";
  ackThreadId?: string | null;
  writtenAt?: string | null;
}

/**
 * Is this ack the answer to THIS request?
 *
 * Two independent checks, because they fail differently. The timestamp catches
 * an ack that predates the request — a leftover. The `threadId` catches an ack
 * that is recent but answers a DIFFERENT request, which is what two concurrent
 * compacts on one peer would produce.
 *
 * An ack without a `threadId` is accepted on freshness alone and logged: the
 * operator playbook has always said "touch the file", a human following it
 * writes nothing inside, and refusing that would break the documented path to
 * close a hole the sweep has already closed.
 */
export async function verifyAck(
  path: string,
  requestedAtMs: number,
  threadId: string,
): Promise<AckVerdict> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch {
    return { accepted: false, reason: "none" };
  }
  // One second of slack: the peer may touch the file in the same second the
  // request was written, and a filesystem timestamp is not a precision clock.
  if (stat.mtimeMs < requestedAtMs - 1_000) {
    return {
      accepted: false,
      reason: "too_old",
      writtenAt: new Date(stat.mtimeMs).toISOString(),
    };
  }
  let ackThreadId: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { threadId?: unknown };
    if (typeof parsed.threadId === "string") ackThreadId = parsed.threadId;
  } catch {
    // Not JSON, or empty — a `touch`ed file. Freshness is the only check left.
  }
  if (ackThreadId !== null && ackThreadId !== threadId) {
    return {
      accepted: false,
      reason: "wrong_thread",
      ackThreadId,
      writtenAt: new Date(stat.mtimeMs).toISOString(),
    };
  }
  return {
    accepted: true,
    reason: "fresh",
    ackThreadId,
    writtenAt: new Date(stat.mtimeMs).toISOString(),
  };
}

async function pollForAck(
  sessionId: string,
  deadline: number,
  pollMs: number,
  requestedAtMs: number,
  threadId: string,
): Promise<AckVerdict> {
  const path = compactAckPath(sessionId);
  let last: AckVerdict = { accepted: false, reason: "none" };
  while (Date.now() < deadline) {
    last = await verifyAck(path, requestedAtMs, threadId);
    if (last.accepted) return last;
    // A rejected ack is not a reason to stop waiting — the right one may still
    // arrive. It IS a reason to remember why the last one failed, so the
    // timeout can say "an ack was there and it was not yours".
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const final = await verifyAck(path, requestedAtMs, threadId);
  return final.accepted ? final : final.reason === "none" ? last : final;
}

async function consumeAckFile(sessionId: string): Promise<void> {
  const src = compactAckPath(sessionId);
  const done = join(compactAckDir(), "done");
  try {
    await mkdir(done, { recursive: true });
    await rename(src, join(done, `${sessionId}-${Date.now()}.json`));
  } catch {
    // Fallback: unlink if rename didn't take (e.g. cross-fs on temp dirs).
    await unlink(src).catch(() => undefined);
  }
}

/**
 * The anchor request, in the one envelope shape the recipient can read.
 *
 * This used to build its own object and write it with a raw `atomicWriteJson`,
 * and that object disagreed with `MessageEnvelopeSchema` in five places at
 * once: `from` and `to` were `{sessionId, name}` rather than strings, the
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
 * `writeEnvelope` is the fix and also the guard: it `parse`s rather than
 * `safeParse`s, so a malformed envelope throws at the WRITER instead of
 * vanishing at the reader. The write site knows what it meant; the read site
 * only knows something did not fit.
 *
 * `external:` marks the daemon as what it is — a sender that is not a peer.
 */
async function writeAnchorRequestMsg(peerId: string, threadId: string): Promise<string> {
  const msgId = generateMsgId();
  await writeEnvelope({
    id: msgId,
    from: syntheticSenderId("control-plane-daemon"),
    fromName: "control-plane-daemon",
    to: peerId,
    kind: "ask",
    sentAt: new Date().toISOString(),
    threadId,
    content: [
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
  });
  return msgId;
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
  const sessionId = found.sessionId;
  const record = ctx.state.peers[sessionId];
  if (!record) {
    return errResult(req.id, req.tool, "peer_gone", "Peer disappeared before compact started", {
      sessionId,
    });
  }
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
  const threadId = `compact:${sessionId}:${Date.now().toString(36)}`;

  await mkdir(compactAckDir(), { recursive: true });

  // The clock the ack is judged against. Taken BEFORE the request is written,
  // so an ack the peer produces the instant it reads the message still counts.
  const requestedAtMs = Date.now();

  let anchorMsgId: string | null = null;
  let sweptStale: string | null = null;
  if (!args.skipAnchorRequest) {
    // Clear the ground first. Everything after this point is an answer to THIS
    // request, without anyone having to reason about it.
    sweptStale = await sweepStaleAck(sessionId, "stale");
    if (sweptStale) {
      await writeEvent({
        event: "peer_compact_stale_ack_swept",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          sessionId,
          movedTo: sweptStale,
          note: "An ack was already on disk before this request. It answered something else — v0.11.2 and earlier would have injected /compact over it.",
        },
      });
    }
    try {
      anchorMsgId = await writeAnchorRequestMsg(sessionId, threadId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeEvent({
        event: "peer_compact_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { sessionId, stage: "anchor_request", err: msg },
      });
      return errResult(req.id, req.tool, "anchor_request_write_failed", msg, { sessionId });
    }
    await writeEvent({
      event: "peer_compact_anchor_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, threadId, anchorMsgId, timeoutMs: anchorTimeoutMs },
    });
  }

  const deadline = Date.now() + anchorTimeoutMs;
  // `skipAnchorRequest` exists to act on an ack somebody arranged out of band,
  // so its ack legitimately predates this request — but only just. Anything
  // older than the anchor window is the stale-ack defect wearing the one hat
  // that makes it look intentional.
  const ackFloorMs = args.skipAnchorRequest ? requestedAtMs - anchorTimeoutMs : requestedAtMs;
  const verdict = await pollForAck(sessionId, deadline, ackPollMs, ackFloorMs, threadId);
  if (!verdict.accepted) {
    await writeEvent({
      event: "peer_compact_anchor_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId,
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
      `Peer '${sessionId}' was not compacted: ${why}. Nothing was injected.`,
      {
        sessionId,
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
    details: { sessionId, sessionKey, threadId, injectedKeys: "[daemon] /compact" },
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
      details: { sessionId, sessionKey, stage: "send_keys", err: msg },
    });
    return errResult(req.id, req.tool, "send_keys_failed", msg, { sessionId, sessionKey });
  }
  await consumeAckFile(sessionId);
  await writeEvent({
    event: "peer_compacted",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId, sessionKey, threadId, reason: args.reason ?? null },
  });
  await publishLifecycleEvent({
    event: "peer_compacted",
    sessionId,
    sessionKey,
    details: { threadId, reason: args.reason ?? null },
  });
  return okResult(req.id, req.tool, { sessionId, sessionKey, threadId, anchorMsgId });
}

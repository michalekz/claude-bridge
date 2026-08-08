import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { PeerRecord } from "../state.ts";
import type { HandlerContext } from "./context.ts";
import { ambiguousPeerMessage, resolvePeerRef } from "./peer-ref.ts";
import { applyStateChange } from "./state-writer.ts";
import {
  DEFAULT_STOP_ACK_POLL_MS,
  DEFAULT_STOP_ACK_TIMEOUT_MS,
  requestStop,
  stopAcks,
  stopThreadId,
} from "./stop-protocol.ts";

/**
 * peer_stop — ask a peer to stand down, then end its session.
 *
 * v0.11.15 (phase 1 of the lifecycle redesign) moved the courtesy DOWN here.
 * Until then this handler did one thing — `driver.kill()` — and the graceful
 * protocol lived in `team_stop`, one floor up. That was backwards against the
 * owner's principle that a team operation should be nothing but the primitive
 * repeated, and it meant the polite path was unreachable for a single peer.
 *
 * Two modes, and `force` picks between them:
 *
 *   force:false (default) — ASK FIRST.
 *     stop-request into the peer's inbox → wait for its ack → kill.
 *     No ack inside the window: NOTHING IS KILLED. The call fails honestly,
 *     the pending request stays on the record, and calling again resumes the
 *     same thread rather than asking twice.
 *
 *   force:true — kill now. No request, no waiting, shorter driver verify
 *     budget so an operator gets feedback fast when the host is not answering.
 *
 * FORCE SKIPS WAITING, NEVER EVIDENCE. It does not skip the dead-pane archive
 * in `driver.kill()`, and it does not skip the audit events. What it buys is
 * time, and time is the only thing it is allowed to buy.
 *
 * The driver is responsible for terminating the ENTIRE supervised tree (the
 * bg-pty-host lesson, designer msg mrxe9t7d) and for polling post-kill to
 * detect the respawn class of failures.
 */

export const PeerStopArgsSchema = z
  .object({
    peer: z.string().min(1),
    reason: z.string().optional(),
    /**
     * Skip the courtesy phase and kill immediately.
     *
     * BREAKING in v0.11.15: this used to be the only behaviour, so every
     * internal caller that wants it now says so explicitly. The default flipped
     * because a human typing `peer_stop` almost always means "wind it down",
     * and the dangerous reading is the one that should need a word.
     */
    force: z.boolean().default(false),
    /**
     * The courtesy already happened somewhere else — skip it, change nothing
     * else. FOR INTERNAL CALLERS.
     *
     * This exists because `force` means two things to the driver, and only one
     * of them belongs to an internal caller. `force` skips the ack wait AND
     * halves the post-kill verify budget (`tmux-driver.ts:571`) — and that
     * verify is what catches a supervised process respawning behind us. An
     * orchestrator that has already done the asking wants the first half and
     * must not silently buy the second: a shorter verify makes a false "kill
     * succeeded" more likely, and FORCE SKIPS WAITING, NEVER EVIDENCE.
     *
     * So `team_stop`, `team_layout` and `peer_restart` pin `skipCourtesy: true`
     * and pass `force` through unchanged, which reproduces their v0.11.14
     * behaviour exactly. A human still says `force: true` and gets both.
     */
    skipCourtesy: z.boolean().default(false),
    /** How long the peer gets to ack before the stop is reported as failed. */
    ackTimeoutMs: z.number().int().positive().max(600_000).optional(),
    ackPollMs: z.number().int().positive().max(10_000).optional(),
    /**
     * v0.10.1: keep the peer in state.peers with status:"stopped" instead
     * of deleting it. Used by team_stop so that team_layout apply can
     * resume the same sessionId later. Default false = original delete
     * semantics (backward-compatible with v0.10.0-rc.2 callers).
     */
    keepInState: z.boolean().default(false),
    /**
     * Only meaningful when keepInState:true — sets the resulting
     * PeerRecord.stoppedCleanly.
     *
     * Honoured in FORCE mode only. In the graceful path this handler measures
     * the outcome itself (an ack arrived, or it did not), and a measurement
     * does not take instructions from its caller. Passing it alongside
     * `force:false` is ignored, deliberately: the alternative is a record whose
     * `stoppedCleanly` says whatever the caller hoped for.
     */
    stoppedCleanly: z.boolean().nullable().optional(),
  })
  .strict();

export type PeerStopArgs = z.infer<typeof PeerStopArgsSchema>;

// Resolution lives in peer-ref.ts — see there for why a duplicate name must
// refuse rather than pick the first match.

/** The team of whoever sent this request — the search domain for short names. */
function callerTeamOf(req: RequestEnvelope, ctx: HandlerContext): string | null {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}

type CourtesyOutcome =
  /** `force:true` or `skipCourtesy:true` — nobody asked, here. */
  | { kind: "skipped" }
  /** No host session to ask. The kill is bookkeeping over something already gone. */
  | { kind: "no-host" }
  /** The peer said it was ready. */
  | { kind: "acked"; threadId: string; waitedMs: number; resumed: boolean }
  /** The peer did not say it was ready. NOTHING may be killed on this outcome. */
  | {
      kind: "no-ack";
      threadId: string;
      timeoutMs: number;
      waitedMs: number;
      ackVerdict: string;
      ackThreadId: string | null;
      resumed: boolean;
    };

/**
 * Ask the peer to stand down, and wait.
 *
 * The idempotency rule, which is the part worth reading twice: if the record
 * already carries a `stopRequest`, this RESUMES it — same thread, same clock,
 * no second message, NO SWEEP. Sweeping on a resume would delete the very ack
 * we came back for, which is the exact shape of the stale-ack fix applied
 * backwards. A peer that acked ninety seconds after the first call gave up is
 * answering a question that was asked once, and the retry is what collects it.
 */
async function runCourtesyPhase(
  req: RequestEnvelope,
  ctx: HandlerContext,
  target: { sessionId: string; sessionKey: string; record: PeerRecord },
  args: PeerStopArgs,
): Promise<CourtesyOutcome> {
  const { sessionId, sessionKey, record } = target;

  // Nobody home: no request can be delivered and no ack can arrive. Killing is
  // then pure bookkeeping over a session that is already gone, and making the
  // operator wait 120 s to be told so would be theatre.
  const alive = record.observed.tmuxTarget
    ? await ctx.hostDriver.hasSession(sessionKey).catch(() => false)
    : false;
  if (!alive) return { kind: "no-host" };

  const timeoutMs = args.ackTimeoutMs ?? DEFAULT_STOP_ACK_TIMEOUT_MS;
  const pollMs = args.ackPollMs ?? DEFAULT_STOP_ACK_POLL_MS;
  await mkdir(stopAcks.dir(), { recursive: true });

  const pending = record.observed.stopRequest ?? null;
  const resumed = pending !== null;
  let threadId: string;
  let requestedAtMs: number;

  if (pending) {
    threadId = pending.threadId;
    requestedAtMs = Date.parse(pending.requestedAt);
    if (Number.isNaN(requestedAtMs)) requestedAtMs = Date.now() - timeoutMs;
    await writeEvent({
      event: "peer_stop_request_resumed",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId,
        sessionKey,
        threadId,
        originallyRequestedAt: pending.requestedAt,
        note: "A stop was already pending for this peer. Waiting on the same thread — no second request was written.",
      },
    });
  } else {
    // Clear the ground first. Everything after this point is an answer to THIS
    // request, without anyone having to reason about clocks.
    const swept = await stopAcks.sweepStale(sessionId, "stale");
    if (swept) {
      await writeEvent({
        event: "peer_stop_stale_ack_swept",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { sessionId, movedTo: swept },
      });
    }
    // Taken BEFORE the request is written, so an ack the peer produces the
    // instant it reads the message still counts.
    requestedAtMs = Date.now();
    threadId = stopThreadId(sessionId, requestedAtMs);
    const msgId = await requestStop(sessionId, threadId, args.reason ?? null);
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[sessionId];
      if (rec) {
        rec.observed.status = "stopping";
        rec.observed.stopRequest = {
          threadId,
          msgId,
          requestedAt: new Date(requestedAtMs).toISOString(),
          timeoutMs,
        };
        rec.observed.lastUpdatedAt = new Date().toISOString();
      }
    });
    await writeEvent({
      event: "peer_stop_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, threadId, msgId, timeoutMs },
    });
  }

  const startedWaitingAt = Date.now();
  const verdict = await stopAcks.poll(
    sessionId,
    startedWaitingAt + timeoutMs,
    pollMs,
    requestedAtMs,
    threadId,
  );
  const waitedMs = Date.now() - startedWaitingAt;
  if (!verdict.accepted) {
    return {
      kind: "no-ack",
      threadId,
      timeoutMs,
      waitedMs,
      ackVerdict: verdict.reason,
      ackThreadId: verdict.ackThreadId ?? null,
      resumed,
    };
  }
  await stopAcks.consume(sessionId);
  return { kind: "acked", threadId, waitedMs, resumed };
}

export async function handlePeerStop(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = PeerStopArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf(req, ctx));
  if (resolved.kind === "ambiguous") {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { peer: args.peer, reason: "ambiguous_peer", candidates: resolved.candidates },
    });
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
    await writeEvent({
      event: "peer_stop_rejected",
      level: "info",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { peer: args.peer, reason: "peer_not_found" },
    });
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
    // Race: peer disappeared between findPeer and now. Treat as success.
    return okResult(req.id, req.tool, { sessionId, alreadyGone: true });
  }
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;
  const forceFlag = args.force === true;

  // ---------------------------------------------------------------------
  // The courtesy phase.
  // ---------------------------------------------------------------------
  //
  // Three ways out, and only one of them kills anything:
  //   acked   → the peer put its work down; proceed to kill, stoppedCleanly:true
  //   no host → there is nobody to ask; proceed to kill, stoppedCleanly:null
  //   timeout → RETURN. Nothing killed, nothing lost, state says a stop is
  //             pending and a retry resumes the same request.
  let courtesy: CourtesyOutcome = { kind: "skipped" };
  if (!forceFlag && !args.skipCourtesy) {
    courtesy = await runCourtesyPhase(req, ctx, { sessionId, sessionKey, record }, args);
    if (courtesy.kind === "no-ack") {
      // The honest verdict, and the whole reason the graceful path is worth
      // having: a stop that did not happen must not read like one that did.
      await writeEvent({
        event: "stop_ack_timeout",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          sessionId,
          sessionKey,
          threadId: courtesy.threadId,
          timeoutMs: courtesy.timeoutMs,
          waitedMs: courtesy.waitedMs,
          ackVerdict: courtesy.ackVerdict,
          ackThreadId: courtesy.ackThreadId,
          resumed: courtesy.resumed,
        },
      });
      // WHY there was no usable ack, not just that there wasn't one — the same
      // distinction `peer_compact` learned to draw. "Nobody answered" and "an
      // ack was there and it was not yours" call for different next steps.
      const why =
        courtesy.ackVerdict === "wrong_thread"
          ? `an ack exists but answers thread '${courtesy.ackThreadId}', not '${courtesy.threadId}' — another stop is running on this peer`
          : courtesy.ackVerdict === "too_old"
            ? "an ack exists but predates this request — it answers something else"
            : `the peer did not ack within ${courtesy.timeoutMs}ms`;
      return errResult(
        req.id,
        req.tool,
        "stop_ack_timeout",
        `Peer '${sessionId}' is STILL RUNNING and nothing was killed: ${why}. The request stands — call peer_stop again to keep waiting on the same thread (a late ack still counts), or peer_stop with force:true to end the session now and lose whatever the peer had not written down.`,
        {
          sessionId,
          sessionKey,
          stopped: false,
          processLeftRunning: true,
          threadId: courtesy.threadId,
          waitedMs: courtesy.waitedMs,
          ackVerdict: courtesy.ackVerdict,
          retryIsIdempotent: true,
        },
      );
    }
  }

  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[sessionId];
    if (rec) {
      rec.observed.status = "stopping";
      rec.observed.lastUpdatedAt = new Date().toISOString();
    }
  });

  try {
    await ctx.hostDriver.kill(sessionKey, { force: forceFlag });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Special case: driver's verify caught a respawn (bg-pty-host class).
    // Leave state.peers as `stopping` — an operator has to intervene
    // manually. Emit the loudest event we have.
    if (msg.includes("respawn")) {
      await writeEvent({
        event: "peer_stop_respawn_detected",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { sessionId, sessionKey, err: msg },
      });
      return errResult(req.id, req.tool, "supervisor_respawn", msg, { sessionId, sessionKey });
    }
    await writeEvent({
      event: "peer_stop_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, err: msg },
    });
    return errResult(req.id, req.tool, "host_kill_failed", msg, { sessionId, sessionKey });
  }

  const keepInState = args.keepInState;
  // MEASURED beats DECLARED.
  //
  // When this handler ran the courtesy phase itself, it knows whether an ack
  // arrived and the caller's opinion is not consulted. Only a forced stop —
  // where the politeness happened somewhere else, or not at all — falls back to
  // what the caller says it observed.
  const measuredCleanly =
    courtesy.kind === "acked" ? true : courtesy.kind === "no-host" ? null : undefined;
  const stoppedCleanly = keepInState
    ? (measuredCleanly ?? args.stoppedCleanly ?? null)
    : (measuredCleanly ?? undefined);
  await applyStateChange(ctx.state, (draft) => {
    if (keepInState) {
      const rec = draft.peers[sessionId];
      if (rec) {
        rec.observed.status = "stopped";
        rec.observed.stoppedCleanly = stoppedCleanly ?? null;
        rec.observed.pid = null;
        // The stop resolved: the pending request is history, not state. Leaving
        // it would make the next call resume a thread that is already answered.
        rec.observed.stopRequest = null;
        rec.observed.lastUpdatedAt = new Date().toISOString();
      }
    } else {
      delete draft.peers[sessionId];
    }
  });
  // HOW it was stopped, in one word, so a reader of the audit log never has to
  // infer it from a combination of flags.
  const mode =
    courtesy.kind === "acked"
      ? "graceful"
      : courtesy.kind === "no-host"
        ? "already-gone"
        : "forced";
  const ackWaitedMs = courtesy.kind === "acked" ? courtesy.waitedMs : null;
  const threadId = courtesy.kind === "acked" ? courtesy.threadId : null;
  const details = {
    sessionId,
    sessionKey,
    reason: args.reason ?? null,
    force: forceFlag,
    keepInState,
    stoppedCleanly,
    mode,
    ackWaitedMs,
    threadId,
  };
  await writeEvent({
    event: "peer_stopped",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details,
  });
  await publishLifecycleEvent({
    event: "peer_stopped",
    sessionId,
    sessionKey,
    details: { reason: args.reason ?? null, force: forceFlag, keepInState, stoppedCleanly, mode },
  });
  return okResult(req.id, req.tool, {
    sessionId,
    sessionKey,
    stopped: true,
    mode,
    force: forceFlag,
    keepInState,
    stoppedCleanly,
    ackWaitedMs,
    threadId,
  });
}

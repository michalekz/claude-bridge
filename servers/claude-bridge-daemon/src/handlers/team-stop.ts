import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { teamsDir } from "@claude-bridge/shared";
import { z } from "zod";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { bridgeIdOf } from "./peer-identity.ts";
import { type OrderResult, orderCoordinatorLast } from "./peer-order.ts";
import { handlePeerStop } from "./peer-stop.ts";
import { requestStop, stopAcks } from "./stop-protocol.ts";

/**
 * team_stop — controlled sleep of an entire team (§9 zadání, v0.10.1).
 *
 * Not a mass-kill: per-peer STOP REQUEST protocol.
 *   1. bridge inbox `kind: "stop-request"` — peer flushes anchor + memory,
 *      then touches ~/.claude-bridge/control/stop-ack/<sessionId>.json
 *   2. daemon polls the ack file with `anchorTimeoutMs`
 *      (default 120 s = 4× compact-ack; peer has more to do)
 *   3. ack → peer_stop(keepInState:true, stoppedCleanly:true)
 *      timeout && force:false → SKIP (peer keeps running, event stop_ack_timeout)
 *      timeout && force:true  → peer_stop(keepInState:true, stoppedCleanly:false, force:true)
 *      dead peer (no host)    → peer_stop(keepInState:true, stoppedCleanly:null)
 *
 * Ordering: `role: "velitel"` wins over position; otherwise array order,
 * velitel LAST by convention.
 *
 * State post-stop: PeerRecord kept with status:"stopped" so team_layout apply
 * can resume via the same sessionId later.
 */

const DEFAULT_ANCHOR_TIMEOUT_MS = 120_000;
const DEFAULT_ACK_POLL_MS = 500;
const STOP_ACK_FILENAME_EXTENSION = ".json";

const PeerOrderableSchema = z.object({
  sessionId: z.string().min(1),
  displayName: z.string().min(1),
  role: z.string().optional(),
});

const TeamStopFileSchema = z.object({
  team: z.string().min(1),
  peers: z.array(PeerOrderableSchema).min(1),
});

export const TeamStopArgsSchema = z
  .object({
    team: z.string().min(1),
    force: z.boolean().default(false),
    anchorTimeoutMs: z.number().int().positive().max(600_000).optional(),
    ackPollMs: z.number().int().positive().max(10_000).optional(),
    dryRun: z.boolean().default(false),
    inline: TeamStopFileSchema.optional(),
  })
  .strict();

export type TeamStopArgs = z.infer<typeof TeamStopArgsSchema>;

function teamFilePath(team: string): string {
  return join(teamsDir(), `${team}.json`);
}

async function loadTeamOrder(team: string): Promise<z.infer<typeof TeamStopFileSchema> | null> {
  try {
    const raw = await readFile(teamFilePath(team), "utf-8");
    const json = JSON.parse(raw);
    const parsed = TeamStopFileSchema.safeParse(json);
    if (!parsed.success) throw new Error(`Team spec parse failed: ${parsed.error.message}`);
    return parsed.data;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw e;
  }
}

/*
 * The delivery half of this protocol used to live here, privately, and it did
 * not work.
 *
 * `writeStopRequestMsg` hand-built an envelope and wrote it with a raw
 * `atomicWriteJson`. Measured against the message schema on 2026-08-08 — both
 * the shared one and the MCP server's own copy — it failed in five places:
 * `from` and `to` were objects where strings are required, `ts` stood where
 * `sentAt` belongs, `content` was an object, and `kind` was "stop-request",
 * which is not in the enum. The reader `safeParse`s, so the file landed in
 * `pending/` and `listPending` never returned it: no push, no piggyback, no
 * error anywhere.
 *
 * The identical defect had already cost `peer_compact` two days and three wrong
 * hypotheses. This copy never got the fix, because nobody went looking for who
 * ELSE built their own envelope. Nobody noticed here either: the graceful
 * branch has no `stop-ack/` directory and no `peer_stop_requested` event on the
 * live host, ever. It was never run.
 *
 * The protocol now lives in `stop-protocol.ts` and `ack-protocol.ts`, shared
 * with `peer_stop` and `peer_compact`. What stays here is POLICY — who is asked
 * first, what a timeout means for a team, when force applies — because that is
 * the part that genuinely differs between stopping one peer and stopping eight.
 */

interface StopOutcome {
  sessionId: string;
  displayName: string;
  outcome: "cleanly" | "forced" | "dead" | "skipped" | "failed";
  err?: string;
}

async function stopSinglePeer(
  req: RequestEnvelope,
  ctx: HandlerContext,
  peer: { sessionId: string; displayName: string; role?: string | undefined },
  args: TeamStopArgs,
  threadId: string,
  anchorTimeoutMs: number,
  ackPollMs: number,
): Promise<StopOutcome> {
  const record = ctx.state.peers[peer.sessionId];
  if (!record) {
    return { sessionId: peer.sessionId, displayName: peer.displayName, outcome: "dead" };
  }
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;
  const alive = record.observed.tmuxTarget ? await ctx.hostDriver.hasSession(sessionKey) : false;
  if (!alive) {
    const stopReq = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:stop:${peer.sessionId}`,
      ts: req.ts,
      tool: "peer_stop",
      args: {
        peer: peer.sessionId,
        reason: `team_stop:${args.team}:dead`,
        // PINNED (v0.11.15 phase 1): no courtesy, no force. The peer has no host
        // session, so there is nobody to ask and nothing to hurry — this call is
        // bookkeeping. `force:false` keeps the driver's full verify budget.
        skipCourtesy: true,
        force: false,
        keepInState: true,
        stoppedCleanly: null,
      },
      requestedBy: req.requestedBy,
    };
    const res = await handlePeerStop(stopReq, ctx);
    if (res.outcome === "error") {
      return {
        sessionId: peer.sessionId,
        displayName: peer.displayName,
        outcome: "failed",
        err: res.error?.message,
      };
    }
    await writeEvent({
      event: "peer_stopped_dead",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: peer.sessionId, sessionKey, team: args.team, threadId },
    });
    return { sessionId: peer.sessionId, displayName: peer.displayName, outcome: "dead" };
  }
  await mkdir(stopAcks.dir(), { recursive: true });
  // Clear the ground before asking, so every ack that appears afterwards is
  // fresh by construction rather than by comparison (the v0.11.3 lesson, which
  // this handler's private copy never received).
  // `peer` here is the team spec entry, not the record — and the record is the
  // one that knows the bridge address.
  const bridgeId = bridgeIdOf(record);
  const swept = await stopAcks.sweepStale(bridgeId, "stale");
  if (swept) {
    await writeEvent({
      event: "peer_stop_stale_ack_swept",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: peer.sessionId, team: args.team, movedTo: swept },
    });
  }
  // Taken BEFORE the request is written, so an ack the peer produces the instant
  // it reads the message still counts.
  const requestedAtMs = Date.now();
  let stopReqMsgId: string;
  try {
    stopReqMsgId = await requestStop(bridgeId, threadId, args.force ? "force:true" : null);
  } catch (e) {
    return {
      sessionId: peer.sessionId,
      displayName: peer.displayName,
      outcome: "failed",
      err: e instanceof Error ? e.message : String(e),
    };
  }
  await writeEvent({
    event: "peer_stop_requested",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      sessionId: peer.sessionId,
      sessionKey,
      team: args.team,
      threadId,
      stopReqMsgId,
      timeoutMs: anchorTimeoutMs,
    },
  });
  const deadline = Date.now() + anchorTimeoutMs;
  const verdict = await stopAcks.poll(bridgeId, deadline, ackPollMs, requestedAtMs, threadId);
  const acked = verdict.accepted;
  if (!acked && !args.force) {
    await writeEvent({
      event: "stop_ack_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: peer.sessionId,
        sessionKey,
        team: args.team,
        threadId,
        timeoutMs: anchorTimeoutMs,
        // WHY there was no usable ack. "Nobody answered" and "an ack was there
        // and it answered something else" call for different next steps.
        ackVerdict: verdict.reason,
        ackThreadId: verdict.ackThreadId ?? null,
        ackWrittenAt: verdict.writtenAt ?? null,
      },
    });
    return { sessionId: peer.sessionId, displayName: peer.displayName, outcome: "skipped" };
  }
  if (acked) {
    await stopAcks.consume(bridgeId);
  }
  const stopReq = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:stop:${peer.sessionId}`,
    ts: req.ts,
    tool: "peer_stop",
    args: {
      peer: peer.sessionId,
      reason: `team_stop:${args.team}:${acked ? "cleanly" : "forced"}`,
      // PINNED (v0.11.15 phase 1): the courtesy happened a floor up, in THIS
      // function. Without the pin `peer_stop` would ask a second time and wait
      // out another full window on a peer that has already acked.
      skipCourtesy: true,
      // Unchanged from v0.11.14: an acked peer gets the full verify budget, a
      // peer that never answered gets the short one.
      force: !acked,
      keepInState: true,
      stoppedCleanly: acked,
    },
    requestedBy: req.requestedBy,
  };
  const res = await handlePeerStop(stopReq, ctx);
  if (res.outcome === "error") {
    return {
      sessionId: peer.sessionId,
      displayName: peer.displayName,
      outcome: "failed",
      err: res.error?.message,
    };
  }
  await writeEvent({
    event: acked ? "peer_stopped_cleanly" : "peer_stopped_forced",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId: peer.sessionId, sessionKey, team: args.team, threadId },
  });
  await publishLifecycleEvent({
    event: acked ? "peer_stopped_cleanly" : "peer_stopped_forced",
    sessionId: peer.sessionId,
    sessionKey,
    details: { team: args.team, threadId },
  });
  return {
    sessionId: peer.sessionId,
    displayName: peer.displayName,
    outcome: acked ? "cleanly" : "forced",
  };
}

/**
 * Velitel last — one shared rule with `team_restart` since v0.11.13.
 *
 * This used to filter on `p.role === "velitel"` against records that carried no
 * `role` at all, so unless a caller passed one the filter matched nothing and
 * the order came back untouched. The rule was documented, dead, and nobody knew.
 */
function orderPeersForStop<T extends { role?: string | undefined; displayName?: string }>(
  peers: T[],
): OrderResult<T> {
  return orderCoordinatorLast(peers, (p) => ({ role: p.role, name: p.displayName ?? null }));
}

export async function handleTeamStop(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = TeamStopArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  let spec: z.infer<typeof TeamStopFileSchema> | null;
  try {
    spec = args.inline ?? (await loadTeamOrder(args.team));
  } catch (e) {
    return errResult(
      req.id,
      req.tool,
      "team_spec_read_failed",
      e instanceof Error ? e.message : String(e),
      { team: args.team },
    );
  }
  if (!spec) {
    return errResult(
      req.id,
      req.tool,
      "team_spec_missing",
      `No team file at ${teamFilePath(args.team)}`,
      { team: args.team },
    );
  }

  const stopOrder = orderPeersForStop(spec.peers);
  const ordered = stopOrder.ordered;
  const anchorTimeoutMs = args.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
  const ackPollMs = args.ackPollMs ?? DEFAULT_ACK_POLL_MS;
  const threadId = `team-stop:${spec.team}:${Date.now().toString(36)}`;

  if (args.dryRun) {
    return okResult(req.id, req.tool, {
      mode: "dryRun",
      team: spec.team,
      order: ordered.map((p) => ({
        sessionId: p.sessionId,
        displayName: p.displayName,
        role: p.role ?? null,
      })),
      // Who was put last, and on whose authority — a name match is a guess and an
      // operator reading this plan needs to see the difference before trusting it.
      coordinators: stopOrder.coordinators,
      coordinatorInferredFromName: stopOrder.inferred,
      anchorTimeoutMs,
      force: args.force,
    });
  }

  await writeEvent({
    event: "team_stop_started",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      team: spec.team,
      threadId,
      order: ordered.map((p) => p.sessionId),
      anchorTimeoutMs,
      force: args.force,
    },
  });

  const outcomes: StopOutcome[] = [];
  for (const peer of ordered) {
    const outcome = await stopSinglePeer(
      req,
      ctx,
      peer,
      args,
      threadId,
      anchorTimeoutMs,
      ackPollMs,
    );
    outcomes.push(outcome);
  }

  const summary = {
    team: spec.team,
    threadId,
    stoppedCleanly: outcomes.filter((o) => o.outcome === "cleanly").map((o) => o.sessionId),
    stoppedForced: outcomes.filter((o) => o.outcome === "forced").map((o) => o.sessionId),
    stoppedDead: outcomes.filter((o) => o.outcome === "dead").map((o) => o.sessionId),
    skipped: outcomes.filter((o) => o.outcome === "skipped").map((o) => o.sessionId),
    failedKill: outcomes
      .filter((o) => o.outcome === "failed")
      .map((o) => ({ sessionId: o.sessionId, err: o.err ?? "unknown" })),
  };

  await writeEvent({
    event: "team_stop_completed",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: summary,
  });

  return okResult(req.id, req.tool, summary);
}

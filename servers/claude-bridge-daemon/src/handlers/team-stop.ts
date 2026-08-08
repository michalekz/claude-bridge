import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { teamsDir } from "@claude-bridge/shared";
import { z } from "zod";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { type OrderResult, orderCoordinatorLast } from "./peer-order.ts";
import { handlePeerStop } from "./peer-stop.ts";

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
  /** Registry key — renamed from `sessionId` in R3 (v0.11.21). See team_layout. */
  handle: z.string().min(1),
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
  handle: string;
  displayName: string;
  outcome: "cleanly" | "forced" | "dead" | "skipped" | "failed";
  err?: string;
}

/**
 * Stop ONE member — by calling the primitive, and nothing else.
 *
 * 🔴 v0.11.19: seventy lines went out of here. This function held a private copy
 * of the ask/wait/consume cycle — `stopAcks.sweepStale`, `requestStop`,
 * `stopAcks.poll`, `stopAcks.consume` — and then called `peer_stop` with the
 * courtesy pinned OFF to do the killing. That was correct in v0.10.1, when it
 * was the ONLY implementation of the protocol. Since v0.11.15 `peer_stop` does
 * the whole cycle itself, so the copy stopped being history and became
 * duplication: two places to fix, and the owner's first principle is that we do
 * not debug the same thing twice.
 *
 * It also proved the point while it existed. The private copy never received the
 * v0.11.3 stale-ack fix, never received the `writeEnvelope` fix (five schema
 * mismatches, so its request was undeliverable and its graceful branch never ran
 * once), and needed the v0.11.18 bridge-address fix applied to it separately.
 * Three fixes, one of them for two days, none of which it would have needed.
 *
 * WHAT STAYS IS POLICY, and it is genuinely different for a team: who is asked
 * first, what a refusal means for the run, and — the one shape the primitive
 * does not have — `force` here means "ask, and kill anyway if nobody answers",
 * while `peer_stop force` means "do not ask at all". So the escalation is two
 * calls to the primitive rather than a flag inside it: ask; if the answer is a
 * timeout and the operator said force, force it. Nothing about the protocol is
 * reimplemented to do that.
 */
async function stopSinglePeer(
  req: RequestEnvelope,
  ctx: HandlerContext,
  peer: { handle: string; displayName: string; role?: string | undefined },
  args: TeamStopArgs,
  threadId: string,
  anchorTimeoutMs: number,
  ackPollMs: number,
): Promise<StopOutcome> {
  const record = ctx.state.peers[peer.handle];
  if (!record) {
    return { handle: peer.handle, displayName: peer.displayName, outcome: "dead" };
  }
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;

  const callStop = async (force: boolean, label: string) =>
    handlePeerStop(
      {
        schemaVersion: req.schemaVersion,
        id: `${req.id}:stop:${peer.handle}${force ? ":force" : ""}`,
        ts: req.ts,
        tool: "peer_stop",
        args: {
          peer: peer.handle,
          reason: `team_stop:${args.team}:${label}`,
          force,
          // The team keeps its members as tombstones so `team_layout apply` can
          // resume the same session ids later.
          keepInState: true,
          ...(force ? {} : { ackTimeoutMs: anchorTimeoutMs, ackPollMs }),
        },
        requestedBy: req.requestedBy,
      },
      ctx,
    );

  // ASK. The primitive decides everything the protocol decides: whether there is
  // anyone to ask, how long to wait, whether a late ack counts.
  let res = await callStop(false, "graceful");
  let escalated = false;

  if (res.outcome === "error") {
    if (res.error?.code !== "stop_ack_timeout") {
      return {
        handle: peer.handle,
        displayName: peer.displayName,
        outcome: "failed",
        err: res.error?.message,
      };
    }
    // Nobody answered. Without `force` this is where a team stop STOPS for this
    // member: the peer keeps running and is reported, not killed.
    if (!args.force) {
      await writeEvent({
        event: "stop_ack_timeout",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle: peer.handle,
          sessionKey,
          team: args.team,
          threadId,
          timeoutMs: anchorTimeoutMs,
          note: "peer left running — pass force:true to end it anyway",
        },
      });
      return { handle: peer.handle, displayName: peer.displayName, outcome: "skipped" };
    }
    // `force` on a TEAM means "ask, then kill anyway". The asking already
    // happened, above; this second call is the killing.
    escalated = true;
    res = await callStop(true, "forced");
    if (res.outcome === "error") {
      return {
        handle: peer.handle,
        displayName: peer.displayName,
        outcome: "failed",
        err: res.error?.message,
      };
    }
  }

  // The primitive MEASURED what happened; this reads it rather than deciding it.
  const mode = (res.data as { mode?: string } | undefined)?.mode ?? null;
  const outcome: StopOutcome["outcome"] =
    mode === "already-gone" ? "dead" : escalated || mode === "forced" ? "forced" : "cleanly";

  const event =
    outcome === "dead"
      ? "peer_stopped_dead"
      : outcome === "cleanly"
        ? "peer_stopped_cleanly"
        : "peer_stopped_forced";
  await writeEvent({
    event,
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      sessionId: peer.handle,
      sessionKey,
      team: args.team,
      threadId,
      mode,
      // The primitive's own thread, so a reader can follow the ask across both
      // audit trails instead of guessing which run this belonged to.
      stopThreadId: (res.data as { threadId?: string | null } | undefined)?.threadId ?? null,
      ackWaitedMs: (res.data as { ackWaitedMs?: number | null } | undefined)?.ackWaitedMs ?? null,
    },
  });
  if (outcome !== "dead") {
    await publishLifecycleEvent({
      event: outcome === "cleanly" ? "peer_stopped_cleanly" : "peer_stopped_forced",
      handle: peer.handle,
      sessionKey,
      details: { team: args.team, threadId },
    });
  }
  return { handle: peer.handle, displayName: peer.displayName, outcome };
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
        handle: p.handle,
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
      order: ordered.map((p) => p.handle),
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
    stoppedCleanly: outcomes.filter((o) => o.outcome === "cleanly").map((o) => o.handle),
    stoppedForced: outcomes.filter((o) => o.outcome === "forced").map((o) => o.handle),
    stoppedDead: outcomes.filter((o) => o.outcome === "dead").map((o) => o.handle),
    skipped: outcomes.filter((o) => o.outcome === "skipped").map((o) => o.handle),
    failedKill: outcomes
      .filter((o) => o.outcome === "failed")
      .map((o) => ({ sessionId: o.handle, err: o.err ?? "unknown" })),
  };

  await writeEvent({
    event: "team_stop_completed",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: summary,
  });

  return okResult(req.id, req.tool, summary);
}

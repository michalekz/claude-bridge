import { z } from "zod";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { PeerRecord } from "../state.ts";
import type { HandlerContext } from "./context.ts";
import { type OrderResult, orderCoordinatorLast } from "./peer-order.ts";
import {
  type PeerRefCandidate,
  ambiguousPeerMessage,
  resolvePeerRef,
  teamOfSession,
} from "./peer-ref.ts";
import { handlePeerRestart } from "./peer-restart.ts";

/**
 * team_restart — restart a team one peer at a time, stopping at the first
 * failure.
 *
 * Built to roll a new plugin bundle across the fleet: a peer picks up the
 * updated bundle from the plugin cache when its process restarts, so a rolling
 * restart is the deployment. Twenty-three peers, one command.
 *
 * Which is exactly why the defaults are cautious. This is the tool with the
 * widest blast radius in the daemon, and it is built on machinery that only
 * became honest today — `peer_restart` spent this morning reporting starts it
 * had not performed, and window targets were only separated from session
 * targets this afternoon. A rolling restart on top of that, run against a live
 * fleet, is how one wrong assumption becomes twenty-three stopped peers.
 *
 * So:
 *
 *   - `dryRun` defaults to TRUE. The plan lists the order and the launch
 *     parameters each peer would be relaunched with, so the operator can see
 *     that they exist BEFORE anything stops.
 *   - **Stops at the first failure.** `continueOnError` exists but defaults to
 *     false: if peer one comes back wrong, peers two through twenty-three are
 *     still running and the fleet is half-safe rather than wholly broken.
 *   - Peers with no recorded `command` are refused up front, not discovered
 *     halfway through. Those relaunch as a bare `claude`, which resolves to
 *     nothing under nvm — the failure this release already fixed once, and it
 *     must not be rediscovered peer by peer.
 *
 * Ordering is the array order of `peers`, or state order for a whole team,
 * with any peer whose `role` is velitel deliberately LAST — the same
 * convention `team_stop` uses, so the coordinator is the last to go down and
 * the first to see the others return.
 */

const DEFAULT_SETTLE_MS = 3_000;

export const TeamRestartArgsSchema = z
  .object({
    peers: z.array(z.string().min(1)).optional(),
    team: z.string().min(1).optional(),
    reason: z.string().optional(),
    /**
     * Milliseconds to wait after each peer before starting the next. Gives the
     * relaunched process time to come up so a rolling restart does not become a
     * simultaneous one.
     */
    settleMs: z.number().int().min(0).max(120_000).default(DEFAULT_SETTLE_MS),
    /**
     * Restart every member without asking (v0.11.18).
     *
     * A pass-through to the primitive, not a second mechanism: `peer_restart`
     * decides what force means, and this only carries the word. Same rule
     * applies to every member — force skips WAITING (the ready-ack, the stop
     * courtesy) and never EVIDENCE (the pane archive, the identity check after
     * the relaunch, and the message telling each peer its anchor may be
     * half-written).
     *
     * `settleMs` is NOT skipped. The gap between peers is not a courtesy — it
     * is what stops a rolling restart from becoming a simultaneous one.
     */
    force: z.boolean().default(false),
    /** Keep going after a peer fails to restart. Off, deliberately. */
    continueOnError: z.boolean().default(false),
    dryRun: z.boolean().default(true),
  })
  .strict()
  .refine((a) => (a.peers === undefined) !== (a.team === undefined), {
    message: "pass exactly one of `peers` or `team`",
  });

export type TeamRestartArgs = z.infer<typeof TeamRestartArgsSchema>;

interface RestartOutcome {
  handle: string;
  name: string;
  outcome: "restarted" | "failed" | "skipped";
  pidBefore: number | null;
  pidAfter: number | null;
  error?: string;
}

/**
 * Velitel last — the coordinator goes down after the peers it coordinates.
 *
 * Shared with `team_stop` since v0.11.13. It used to be written here as a
 * substring match and there as a lookup of a field the registry did not have,
 * so both tools documented the same rule and only one of them followed it.
 */
function orderPeers(records: PeerRecord[]): OrderResult<PeerRecord> {
  return orderCoordinatorLast(records, (r) => ({
    role: r.desired.role,
    name: r.observed.name,
  }));
}

/**
 * SPACING, not a poll (R5, v0.11.20). The gap between peers is not waiting for
 * anything observable — it is what keeps a rolling restart from becoming a
 * simultaneous one. `settleMs` defaults to 3000 and is the operator's dial;
 * force does not skip it, because the spacing is the safety, not a courtesy.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The team of whoever sent this request — the search domain for short names. */
function callerTeamOf(req: RequestEnvelope, ctx: HandlerContext): string | null {
  return teamOfSession(ctx.state.peers, req.requestedBy.sessionId);
}

export async function handleTeamRestart(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = TeamRestartArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;

  let selected: PeerRecord[];
  const notFound: string[] = [];
  const ambiguous: Array<{ ref: string; candidates: PeerRefCandidate[] }> = [];
  if (args.team !== undefined) {
    selected = Object.values(ctx.state.peers).filter((r) => r.desired.team === args.team);
    if (selected.length === 0) {
      return errResult(req.id, req.tool, "team_not_found", `No peers under team '${args.team}'`, {
        team: args.team,
      });
    }
  } else {
    selected = [];
    for (const key of args.peers ?? []) {
      const resolved = resolvePeerRef(ctx.state.peers, key, callerTeamOf(req, ctx));
      if (resolved.kind === "ambiguous") {
        ambiguous.push({ ref: key, candidates: resolved.candidates });
        continue;
      }
      const rec = resolved.kind === "found" ? resolved.record : null;
      if (!rec) {
        notFound.push(key);
        continue;
      }
      if (!selected.some((s) => s.handle === rec.handle)) selected.push(rec);
    }
    if (ambiguous.length > 0) {
      // Same rule as notFound below: refuse the whole run. Guessing which
      // `velitel` the caller meant would be worse than doing nothing.
      return errResult(
        req.id,
        req.tool,
        "ambiguous_peer",
        ambiguous.map((a) => ambiguousPeerMessage(a.ref, a.candidates)).join(" | "),
        { ambiguous },
      );
    }
    if (notFound.length > 0) {
      // Refuse the whole run rather than restart the ones we found. A partial
      // roll-out nobody asked for is worse than none.
      return errResult(
        req.id,
        req.tool,
        "peer_not_found",
        `Not in daemon state: ${notFound.join(", ")} — nothing was restarted`,
        { notFound, known: Object.keys(ctx.state.peers) },
      );
    }
  }

  const ordering = orderPeers(selected);
  const ordered = ordering.ordered;

  // Refuse up front, not halfway through. A peer with no recorded command
  // relaunches as a bare `claude`, which under nvm resolves to nothing.
  const unrestartable = ordered.filter((r) => !r.desired.command);
  if (unrestartable.length > 0) {
    await writeEvent({
      event: "team_restart_refused",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { missingLaunchParams: unrestartable.map((r) => r.handle) },
    });
    return errResult(
      req.id,
      req.tool,
      "launch_params_missing",
      `${unrestartable.length} of ${ordered.length} peers have no recorded command and would relaunch as a bare 'claude'. Nothing was restarted.`,
      {
        peers: unrestartable.map((r) => ({ handle: r.handle, name: r.observed.name })),
        hint: "Records written before v0.10.3 lack launch parameters. Re-spawn those peers, or adopt them again with a daemon that reads /proc.",
      },
    );
  }

  const plan = {
    dryRun: args.dryRun,
    reason: args.reason ?? null,
    settleMs: args.settleMs,
    // In the PLAN, because a dry run whose preview omits `force` would show an
    // operator a gentle roll and then perform a forced one.
    force: args.force,
    continueOnError: args.continueOnError,
    order: ordered.map((r) => ({
      handle: r.handle,
      name: r.observed.name,
      tmuxTarget: r.observed.tmuxTarget,
      pid: r.observed.pid,
      command: r.desired.command ?? null,
      cwd: r.desired.cwd ?? null,
    })),
    // Who was put last, and on whose authority — a name match is a guess and an
    // operator reading this plan needs to see the difference before trusting it.
    coordinators: ordering.coordinators,
    coordinatorInferredFromName: ordering.inferred,
  };

  if (args.dryRun) {
    await writeEvent({
      event: "team_restart_preview",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: plan,
    });
    return okResult(req.id, req.tool, plan);
  }

  const results: RestartOutcome[] = [];
  let stoppedEarly = false;

  for (const [i, rec] of ordered.entries()) {
    if (stoppedEarly) {
      results.push({
        handle: rec.handle,
        name: rec.observed.name,
        outcome: "skipped",
        pidBefore: rec.observed.pid,
        pidAfter: null,
      });
      continue;
    }

    const pidBefore = rec.observed.pid;
    const sub = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:restart:${i}`,
      ts: req.ts,
      tool: "peer_restart",
      args: { peer: rec.handle, reason: args.reason ?? "team_restart", force: args.force },
      requestedBy: req.requestedBy,
    };
    const res = await handlePeerRestart(sub, ctx);

    if (res.outcome === "error") {
      results.push({
        handle: rec.handle,
        name: rec.observed.name,
        outcome: "failed",
        pidBefore,
        pidAfter: null,
        error: res.error?.message ?? "peer_restart failed",
      });
      if (!args.continueOnError) stoppedEarly = true;
      continue;
    }

    results.push({
      handle: rec.handle,
      name: rec.observed.name,
      outcome: "restarted",
      pidBefore,
      pidAfter: ctx.state.peers[rec.handle]?.observed.pid ?? null,
    });

    // Let it come up before taking the next one down. Skipped after the last
    // peer — nothing follows it, and a trailing wait is just a slower answer.
    if (args.settleMs > 0 && i < ordered.length - 1) await sleep(args.settleMs);
  }

  const restarted = results.filter((r) => r.outcome === "restarted");
  const failed = results.filter((r) => r.outcome === "failed");
  const skipped = results.filter((r) => r.outcome === "skipped");

  await writeEvent({
    event: "team_restarted",
    level: failed.length > 0 ? "error" : "info",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      team: args.team ?? null,
      total: ordered.length,
      restarted: restarted.length,
      failed: failed.length,
      skipped: skipped.length,
      stoppedEarly,
      results,
    },
  });

  const summary = {
    dryRun: false,
    total: ordered.length,
    restarted: restarted.map((r) => r.handle),
    failed: failed.map((r) => ({ handle: r.handle, error: r.error })),
    // Named, not merely absent from the success list: an operator has to know
    // which peers were never touched so they can finish the roll-out.
    skipped: skipped.map((r) => r.handle),
    stoppedEarly,
    results,
  };

  // A partial roll is a failure of the request even though some peers came
  // back. Reporting `ok` would leave the caller believing the fleet is done.
  if (failed.length > 0) {
    return errResult(
      req.id,
      req.tool,
      "team_restart_incomplete",
      `${failed.length} peer(s) failed to restart${stoppedEarly ? `, ${skipped.length} never attempted` : ""} — see results`,
      summary,
    );
  }

  return okResult(req.id, req.tool, summary);
}

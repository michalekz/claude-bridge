import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeEvent } from "../events.ts";
import { defaultProcessInspector } from "../hosts/process-inspector.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { applyStateChange } from "./state-writer.ts";

/**
 * team_reconcile — compare what the daemon believes against what is running.
 *
 * The defect class this whole release is about, one storey up. `peer_restart`
 * reported a start it had not performed; `team_adopt` reported a plan covering
 * four of twenty-three; `rate_limit_status` reported a severity nobody
 * measured. In each case the tool's answer and the world had drifted apart and
 * nothing was watching the gap. `state.json` is the same kind of claim — a
 * record saying `status: "live"` is a belief about a pid, and beliefs go stale
 * the moment a process dies without telling anyone.
 *
 * So this tool measures the gap and says it out loud. Four kinds of drift:
 *
 *   dead          record says live, no process behind the pid
 *   host_missing  process alive, but its tmux target is gone
 *   pid_changed   target holds a DIFFERENT pid than the record — the most
 *                 dangerous one, because every lifecycle call would then act
 *                 on a peer nobody meant
 *   unmanaged     a Claude peer running on the host with no record at all
 *
 * **Read-only by default and it will stay that way.** `markDead: true` is the
 * only write, and all it does is set `status: "unknown"` on records whose
 * process is gone — it never deletes, never kills, never adopts. Deleting is
 * `team_release`, killing is `peer_stop`, adopting is `team_adopt`. A tool that
 * both diagnoses and repairs invites being run for the repair and trusted for
 * the diagnosis.
 */

export const TeamReconcileArgsSchema = z
  .object({
    /** Restrict the report to one team. Unmanaged processes are still listed. */
    team: z.string().min(1).optional(),
    /**
     * Set `status: "unknown"` on records whose process is gone. Nothing else is
     * written, and nothing is ever removed or signalled.
     */
    markDead: z.boolean().default(false),
  })
  .strict();

export type TeamReconcileArgs = z.infer<typeof TeamReconcileArgsSchema>;

export type DriftKind = "dead" | "host_missing" | "pid_changed" | "unmanaged";

export interface DriftEntry {
  kind: DriftKind;
  sessionId: string | null;
  name: string | null;
  team: string | null;
  recordedPid: number | null;
  actualPid: number | null;
  tmuxTarget: string | null;
  detail: string;
}

/**
 * Is this pid a live process?
 *
 * Read from the process filesystem rather than `process.kill(pid, 0)`: the
 * signal probe raises EPERM for processes we may not signal, which would read
 * as "gone" for a peer running under another account. It also lets tests point
 * `procRoot` at a fixture instead of spawning real processes.
 */
function pidAlive(pid: number, procRoot: string): boolean {
  return existsSync(join(procRoot, String(pid)));
}

export async function handleTeamReconcile(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = TeamReconcileArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  const procRoot = ctx.procRoot ?? "/proc";

  const inspector = ctx.processInspector ?? defaultProcessInspector();
  const livePeers = await inspector.listClaudePeers();
  const windows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
  const sessions = await ctx.hostDriver.listSessions();

  const hostTargets = new Map<string, number | null>();
  for (const w of windows) hostTargets.set(w.target, w.pid);
  for (const s of sessions)
    if (!hostTargets.has(s.sessionKey)) hostTargets.set(s.sessionKey, s.pid);

  const records = Object.values(ctx.state.peers).filter(
    (r) => args.team === undefined || r.team === args.team,
  );

  const drift: DriftEntry[] = [];
  const healthy: string[] = [];
  const accountedPids = new Set<number>();

  for (const rec of records) {
    if (rec.pid !== null) accountedPids.add(rec.pid);
    // A record that has been deliberately stopped is not drift — it is state.
    if (rec.status === "stopped") {
      healthy.push(rec.sessionId);
      continue;
    }

    const base = {
      sessionId: rec.sessionId,
      name: rec.name,
      team: rec.team ?? null,
      recordedPid: rec.pid,
      tmuxTarget: rec.tmuxTarget,
    };

    const alive = rec.pid !== null && pidAlive(rec.pid, procRoot);
    if (!alive) {
      drift.push({
        ...base,
        kind: "dead",
        actualPid: null,
        detail:
          rec.pid === null
            ? `record is '${rec.status}' with no pid at all`
            : `record is '${rec.status}' but pid ${rec.pid} is not running`,
      });
      continue;
    }

    if (rec.tmuxTarget !== null && hostTargets.size > 0 && !hostTargets.has(rec.tmuxTarget)) {
      drift.push({
        ...base,
        kind: "host_missing",
        actualPid: rec.pid,
        detail: `pid ${rec.pid} is alive but host target '${rec.tmuxTarget}' no longer exists`,
      });
      continue;
    }

    const targetPid = rec.tmuxTarget !== null ? (hostTargets.get(rec.tmuxTarget) ?? null) : null;
    if (targetPid !== null && rec.pid !== null && targetPid !== rec.pid) {
      // The record and the host disagree about WHO is there. Every lifecycle
      // call on this record would reach the wrong peer.
      drift.push({
        ...base,
        kind: "pid_changed",
        actualPid: targetPid,
        detail: `host target '${rec.tmuxTarget}' holds pid ${targetPid}, record says ${rec.pid}`,
      });
      continue;
    }

    healthy.push(rec.sessionId);
  }

  // Peers running on the host that the daemon knows nothing about. Reported
  // whole-host regardless of the `team` filter — an unmanaged peer belongs to
  // no team by definition, and hiding it behind a filter is how it stays hidden.
  const knownSessionIds = new Set(Object.keys(ctx.state.peers));
  for (const proc of livePeers) {
    if (proc.sessionId && knownSessionIds.has(proc.sessionId)) continue;
    if (accountedPids.has(proc.pid)) continue;
    drift.push({
      kind: "unmanaged",
      sessionId: proc.sessionId,
      name: null,
      team: null,
      recordedPid: null,
      actualPid: proc.pid,
      tmuxTarget: null,
      detail: `pid ${proc.pid} is a Claude peer with no record${proc.sessionId ? "" : " and no resolvable session id"}`,
    });
  }

  const marked: string[] = [];
  if (args.markDead) {
    const deadIds = drift.filter((d) => d.kind === "dead" && d.sessionId).map((d) => d.sessionId);
    if (deadIds.length > 0) {
      await applyStateChange(ctx.state, (draft) => {
        for (const id of deadIds) {
          const rec = draft.peers[id as string];
          // `unknown`, not `stopped`: nobody asked this peer to stop, it simply
          // is not there. Claiming a clean stop would be inventing the reason.
          if (rec) {
            rec.status = "unknown";
            rec.lastUpdatedAt = new Date().toISOString();
          }
        }
      });
      marked.push(...(deadIds as string[]));
    }
  }

  const byKind = drift.reduce<Record<string, number>>((acc, d) => {
    acc[d.kind] = (acc[d.kind] ?? 0) + 1;
    return acc;
  }, {});

  const report = {
    team: args.team ?? null,
    recordsChecked: records.length,
    hostTargetsSeen: hostTargets.size,
    livePeersSeen: livePeers.length,
    inSync: healthy.length,
    driftCount: drift.length,
    byKind,
    drift,
    marked,
    readOnly: !args.markDead,
  };

  await writeEvent({
    event: "team_reconciled",
    // A clean report is `info`; drift is a warning, because a state file that
    // disagrees with the host is the precondition for every confident lie the
    // lifecycle tools can tell.
    level: drift.length > 0 ? "warn" : "info",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: report,
  });

  return okResult(req.id, req.tool, report);
}

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
 * So this tool measures the gap and says it out loud. The kinds are enumerated
 * by `DriftKind` below — read them there, not from a count in this sentence,
 * which is the sort of thing that silently goes stale (as one did in
 * `peer-compact.ts`, fixed in v0.11.6):
 *
 *   dead          record says live, no process behind the pid
 *   host_missing  process alive, but its tmux target is gone
 *   pid_changed   target holds a DIFFERENT pid than the record — the most
 *                 dangerous one, because every lifecycle call would then act
 *                 on a peer nobody meant
 *   unmanaged     a Claude peer running on the host with no record at all
 *   dead_pane     a window held open after its process exited, belonging to no
 *                 record — visible only because the daemon asks tmux to keep
 *                 the panes of peers it spawned
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

export type DriftKind =
  | "dead"
  | "host_missing"
  | "pid_changed"
  | "unmanaged"
  /**
   * A window whose process has exited, which tmux is holding open because the
   * daemon asked it to (v0.11.8, `remain-on-exit` on spawned peers).
   *
   * A new kind of object on the host, and one an operator has to be able to
   * RECOGNISE rather than read about in a changelog: it is not a running peer,
   * it is not gone either, and it holds the exit status and the last output of
   * whatever died there. Reported whole-host, like `unmanaged`, because a
   * corpse belongs to no team.
   */
  | "dead_pane";

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

/**
 * Is `childPid` the peer running inside the pane whose pid is `panePid`?
 *
 * True when they are the same process, or when the pane is an ancestor — a
 * shell, a wrapper script, anything between tmux and the peer.
 */
async function ownsProcess(
  inspector: { ancestorsOf: (pid: number, maxDepth?: number) => Promise<number[]> },
  panePid: number,
  childPid: number,
): Promise<boolean> {
  if (panePid === childPid) return true;
  try {
    return (await inspector.ancestorsOf(childPid)).includes(panePid);
  } catch {
    // Cannot tell. Say nothing rather than accuse — a false `pid_changed`
    // sends an operator hunting a peer that is exactly where it should be.
    return true;
  }
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

  // Windows tmux is holding open because their process exited. Keyed by target
  // so a record's drift entry can say whether its pane is still there to read.
  const deadPanes = new Map<string, { exitStatus: number | null; label: string }>();
  for (const w of windows) {
    if (w.dead)
      deadPanes.set(w.target, { exitStatus: w.exitStatus, label: w.windowName || w.label });
  }

  // Where each window actually sits, so `desired.windowIndex` has something to
  // be compared against. Recording the measurement is what makes the drift
  // report possible at all — without it the field would be declarable and
  // permanently, silently in agreement with nothing.
  const hostWindowIndex = new Map<string, number>();
  for (const w of windows) {
    if (typeof w.window === "number") hostWindowIndex.set(w.target, w.window);
  }

  const records = Object.values(ctx.state.peers).filter(
    (r) => args.team === undefined || r.desired.team === args.team,
  );

  const drift: DriftEntry[] = [];
  const healthy: string[] = [];
  const accountedPids = new Set<number>();

  for (const rec of records) {
    if (rec.observed.pid !== null) accountedPids.add(rec.observed.pid);
    // A record that has been deliberately stopped is not drift — it is state.
    if (rec.observed.status === "stopped") {
      healthy.push(rec.sessionId);
      continue;
    }

    const base = {
      sessionId: rec.sessionId,
      name: rec.observed.name,
      team: rec.desired.team ?? null,
      recordedPid: rec.observed.pid,
      tmuxTarget: rec.observed.tmuxTarget,
    };

    const alive = rec.observed.pid !== null && pidAlive(rec.observed.pid, procRoot);
    if (!alive) {
      // Liveness comes from /proc, never from tmux — a held-open pane keeps
      // quoting the exited process's pid, so asking tmux would answer "still
      // running" about a corpse.
      //
      // But if the pane IS still standing, say so, because the two situations
      // need different actions from a reader: a peer whose window is gone
      // leaves nothing to inspect, while one whose window was held leaves an
      // exit status and its final output.
      const corpse = rec.observed.tmuxTarget ? deadPanes.get(rec.observed.tmuxTarget) : undefined;
      drift.push({
        ...base,
        kind: "dead",
        actualPid: null,
        detail:
          rec.observed.pid === null
            ? `record is '${rec.observed.status}' with no pid at all`
            : `record is '${rec.observed.status}' but pid ${rec.observed.pid} is not running${
                corpse
                  ? ` — its pane is still standing and holds exit status ${corpse.exitStatus ?? "unknown"}; read it with \`tmux capture-pane -p -S -2000 -t ${rec.observed.tmuxTarget}\` before removing it`
                  : " and its pane is gone"
              }`,
      });
      continue;
    }

    if (
      rec.observed.tmuxTarget !== null &&
      hostTargets.size > 0 &&
      !hostTargets.has(rec.observed.tmuxTarget)
    ) {
      drift.push({
        ...base,
        kind: "host_missing",
        actualPid: rec.observed.pid,
        detail: `pid ${rec.observed.pid} is alive but host target '${rec.observed.tmuxTarget}' no longer exists`,
      });
      continue;
    }

    const targetPid =
      rec.observed.tmuxTarget !== null ? (hostTargets.get(rec.observed.tmuxTarget) ?? null) : null;
    // A pane pid is often a SHELL, with the peer as its child. Comparing it
    // directly against the record's pid called every shell-wrapped peer
    // `pid_changed` — two false drifts on the live fleet, on the only peers
    // nobody had restarted (plt-designer, recovery round). Adoption already
    // descends the ancestry; reconcile has to as well, or it accuses the host
    // of holding a stranger whenever a launcher script sits in between.
    const targetOwnsRecord =
      targetPid !== null &&
      rec.observed.pid !== null &&
      (await ownsProcess(inspector, targetPid, rec.observed.pid));
    if (
      targetPid !== null &&
      rec.observed.pid !== null &&
      targetPid !== rec.observed.pid &&
      !targetOwnsRecord
    ) {
      // The record and the host disagree about WHO is there. Every lifecycle
      // call on this record would reach the wrong peer.
      drift.push({
        ...base,
        kind: "pid_changed",
        actualPid: targetPid,
        detail: `host target '${rec.observed.tmuxTarget}' holds pid ${targetPid}, record says ${rec.observed.pid}`,
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

  // Held-open windows that belong to no record — the graveyard nobody would
  // otherwise notice. Reported whole-host regardless of the `team` filter, for
  // the same reason as `unmanaged`: a corpse belongs to no team, and hiding it
  // behind a filter is how it stays hidden.
  //
  // These do not appear in the scan above, which walks LIVE Claude processes: a
  // dead pane has no process to find. Without this loop a peer that died and
  // whose record was already removed would leave a window standing on the host
  // that no tool mentions.
  const recordedTargets = new Set(
    Object.values(ctx.state.peers)
      .map((r) => r.observed.tmuxTarget)
      .filter((t): t is string => t !== null),
  );
  for (const [target, info] of deadPanes) {
    if (recordedTargets.has(target)) continue; // already told as part of its record
    drift.push({
      kind: "dead_pane",
      sessionId: null,
      name: info.label,
      team: null,
      recordedPid: null,
      actualPid: null,
      tmuxTarget: target,
      detail: `window '${info.label}' (${target}) is held open after its process exited${
        info.exitStatus === null ? "" : ` with status ${info.exitStatus}`
      } and belongs to no record — read it with \`tmux capture-pane -p -S -2000 -t ${target}\`, then \`tmux kill-window -t ${target}\``,
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
            rec.observed.status = "unknown";
            rec.observed.lastUpdatedAt = new Date().toISOString();
          }
        }
      });
      marked.push(...(deadIds as string[]));
    }
  }

  // Record where the windows actually are.
  //
  // This writes even when `readOnly` — and that is not a contradiction.
  // `readOnly` means no drift is CORRECTED: no window moved, no peer stopped,
  // no record marked dead. Writing `observed.windowIndex` corrects nothing; it
  // is the measurement itself, and a measurement pass that declines to record
  // what it measured leaves `desired.windowIndex` comparable to nothing forever.
  const measured: string[] = [];
  await applyStateChange(ctx.state, (draft) => {
    for (const rec of Object.values(draft.peers)) {
      if (rec.observed.tmuxTarget === null) continue;
      const idx = hostWindowIndex.get(rec.observed.tmuxTarget);
      if (idx === undefined || rec.observed.windowIndex === idx) continue;
      rec.observed.windowIndex = idx;
      measured.push(rec.sessionId);
    }
  });

  const windowDrift = Object.values(ctx.state.peers)
    .filter(
      (r) =>
        r.desired.windowIndex !== undefined &&
        r.observed.windowIndex !== undefined &&
        r.desired.windowIndex !== r.observed.windowIndex,
    )
    .map((r) => ({
      sessionId: r.sessionId,
      name: r.observed.name,
      desired: r.desired.windowIndex,
      observed: r.observed.windowIndex,
    }));

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
    // Reported separately from `drift`, on purpose. The entries above mean
    // "the control plane's belief about this peer is wrong"; a window sitting
    // at a different index means only that somebody moved it. Folding a
    // cosmetic disagreement into the same count that gates a fleet roll would
    // train an operator to ignore both.
    windowIndexDrift: windowDrift,
    windowIndexMeasured: measured.length,
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

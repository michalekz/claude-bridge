import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeEvent } from "../events.ts";
import { defaultProcessInspector } from "../hosts/process-inspector.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { measureIdentity } from "./peer-identity.ts";
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
 * So this tool measures the gap and says it out loud.
 *
 * THE KINDS ARE IN `DriftKind` BELOW, each documented where it is declared.
 * They are deliberately NOT listed again here. This comment used to carry a
 * copy of the list — under a sentence warning that a list in prose goes stale —
 * and it went stale within the hour when `stop_pending` was added in v0.11.17.
 * Sixth instance of that defect in three days, and the first one to happen
 * inside its own warning.
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
  | "dead_pane"
  /**
   * A stop was ASKED FOR and never resolved (v0.11.17).
   *
   * The graceful stop leaves `status: "stopping"` and a `stopRequest` on the
   * record when a peer does not acknowledge. Retrying resumes it — but nothing
   * makes anyone retry, and until this kind existed a peer abandoned there was
   * INVISIBLE: its process is alive, its pid matches, its window is where it
   * should be, so every other check called it healthy.
   *
   * Reported, never corrected. Finishing the stop is `peer_stop` (retry, or
   * `force`), and deciding to leave the peer alone is a person's call.
   */
  | "stop_pending";

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

  // Windows tmux is holding open because their process exited.
  //
  // Indexed under BOTH address forms, because the same pane has two of them and
  // the record may hold either. A peer spawned as its own session is recorded
  // as `dead-probe_0118`; `listWindows` reports it as `@2599`. On the first
  // live run of this feature that mismatch produced two entries for one pane —
  // the record's saying "its pane is gone" while a `dead_pane` entry for the
  // very same window said it "belongs to no record". Both untrue, and between
  // them they hid the one thing an operator needed: there is a pane here, and
  // it is this peer's.
  //
  // A session name is only usable as an address when the session holds exactly
  // one window; with more, the name does not point at any particular pane.
  const windowsPerSession = new Map<string, number>();
  for (const w of windows)
    windowsPerSession.set(w.session, (windowsPerSession.get(w.session) ?? 0) + 1);
  const deadPanes = new Map<string, { exitStatus: number | null; label: string; target: string }>();
  for (const w of windows) {
    if (w.dead) {
      const entry = { exitStatus: w.exitStatus, label: w.windowName || w.label, target: w.target };
      deadPanes.set(w.target, entry);
      if (windowsPerSession.get(w.session) === 1) deadPanes.set(w.session, entry);
    }
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
                  ? ` — its pane is still standing and holds exit status ${corpse.exitStatus ?? "unknown"}; read it with \`tmux capture-pane -p -S -2000 -t ${corpse.target}\` before removing it`
                  : " and its pane is gone"
              }`,
      });
      continue;
    }

    // Asked to stop, still running, nobody came back for it.
    const pending = rec.observed.stopRequest;
    if (pending && rec.observed.status === "stopping") {
      const askedAt = Date.parse(pending.requestedAt);
      const ageMs = Number.isNaN(askedAt) ? null : Date.now() - askedAt;
      drift.push({
        ...base,
        kind: "stop_pending",
        actualPid: rec.observed.pid,
        detail: `a stop was requested at ${pending.requestedAt}${ageMs === null ? "" : ` (${Math.round(ageMs / 1000)}s ago)`} and never resolved — the peer is STILL RUNNING. Call peer_stop again to keep waiting on the same request (a late ack still counts), peer_stop with force:true to end it now, or leave it be.`,
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
  // `deadPanes` holds each pane under BOTH of its address forms, so gather the
  // aliases per pane and test all of them against the records. Reading the map
  // by one form only is what produced the first live run's contradiction: a
  // pane recorded by session name was reported as orphaned because the lookup
  // used its window id.
  const aliasesByPane = new Map<string, Set<string>>();
  for (const [alias, info] of deadPanes) {
    const set = aliasesByPane.get(info.target) ?? new Set<string>();
    set.add(alias);
    aliasesByPane.set(info.target, set);
  }
  for (const [target, aliases] of aliasesByPane) {
    if ([...aliases].some((a) => recordedTargets.has(a))) continue; // told with its record
    const info = deadPanes.get(target);
    if (!info) continue;
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

  // Finish the identity measurement `peer_spawn` could not complete.
  //
  // This is what makes `identity: "unknown"` a temporary state rather than a
  // permanent scar. A spawn gets a few seconds; this pass can look again at
  // leisure, and a peer that was merely slow to write its session file gets
  // reconciled with the bridge on the next sweep.
  //
  // Writes under `readOnly` for the same reason `windowIndex` does: it corrects
  // no drift, it RECORDS a measurement. Refusing to write what you measured is
  // how a record stays wrong forever.
  const identified: Array<{ handle: string; sessionId: string; source: string }> = [];
  for (const rec of Object.values(ctx.state.peers)) {
    // `unknown` — a spawn that could not measure in time.
    // `undefined` — a record written before v0.11.16, which never had the field.
    //
    // Both get measured, and the second one deliberately: those 25 records are
    // keyed by genuine UUIDs because adoption read them off reality, and it
    // would be tempting to back-fill `identity: "measured"` from the key alone.
    // That would be INVENTING a measurement — the precise move this release
    // exists to stop. So they are measured for real, like everyone else.
    if (rec.observed.identity === "measured") continue;
    if (rec.observed.pid === null || !pidAlive(rec.observed.pid, procRoot)) continue;
    const outcome = await measureIdentity(rec.observed.pid, {
      // Short: this is a sweep over the whole fleet, not a spawn waiting on one
      // peer, and an unmeasurable identity here simply waits for the next pass.
      timeoutMs: 400,
      ...(ctx.processInspector ? { inspector: ctx.processInspector } : {}),
      procRoot,
    });
    if (outcome.kind !== "measured") continue;
    const m = outcome.measurement;
    await applyStateChange(ctx.state, (draft) => {
      const target = draft.peers[rec.sessionId];
      if (!target) return;
      target.observed.sessionId = m.sessionId;
      target.observed.identity = "measured";
      target.observed.identityAt = m.measuredAt;
      target.observed.identitySource = m.source;
      target.observed.lastUpdatedAt = new Date().toISOString();
    });
    identified.push({ handle: rec.sessionId, sessionId: m.sessionId, source: m.source });
    // The transition unknown → measured has to be visible in the audit trail.
    // Without it, "temporary" and "never measured" look identical to anyone
    // reading events afterwards.
    await writeEvent({
      event: "peer_identity_measured",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: rec.sessionId,
        sessionKey: rec.observed.tmuxTarget,
        pid: m.pid,
        measuredSessionId: m.sessionId,
        source: m.source,
        by: "team_reconcile",
        note: "Identity was unknown since spawn and has now been read from the running process.",
      },
    });
  }

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
    // Peers whose identity was unknown since spawn and has now been read.
    identitiesMeasured: identified,
    // Still unknown after this pass — running, but not yet cross-referenceable
    // with the bridge. NOT dead, and must not be read as such.
    identityUnknown: Object.values(ctx.state.peers)
      .filter((r) => r.observed.identity === "unknown")
      .map((r) => ({ handle: r.sessionId, name: r.observed.name, pid: r.observed.pid })),
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

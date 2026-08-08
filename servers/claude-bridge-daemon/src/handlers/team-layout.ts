import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, controlDir, teamsDir } from "@claude-bridge/shared";
import { z } from "zod";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { bridgeIdOf } from "./peer-identity.ts";
import { handlePeerSpawn } from "./peer-spawn.ts";
import { handlePeerStop } from "./peer-stop.ts";
import { applyStateChange } from "./state-writer.ts";
import { type WakeOutcome, wakePeer } from "./wake.ts";

/**
 * team_layout — declarative team spec reconciled against `state.peers`.
 *
 * Team file: `~/.claude-bridge/control/teams/<team>.json`
 *   {
 *     "team": "hmh",
 *     "peers": [
 *       { "sessionId": "…", "displayName": "plt-keeper",
 *         "cwd": "/opt/hmh", "command": "claude", "args": [],
 *         "model": null, "resume": true }
 *     ]
 *   }
 *
 * Modes:
 *   - `apply` (default) — spawn every peer in the spec that isn't
 *     currently live. Extras (in state.peers, not in spec) are left
 *     alone.
 *   - `prune: true` — also stop the extras. Default safe = keep them.
 *
 * Every reconcile emits `team_layout_applied` with the full diff for
 * the audit trail.
 */

const PeerSpecSchema = z.object({
  /**
   * The registry key for this peer — renamed from `sessionId` in R3
   * (v0.11.21). BREAKING, deliberately and without an alias.
   *
   * A layout names peers that do not exist yet, so this string cannot be a
   * session id: only a booted peer can mint one. Calling it `sessionId` is what
   * made `team_layout` hand the key to `--resume` (fixed v0.11.18) and address
   * a wake to a directory nobody drains (fixed here) — both times because the
   * field's NAME said it was an identity.
   */
  handle: z.string().min(1),
  displayName: z.string().min(1),
  cwd: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  resume: z.boolean().default(false),
  model: z.string().nullable().optional(),
  accountProfile: z.string().nullable().optional(),
  extraAllowEnv: z.array(z.string()).default([]),
  extraEnv: z.record(z.string()).default({}),
});

const TeamFileSchema = z.object({
  team: z.string().min(1),
  peers: z.array(PeerSpecSchema),
});

export type PeerSpec = z.infer<typeof PeerSpecSchema>;
export type TeamFile = z.infer<typeof TeamFileSchema>;

export const TeamLayoutArgsSchema = z
  .object({
    team: z.string().min(1),
    /**
     * Execute the plan. DEFAULT FALSE since R3 (v0.11.21) — BREAKING.
     *
     * This was the one bulk tool that acted unless told not to, while
     * `team_restart`, `team_adopt` and `team_stop` all preview first. The
     * asymmetry is not a preference: a mistyped team name here SPAWNS PEERS,
     * and the operator finds out afterwards. Four calls exist in the whole
     * history of the daemon (measured from `events.jsonl` 2026-08-08), all
     * ours, so the cost of the change is a flag and the cost of leaving it is
     * one bad afternoon.
     *
     * `apply: false` reports exactly what `apply: true` would do.
     */
    apply: z.boolean().default(false),
    prune: z.boolean().default(false),
    /**
     * Prune WITHOUT asking (v0.11.17). Default false: a peer dropped from a
     * layout gets the same courtesy as one told to sleep.
     *
     * v0.11.15 pinned prune to the impolite path with a TODO, because it was
     * impolite only for want of an alternative — `peer_stop` had no other mode.
     * Now it does. A peer being removed from a spec has as much unwritten work
     * as any other, so it is asked first, and a peer that does not answer is
     * REPORTED rather than killed. `pruneForce: true` is the old behaviour and
     * now has to be said.
     */
    pruneForce: z.boolean().default(false),
    /** How long a pruned peer gets to acknowledge before it is reported as refused. */
    pruneAckTimeoutMs: z.number().int().positive().max(600_000).optional(),
    /**
     * Explicit team spec — bypasses the on-disk file. Used by tests
     * and by future callers who want to preview a spec before writing
     * it to teams/.
     */
    inline: TeamFileSchema.optional(),
    /**
     * Wake peers that were resumed from `status:"stopped"` (v0.10.1).
     *
     * On by default: a resumed session is silent until something triggers a
     * turn, so skipping the wake gives you a team that is running but deaf.
     * Turn it off only when you intend to drive the peers by hand.
     */
    wake: z.boolean().default(true),
    /** Override the post-spawn settle delay before key injection. */
    wakeDelayMs: z.number().int().min(0).max(120_000).optional(),
  })
  .strict();

export type TeamLayoutArgs = z.infer<typeof TeamLayoutArgsSchema>;

function teamFilePath(team: string): string {
  return join(teamsDir(), `${team}.json`);
}

async function loadTeamSpec(team: string): Promise<TeamFile | null> {
  try {
    const raw = await readFile(teamFilePath(team), "utf-8");
    const parsed = TeamFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`Team spec parse failed: ${parsed.error.message}`);
    return parsed.data;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw e;
  }
}

export async function handleTeamLayout(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = TeamLayoutArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  let spec: TeamFile | null;
  try {
    spec = args.inline ?? (await loadTeamSpec(args.team));
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
      {
        team: args.team,
      },
    );
  }

  const specIds = new Set(spec.peers.map((p) => p.handle));
  const stateIds = new Set(Object.keys(ctx.state.peers));
  /**
   * Peers put to sleep by `team_stop` keep their record with
   * `status:"stopped"` so the same sessionId can be resumed later. They are in
   * `state.peers`, so the original `!stateIds.has(...)` filter treated them as
   * already-running and silently refused to bring the team back — breaking the
   * exact stop→start round trip the tombstone exists for (audit 2026-08-03).
   */
  const stoppedIds = new Set(
    Object.entries(ctx.state.peers)
      .filter(([, rec]) => rec.observed.status === "stopped")
      .map(([id]) => id),
  );
  const runningIds = new Set([...stateIds].filter((id) => !stoppedIds.has(id)));

  const toSpawn = spec.peers.filter((p) => !stateIds.has(p.handle));
  const toResume = spec.peers.filter((p) => stoppedIds.has(p.handle));
  // Only RUNNING extras are stop candidates — a tombstone has nothing to kill.
  const runningExtras = [...runningIds].filter((id) => !specIds.has(id));
  const toStop = args.prune ? runningExtras : [];
  // Tombstones outside the spec are pure garbage: nothing to stop, nothing to
  // resume. Without this they accumulate forever (~350 B each, re-serialized
  // on every state write, and they survive daemon restarts).
  const toForget = args.prune ? [...stoppedIds].filter((id) => !specIds.has(id)) : [];

  const diff = {
    team: spec.team,
    plannedSpawn: toSpawn.map((p) => p.handle),
    plannedResume: toResume.map((p) => p.handle),
    plannedStop: toStop,
    plannedForget: toForget,
    keptExtras: args.prune ? [] : runningExtras,
  };
  await writeEvent({
    event: "team_layout_reconciling",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { ...diff, apply: args.apply, prune: args.prune },
  });

  if (!args.apply) {
    return okResult(req.id, req.tool, { mode: "plan", diff });
  }

  /** Shared by the spawn and resume paths — same tool, different intent. */
  const spawnOne = async (p: PeerSpec, forceResume: boolean, label: string) => {
    const record = ctx.state.peers[p.handle];
    const spawnReq = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:${label}:${p.handle}`,
      ts: req.ts,
      tool: "peer_spawn",
      args: {
        handle: p.handle,
        displayName: p.displayName,
        cwd: p.cwd,
        command: p.command,
        args: p.args,
        // Resuming a tombstone MUST pass `--resume <sessionId>`, otherwise the
        // peer comes back as a blank session and its transcript is orphaned.
        resume: forceResume || p.resume,
        // 🔴 WHICH transcript (v0.11.19) — and this is the tool where it matters
        // most, because this is the tool that MAKES handle-keyed peers.
        //
        // The spec names a peer before it exists, so `p.handle` is a handle.
        // Passing it to `--resume` was the v0.11.18 defect one tool over: a
        // handle matches no transcript, so Claude Code drops into its Resume
        // picker, the peer wedges at a prompt with a brand-new identity, and the
        // record is orphaned behind a pid that still matches.
        //
        // The identity survives the tombstone: `peer_stop keepInState` clears
        // status and pid, and leaves `observed.sessionId` and `identity`
        // untouched. So a resume can ask the record who it actually is.
        ...(record?.observed.identity === "measured" && record.observed.sessionId
          ? { resumeSessionId: record.observed.sessionId }
          : {}),
        // Fall back to what the peer was last running with, so a stop→start
        // round trip does not silently downgrade the model.
        model: p.model ?? record?.desired.model ?? record?.observed.model ?? null,
        accountProfile: p.accountProfile ?? record?.desired.accountProfile ?? null,
        extraAllowEnv: p.extraAllowEnv,
        extraEnv: p.extraEnv,
        // So the window gets the short label while the record keeps the full name.
        team: spec.team,
      },
      requestedBy: req.requestedBy,
    };
    return handlePeerSpawn(spawnReq, ctx);
  };

  /** Stamp team ownership so `team_stop` can iterate a team from state alone. */
  const stampTeam = async (sessionId: string) => {
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[sessionId];
      if (rec) rec.desired.team = spec.team;
    });
  };

  const spawnedOk: string[] = [];
  const spawnedFailed: Array<{ handle: string; err: string }> = [];
  for (const p of toSpawn) {
    const res = await spawnOne(p, false, "spawn");
    if (res.outcome === "ok") {
      await stampTeam(p.handle);
      spawnedOk.push(p.handle);
    } else {
      spawnedFailed.push({ handle: p.handle, err: res.error?.message ?? "unknown" });
    }
  }

  const resumedOk: string[] = [];
  const resumedFailed: Array<{ handle: string; err: string }> = [];
  const wakeOutcomes: WakeOutcome[] = [];
  for (const p of toResume) {
    // Capture the tombstone's stop quality BEFORE peer_spawn overwrites the
    // record — a forced stop means the peer never flushed its anchor, and the
    // wake message has to say so.
    const stoppedCleanly = ctx.state.peers[p.handle]?.observed.stoppedCleanly ?? null;
    const res = await spawnOne(p, true, "resume");
    if (res.outcome !== "ok") {
      resumedFailed.push({ handle: p.handle, err: res.error?.message ?? "unknown" });
      continue;
    }
    await stampTeam(p.handle);
    resumedOk.push(p.handle);
    if (!args.wake) continue;
    const data = res.data as { sessionKey?: string } | undefined;
    const rec = ctx.state.peers[p.handle];
    const outcome = await wakePeer(req, ctx, {
      // The BRIDGE address. `team_layout` is the tool that MAKES handle-keyed
      // records, so it is the caller for which the handle and the bridge id
      // most often differ — and whose wake was therefore the least likely to
      // arrive. The fallback covers a record that vanished mid-run only.
      bridgeId: rec ? bridgeIdOf(rec) : p.handle,
      sessionKey: data?.sessionKey ?? p.displayName,
      reason: `team_layout_resume:${spec.team}`,
      stoppedCleanly,
      ...(args.wakeDelayMs !== undefined ? { wakeDelayMs: args.wakeDelayMs } : {}),
    });
    wakeOutcomes.push(outcome);
  }

  const stoppedOk: string[] = [];
  const stoppedFailed: Array<{ handle: string; err: string }> = [];
  /** Asked, still running, still recorded. Not an error — an unfinished ask. */
  const stoppedRefused: Array<{ handle: string; detail: string }> = [];
  const forgotten: string[] = [];
  if (args.prune) {
    for (const id of toStop) {
      const stopReq = {
        schemaVersion: req.schemaVersion,
        id: `${req.id}:stop:${id}`,
        ts: req.ts,
        tool: "peer_stop",
        args: {
          peer: id,
          reason: `team_layout_prune:${spec.team}`,
          // The v0.11.15 TODO, resolved (v0.11.17).
          //
          // That pin was `skipCourtesy: true` with a note saying the decision
          // was not obvious and belonged to a later phase. It is resolved the
          // other way: prune ASKS. A peer removed from a layout has as much
          // unwritten work as one told to sleep, and prune was impolite only
          // because `peer_stop` had no other mode when this was written.
          //
          // A peer that does not answer is left running and reported — pruning
          // is reconciliation, and reconciliation that destroys unsaved work to
          // make a list come true has the priority backwards.
          ...(args.pruneForce ? { force: true } : {}),
          ...(args.pruneAckTimeoutMs !== undefined ? { ackTimeoutMs: args.pruneAckTimeoutMs } : {}),
        },
        requestedBy: req.requestedBy,
      };
      const res = await handlePeerStop(stopReq, ctx);
      if (res.outcome === "ok") {
        stoppedOk.push(id);
      } else if (res.error?.code === "stop_ack_timeout") {
        // REFUSED, not failed. The peer is alive and well and simply has not
        // agreed to stop yet. Reported apart from a kill that went wrong,
        // because the two want different things from a reader: this one wants
        // patience or `pruneForce`, the other wants investigating.
        stoppedRefused.push({ handle: id, detail: res.error?.message ?? "no ack" });
      } else {
        stoppedFailed.push({ handle: id, err: res.error?.message ?? "unknown" });
      }
    }
    // Tombstones outside the spec: drop the record outright. There is no host
    // session to kill, so peer_stop would be the wrong instrument.
    for (const id of toForget) {
      await applyStateChange(ctx.state, (draft) => {
        delete draft.peers[id];
      });
      forgotten.push(id);
    }
    if (forgotten.length > 0) {
      await writeEvent({
        event: "team_layout_tombstones_forgotten",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { team: spec.team, forgotten },
      });
    }
  }

  const wokenOk = wakeOutcomes.filter((w) => w.injected).map((w) => w.bridgeId);
  const wokenSilent = wakeOutcomes
    .filter((w) => !w.injected)
    .map((w) => ({ bridgeId: w.bridgeId, err: w.error ?? "not injected" }));

  await writeEvent({
    event: "team_layout_applied",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      team: spec.team,
      spawnedOk,
      spawnedFailed,
      resumedOk,
      resumedFailed,
      wokenOk,
      wokenSilent,
      stoppedOk,
      stoppedRefused,
      stoppedFailed,
      forgotten,
      keptExtras: diff.keptExtras,
    },
  });

  const failed = spawnedFailed.length > 0 || resumedFailed.length > 0 || stoppedFailed.length > 0;
  const result = {
    team: spec.team,
    spawnedOk,
    spawnedFailed,
    resumedOk,
    resumedFailed,
    wokenOk,
    wokenSilent,
    stoppedOk,
    stoppedRefused,
    stoppedFailed,
    forgotten,
    keptExtras: diff.keptExtras,
  };
  if (failed) {
    return errResult(
      req.id,
      req.tool,
      "team_layout_partial_failure",
      "Some peers could not be reconciled — see failed lists",
      result,
    );
  }
  return okResult(req.id, req.tool, result);
}

/** For tests + a future `team_layout write` MCP tool. */
export async function persistTeamSpec(team: string, spec: TeamFile): Promise<void> {
  const dir = teamsDir();
  await atomicWriteJson(join(dir, `${team}.json`), spec);
}

/** Ensure controlDir is used for typechecking (silence bundler). */
void controlDir;

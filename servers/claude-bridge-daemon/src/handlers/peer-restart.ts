import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { writeEvent } from "../events.ts";
import { parseHostTarget } from "../hosts/driver.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { ambiguousPeerMessage, resolvePeerRef } from "./peer-ref.ts";
import { handlePeerSpawn } from "./peer-spawn.ts";
import { handlePeerStop } from "./peer-stop.ts";
import { applyStateChange } from "./state-writer.ts";

/**
 * peer_restart — stop + spawn using the parameters recorded in
 * state.peers (single source of truth for "how was this peer launched").
 *
 * The operator may override model / accountProfile at restart time —
 * `peer_set_model` and account switches are modelled on top of this.
 *
 * Because we serialize requests in the queue (alpha behaviour, kept),
 * we can safely chain stop → spawn inside a single request. If the
 * daemon crashes between them, the operator restarts manually — MVP
 * scope.
 */

export const PeerRestartArgsSchema = z
  .object({
    peer: z.string().min(1),
    reason: z.string().optional(),
    force: z.boolean().default(false),
    model: z.string().optional(),
    accountProfile: z.string().optional(),
  })
  .strict();

export type PeerRestartArgs = z.infer<typeof PeerRestartArgsSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this id something `claude --resume` can actually find?
 *
 * A transcript is named by a UUID. `peer_spawn` also accepts a stable name for
 * a fresh peer, and that name is not a transcript — resuming it lands in the
 * interactive picker instead of failing, which is worse than failing.
 */
export function isResumableSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId);
}

export interface LivenessCheck {
  ok: boolean;
  reason: string;
}

/**
 * Confirm the relaunched process is still alive, and that a resumable peer
 * actually registered a session.
 *
 * Two different failures wear the same face. A process that vanished leaves no
 * pid; a process that is running but never registered leaves a pid and no
 * session file. Both are reported, separately, rather than folded into one
 * vague "did not come up".
 */
export async function confirmStillRunning(
  pid: number | null,
  identity: IdentityCheck,
  expectedSessionId: string,
  opts: { settleMs?: number; procRoot?: string; command?: string } = {},
): Promise<LivenessCheck> {
  if (pid === null) return { ok: false, reason: "no pid was reported by the spawn" };
  const settleMs = opts.settleMs ?? 2_500;
  const procRoot = opts.procRoot ?? "/proc";
  await new Promise((r) => setTimeout(r, settleMs));
  if (!existsSync(join(procRoot, String(pid)))) {
    return { ok: false, reason: `pid ${pid} exited within ${settleMs} ms of starting` };
  }
  // The session file is the proof a peer got as far as being a peer — but only
  // Claude Code writes one. Requiring it from any other command would fail
  // every legitimate relaunch of something else (a shell in the acceptance
  // suite, a wrapper on a host that uses one), so the rule applies to the
  // process that is actually supposed to register.
  const isClaude = (opts.command ?? "").split("/").pop() === "claude";
  if (isClaude && isResumableSessionId(expectedSessionId) && identity.actual === null) {
    return {
      ok: false,
      reason: `pid ${pid} is running but registered no session — ~/.claude/sessions/${pid}.json never appeared`,
    };
  }
  return { ok: true, reason: "alive and registered" };
}

export interface IdentityCheck {
  mismatch: boolean;
  actual: string | null;
}

/**
 * Read back the session id Claude Code registered for the relaunched pid.
 *
 * `~/.claude/sessions/<pid>.json` is written a moment after boot, so this
 * polls briefly. A missing file is NOT treated as a mismatch: on a fresh spawn
 * the id is chosen by Claude Code and there is nothing to compare against, and
 * calling "I could not check" a failure would break restarts that worked.
 */
export async function verifyRestartedIdentity(
  expected: string,
  pid: number | null,
  opts: { attempts?: number; delayMs?: number; homeDir?: string } = {},
): Promise<IdentityCheck> {
  if (pid === null || !isResumableSessionId(expected)) return { mismatch: false, actual: null };
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 500;
  const home = opts.homeDir ?? homedir();
  const path = join(home, ".claude", "sessions", `${pid}.json`);

  for (let i = 0; i < attempts; i++) {
    try {
      const raw = JSON.parse(await readFile(path, "utf-8")) as { sessionId?: unknown };
      const actual = typeof raw.sessionId === "string" ? raw.sessionId : null;
      if (actual) return { mismatch: actual !== expected, actual };
    } catch {
      // Not written yet, or not readable — keep waiting.
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  // Could not read it at all. Silence is not evidence of a mismatch.
  return { mismatch: false, actual: null };
}

/**
 * Mark a record as not-running without deleting it.
 *
 * Used by every failure path AFTER the spawn reported success. `peer_spawn`
 * has by then written a fresh record saying `live` with the new pid — and if
 * the peer did not survive, or came back as somebody else, that record is a
 * lie with a plausible pid attached. Keeping the row is right; keeping its
 * claim is not (plt-designer, 4th pilot round, finding M).
 */
async function markNotRunning(ctx: HandlerContext, sessionId: string): Promise<void> {
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[sessionId];
    if (!rec) return;
    rec.status = "unknown";
    rec.pid = null;
    rec.lastUpdatedAt = new Date().toISOString();
  });
}

/** The team of whoever sent this request — the search domain for short names. */
function callerTeamOf(req: RequestEnvelope, ctx: HandlerContext): string | null {
  return ctx.state.peers[req.requestedBy.sessionId]?.team ?? null;
}

export async function handlePeerRestart(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = PeerRestartArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;

  // Snapshot the record BEFORE stop, since stop removes it.
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
  const record = resolved.kind === "found" ? resolved.record : null;
  if (!record) {
    return errResult(
      req.id,
      req.tool,
      "peer_not_found",
      `No peer with id/name '${args.peer}' in daemon state`,
      { peer: args.peer },
    );
  }

  // Read the peer's home BEFORE stopping it.
  //
  // This lookup used to sit after the stop, by which point the window had
  // already been destroyed — so `inSession` was always null and every adopted
  // peer was relaunched as a session of its own anyway. The v0.10.7 fix was
  // correct and unreachable (plt-designer, re-pilot: @652 in `obetni` came back
  // as a standalone session `w1`). Ask the host while the answer still exists.
  // The record knows its home. Asking the host is only a fallback for records
  // written before homeSession existed — and it fails exactly when it matters
  // most, because a peer whose window already died has no window to ask.
  let inSession: string | null = record.homeSession ?? null;
  if (
    inSession === null &&
    record.tmuxTarget &&
    parseHostTarget(record.tmuxTarget).kind === "window"
  ) {
    const windows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
    inSession = windows.find((w) => w.target === record.tmuxTarget)?.session ?? null;
    if (inSession === null) {
      await writeEvent({
        event: "peer_restart_window_home_unknown",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          sessionId: record.sessionId,
          tmuxTarget: record.tmuxTarget,
          hint: "The window is not on the host, so its parent session cannot be read. The peer will be relaunched as a session of its own.",
        },
      });
    }
  }

  // Provenance the spawn does not know about. `peer_spawn` writes a fresh
  // record, so without carrying these forward a restart silently stripped
  // `team` and `adopted` from every peer it touched — and a fleet roll would
  // have left every team-scoped operation with nothing to match on
  // (plt-designer, v0.10.7 re-pilot, finding H).
  const provenance = {
    ...(record.team !== undefined ? { team: record.team } : {}),
    ...(record.adopted !== undefined ? { adopted: record.adopted } : {}),
    ...(inSession ? { homeSession: inSession } : {}),
    ...(record.spawnEnv ? { spawnEnv: record.spawnEnv } : {}),
  };

  const stopArgs = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:stop`,
    ts: req.ts,
    tool: "peer_stop",
    args: {
      peer: record.sessionId,
      reason: args.reason ?? "peer_restart",
      force: args.force,
    },
    requestedBy: req.requestedBy,
  };
  const stopResult = await handlePeerStop(stopArgs, ctx);
  if (stopResult.outcome === "error") {
    return errResult(
      req.id,
      req.tool,
      "restart_stop_failed",
      stopResult.error?.message ?? "peer_stop failed",
      { stopResult },
    );
  }

  // NOTE: sanitized env pulled from process.env — daemon's own process.
  // Restart intentionally does NOT inherit the caller's env; we're just
  // relaunching the same peer, not adopting the caller's environment.

  // Put the peer back in ITS directory, not the daemon's (fix, 2026-08-04).
  //
  // This passed `process.cwd()` because PeerRecord had no cwd to read. That
  // is the daemon's working directory, so `claude --resume <uuid>` looked
  // for a transcript belonging to a different project, found none, and
  // exited on the spot — tmux then removed the session. The restart still
  // reported success, because the driver asserted `alive` instead of
  // measuring it. Both halves are fixed; this is the one that stops the
  // process from dying in the first place.
  const cwd = record.cwd ?? process.cwd();

  // And launch it the way it was launched. `command` was a hardcoded "claude"
  // until 2026-08-04 — the identical omission to `cwd`, one field over, in the
  // same handler, missed in the same fix. Under nvm the daemon's PATH has no
  // `claude`, so every restart on this fleet respawned a command that did not
  // exist. Found by the pilot of the cwd fix, because the driver now measures
  // `alive` and the failure was finally audible.
  const command = record.command ?? "claude";
  const commandArgs = record.spawnArgs ?? [];

  const missing = [record.cwd ? null : "cwd", record.command ? null : "command"].filter(
    (f): f is string => f !== null,
  );
  if (missing.length > 0) {
    await writeEvent({
      event: "peer_restart_launch_params_unknown",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: record.sessionId,
        missing,
        fallbackCwd: cwd,
        fallbackCommand: command,
        hint: "Peer record predates launch-parameter persistence (v0.10.3). The restart uses the daemon's cwd and a bare `claude`, which fails on installs where claude is not on the daemon's PATH (nvm). Re-spawn the peer to record its real parameters.",
      },
    });
  }

  const spawnArgs = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:spawn`,
    ts: req.ts,
    tool: "peer_spawn",
    args: {
      sessionId: record.sessionId,
      displayName: record.name,
      cwd,
      // The test override stays ahead of the record so the acceptance suite can
      // relaunch something cheaper than a real Claude Code.
      command: process.env["CLAUDE_BRIDGE_TEST_COMMAND"] ?? command,
      args: commandArgs,
      ...(inSession ? { inSession } : {}),
      // The peer's own environment. Without it the relaunch inherits the
      // daemon's PATH and comes up unable to find node.
      ...(record.spawnEnv ? { envBase: record.spawnEnv } : {}),
      // Only resume something that CAN be resumed.
      //
      // This was an unconditional `true`. For a peer spawned under a stable
      // name rather than a UUID — `obetni-w3` — that composes
      // `claude --resume obetni-w3`, which matches no transcript, so Claude
      // Code drops into its interactive Resume picker and sits there. The peer
      // is then wedged at a prompt, gets a brand-new session id, and the record
      // is orphaned: the pid matches, so `team_status` still reads "live".
      // Found by plt-designer in the v0.10.6 pilot; the restart reported `ok`
      // over it, which is this release's own defect wearing a new hat.
      resume: isResumableSessionId(record.sessionId),
      model: args.model ?? record.model ?? null,
      accountProfile: args.accountProfile ?? record.accountProfile ?? null,
      extraAllowEnv: [],
      extraEnv: {},
    },
    requestedBy: req.requestedBy,
  };
  const spawnResult = await handlePeerSpawn(spawnArgs, ctx);
  if (spawnResult.outcome === "error") {
    // Put the record back.
    //
    // `peer_spawn` deletes it when the spawn produces nothing, which is right
    // for a spawn — there was never a peer. For a RESTART there was, and
    // dropping it leaves an operator with nothing to retry: `team_release`
    // answered `team_not_found, knownTeams: []` after a failed restart, and
    // the peer had vanished from the control plane entirely
    // (plt-designer, pre-rollout probe, 2026-08-04).
    //
    // It comes back as `unknown`, not `live`: nothing is running, and this
    // release is about not saying otherwise.
    await applyStateChange(ctx.state, (draft) => {
      draft.peers[record.sessionId] = {
        ...record,
        status: "unknown",
        pid: null,
        lastUpdatedAt: new Date().toISOString(),
      };
    });
    await writeEvent({
      event: "peer_restart_record_retained",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: record.sessionId,
        status: "unknown",
        hint: "The relaunch failed. The record is kept so the peer can be retried or released; nothing is running behind it.",
      },
    });
    return errResult(
      req.id,
      req.tool,
      "restart_spawn_failed",
      spawnResult.error?.message ?? "peer_spawn failed",
      { spawnResult },
    );
  }

  if (Object.keys(provenance).length > 0) {
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[record.sessionId];
      if (rec) Object.assign(rec, provenance);
    });
  }

  // Did the peer come back as ITSELF?
  //
  // A restart can succeed at the level of "a process is running" and still be
  // wrong: if the resume did not take, Claude Code starts a fresh session with
  // a new id, the pid matches the record, and every subsequent report says
  // "live" about a peer whose identity has silently moved. plt-designer hit
  // exactly that in the v0.10.6 pilot. `~/.claude/sessions/<pid>.json` is the
  // cheap check, so there is no excuse for not making it.
  const newPid = (spawnResult.data as { pid?: number | null } | undefined)?.pid ?? null;
  const identity = await verifyRestartedIdentity(record.sessionId, newPid);

  // Is it still there a moment later?
  //
  // `spawn_produced_no_process` catches a command that never started. It does
  // NOT catch one that started and died a second later — a failed resume exits
  // in about two seconds, tmux removes the window, and the identity check finds
  // no session file. "Silence is not a mismatch" was right, but it let that
  // case through as a PASS and the tool answered `restarted: ok` over a corpse
  // (plt-designer, v0.10.7 re-pilot, finding G).
  //
  // Absence of evidence had to stop meaning evidence of absence in BOTH
  // directions: not a mismatch, and not a pass either.
  const liveness = await confirmStillRunning(newPid, identity, record.sessionId, {
    ...(ctx.restartSettleMs !== undefined ? { settleMs: ctx.restartSettleMs } : {}),
    ...(ctx.procRoot ? { procRoot: ctx.procRoot } : {}),
    command,
  });
  if (!liveness.ok) {
    // The spawn wrote a `live` record with the new pid before we learned the
    // peer was gone. Leave it standing and the state file asserts a running
    // peer behind a dead pid.
    await markNotRunning(ctx, record.sessionId);
    await writeEvent({
      event: "peer_restart_died_after_spawn",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: record.sessionId, pid: newPid, reason: liveness.reason },
    });
    return errResult(
      req.id,
      req.tool,
      "restart_died_after_spawn",
      `The relaunched peer did not survive: ${liveness.reason}`,
      { sessionId: record.sessionId, pid: newPid, reason: liveness.reason },
    );
  }

  if (identity.mismatch) {
    // Something IS running, but not the peer this record names. Reporting it as
    // this peer, live, is the worst of the three outcomes: every lifecycle call
    // would then act on a stranger.
    await markNotRunning(ctx, record.sessionId);
    await writeEvent({
      event: "peer_restart_identity_mismatch",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        expected: record.sessionId,
        actual: identity.actual,
        pid: newPid,
        hint: "The peer is running but under a different session id — the record now points at an identity that no longer exists. Adopt the new id or stop the peer; do not trust lifecycle calls on this record.",
      },
    });
    return errResult(
      req.id,
      req.tool,
      "restart_identity_mismatch",
      `Peer restarted as '${identity.actual ?? "unknown"}', not '${record.sessionId}' — the record is now orphaned.`,
      { expected: record.sessionId, actual: identity.actual, pid: newPid },
    );
  }

  await writeEvent({
    event: "peer_restarted",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId: record.sessionId, reason: args.reason ?? null, force: args.force },
  });

  return okResult(req.id, req.tool, {
    sessionId: record.sessionId,
    stop: stopResult.data,
    spawn: spawnResult.data,
  });
}

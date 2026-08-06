import { z } from "zod";
import { harvestEnv, sanitizeEnv } from "../env-whitelist.ts";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { PeerHostDriver, PeerRecord } from "../state.ts";
import type { HandlerContext } from "./context.ts";
import { forkGuard } from "./fork-guard.ts";
import { applyStateChange } from "./state-writer.ts";

/**
 * peer_spawn — start a Claude Code peer inside a supervised session
 * (tmux window in MVP; ConPTY in F3).
 *
 * Contract (see §5.1 zadání):
 *   1. fork-guard — refuse if sessionId is already live in state OR the
 *      host driver still holds the sessionKey
 *   2. compose sanitized env — never inherit `ANTHROPIC_*` / `CLAUDE_*` from
 *      the daemon's own process
 *   3. driver.spawn — tmux new-session (background) with the command
 *   4. record peer in state.peers (status=live), emit `peer_started`
 *      event
 *
 * `resume` semantics (existing sessionId) will attach `--resume <id>`
 * to the args; new sessions leave it off. Alpha stub filled that in
 * conceptually — beta actually issues the CC command.
 */

export const PeerSpawnArgsSchema = z
  .object({
    sessionId: z
      .string()
      .min(1)
      .describe("Peer sessionId (UUID for resume; stable name for a new spawn)"),
    displayName: z
      .string()
      .min(1)
      .describe("Human-visible peer name (also becomes the tmux session name)"),
    cwd: z.string().min(1).describe("Working directory the peer should start in"),
    command: z
      .string()
      .min(1)
      .describe("Absolute path to `claude` (or another executable for tests)"),
    args: z.array(z.string()).default([]),
    resume: z.boolean().default(false),
    /**
     * Create the peer as a window inside this existing tmux session rather than
     * as a session of its own. `peer_restart` sets it for adopted peers, whose
     * home is a window of a shared session.
     */
    inSession: z.string().min(1).optional(),
    /**
     * Values to build the peer's environment from, instead of the daemon's own.
     * Still filtered by the same whitelist — this changes where the values come
     * from, not which names get through.
     */
    envBase: z.record(z.string()).optional(),
    model: z.string().nullable().optional(),
    accountProfile: z
      .string()
      .nullable()
      .optional()
      .describe("Name of the account profile under ~/.claude-bridge/control/accounts/"),
    extraAllowEnv: z
      .array(z.string())
      .default([])
      .describe("Additional env var names to pass through beyond the base whitelist"),
    extraEnv: z
      .record(z.string())
      .default({})
      .describe("Fully-formed env overrides (bypass whitelist for these names)"),
    team: z
      .string()
      .optional()
      .describe(
        "Team this peer belongs to. Also decides the tmux window label: a displayName " +
          "of `mic-tester` in team `mic` labels the window `tester`.",
      ),
  })
  .strict();

export type PeerSpawnArgs = z.infer<typeof PeerSpawnArgsSchema>;

/**
 * The tmux window label for a peer.
 *
 * The window carries the SHORT form and the record carries the full name —
 * that is the naming convention, not a shortening for looks. `mic-tester` in
 * team `mic` is window `tester`, and `velitel` typed inside `mic` resolves back
 * to it.
 *
 * Stripping is done here, at the one call site that names a window, rather than
 * in the driver. A blanket strip in the driver would also shorten a name a
 * caller chose deliberately, and the driver has no way to tell the two apart.
 *
 * Without a team, or with a name that does not carry the team prefix, the name
 * is used whole — a fleet that does not follow the convention keeps what it
 * asked for.
 */
export function windowLabelFor(displayName: string, team?: string): string {
  if (!team) return displayName;
  const prefix = `${team}-`;
  if (!displayName.startsWith(prefix)) return displayName;
  const short = displayName.slice(prefix.length);
  return short.length > 0 ? short : displayName;
}

export async function handlePeerSpawn(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = PeerSpawnArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  // fork-guard uses the raw name; drivers canonicalize internally so the
  // pre-spawn hasSession() probe still matches any existing session that
  // would collide once we canonicalize on spawn.
  const sessionKey = args.displayName;

  const hit = await forkGuard(ctx.state, ctx.hostDriver, {
    sessionId: args.sessionId,
    sessionKey,
  });
  if (hit) {
    await writeEvent({
      event: "peer_spawn_rejected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: args.sessionId, sessionKey, ...hit.details, reason: hit.reason },
    });
    return errResult(
      req.id,
      req.tool,
      "session_already_live",
      `Refusing to spawn — ${hit.reason === "state_live" ? "daemon state" : "host driver"} still holds sessionId '${args.sessionId}'`,
      { sessionId: args.sessionId, ...hit.details },
    );
  }

  const overrides: Record<string, string> = { ...args.extraEnv };
  if (args.accountProfile) {
    // Real profile paths land in F3; the daemon still applies the
    // override so tests can assert on env composition.
    overrides["CLAUDE_CONFIG_DIR"] =
      `${process.env["HOME"] ?? ""}/.claude-bridge/control/accounts/${args.accountProfile}`;
  }
  // Prefer the peer's own values. `process.env` here is the DAEMON's, and
  // under systemd its PATH has no nvm — a relaunch built from it cannot find
  // `node`, so the peer comes up without statusLine, hooks or MCP server.
  const env = sanitizeEnv(args.envBase ?? process.env, {
    extraAllow: args.extraAllowEnv,
    overrides,
  });

  const spawnArgs = [...args.args];
  if (args.resume) {
    spawnArgs.push("--resume", args.sessionId);
  }
  if (args.model) {
    spawnArgs.push("--model", args.model);
  }

  const hostDriverName = ctx.hostDriver.name;
  await applyStateChange(ctx.state, (draft) => {
    draft.peers[args.sessionId] = {
      sessionId: args.sessionId,
      desired: {
        ...(args.team ? { team: args.team } : {}),
        // The short form, stored once rather than recomputed by every caller
        // that paints a window. Until v0.11.0 there was no field for it, so
        // `windowLabelFor` was called at each site and the ones that forgot
        // painted the FQN.
        label: windowLabelFor(args.displayName, args.team),
        // Recorded so peer_restart can put the peer back where it belongs, and
        // launch it the way it was launched, instead of guessing (2026-08-04).
        // `args.args` is the caller's list — NOT spawnArgs, which already has
        // --resume/--model appended and would double them on the next restart.
        cwd: args.cwd,
        command: args.command,
        spawnArgs: args.args,
        // Where this peer belongs, so a later restart does not have to ask a
        // window that may no longer exist.
        ...(args.inSession ? { homeSession: args.inSession } : {}),
        model: args.model ?? null,
        accountProfile: args.accountProfile ?? null,
      },
      observed: {
        name: args.displayName,
        hostDriver: hostDriverName as PeerHostDriver,
        tmuxTarget: sessionKey,
        pid: null,
        status: "starting",
        // `harvestEnv`, not `sanitizeEnv`: `env` above is what this peer starts
        // with, but this is the copy that PERSISTS across restarts, so the
        // pane-scoped vars have to go — they describe a pane that will not be
        // the same one next time.
        ...(args.envBase
          ? { spawnEnv: harvestEnv(args.envBase), harvestedAt: new Date().toISOString() }
          : {}),
        model: args.model ?? null,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      },
    } satisfies PeerRecord;
  });

  try {
    const record = await ctx.hostDriver.spawn({
      sessionKey,
      ...(args.inSession ? { inSession: args.inSession } : {}),
      // Name the window after the peer. tmux otherwise names it after the
      // command, so every window read `claude`.
      windowName: windowLabelFor(args.displayName, args.team),
      cwd: args.cwd,
      command: args.command,
      args: spawnArgs,
      env,
    });
    // record.sessionKey is the CANONICAL (driver-sanitized) form —
    // persist that so every subsequent host op receives the exact same
    // target the driver already owns (T1 fix, v0.10.0-rc.2).
    const canonicalKey = record.sessionKey;

    // A spawn that produced no running process is a FAILURE, however
    // cleanly the host command exited (fix, 2026-08-04).
    //
    // Before this, the driver's `alive` was a literal `true` and this
    // handler never looked at it: state went to `status: "live"`, a
    // `peer_started` event went into the audit trail, and the caller got
    // `outcome: ok` with `pid: null` as the sole hint. That is a phantom
    // live peer — `team_layout` sees it as running and never resurrects it,
    // and every operator report about it is a lie told with confidence.
    if (!record.alive || record.pid === null) {
      // Leave nothing half-registered, and take the empty tmux session with
      // us if one somehow survived.
      await applyStateChange(ctx.state, (draft) => {
        delete draft.peers[args.sessionId];
      });
      await ctx.hostDriver.kill(canonicalKey).catch(() => undefined);
      await writeEvent({
        event: "peer_spawn_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          sessionId: args.sessionId,
          sessionKey: canonicalKey,
          reason: "no_process_after_spawn",
          cwd: args.cwd,
          command: args.command,
        },
      });
      return errResult(
        req.id,
        req.tool,
        "spawn_produced_no_process",
        "Host reported the session was created but nothing is running in it — the command most likely exited immediately (wrong cwd, bad arguments, or missing binary).",
        {
          sessionId: args.sessionId,
          sessionKey: canonicalKey,
          cwd: args.cwd,
          command: args.command,
        },
      );
    }
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[args.sessionId];
      if (!rec) return;
      rec.observed.pid = record.pid;
      rec.observed.status = "live";
      rec.observed.tmuxTarget = canonicalKey;
      rec.observed.lastUpdatedAt = new Date().toISOString();
    });
    await writeEvent({
      event: "peer_started",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: args.sessionId,
        sessionKey: canonicalKey,
        rawSessionKey: sessionKey !== canonicalKey ? sessionKey : undefined,
        pid: record.pid,
        hostDriver: hostDriverName,
        resume: args.resume,
        model: args.model ?? null,
        accountProfile: args.accountProfile ?? null,
      },
    });
    await publishLifecycleEvent({
      event: "peer_started",
      sessionId: args.sessionId,
      sessionKey: canonicalKey,
      details: {
        pid: record.pid,
        hostDriver: hostDriverName,
        resume: args.resume,
        model: args.model ?? null,
      },
    });
    return okResult(req.id, req.tool, {
      sessionId: args.sessionId,
      sessionKey: canonicalKey,
      pid: record.pid,
      hostDriver: hostDriverName,
    });
  } catch (e) {
    await applyStateChange(ctx.state, (draft) => {
      delete draft.peers[args.sessionId];
    });
    const message = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_spawn_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: args.sessionId, sessionKey, err: message },
    });
    return errResult(req.id, req.tool, "spawn_failed", message, {
      sessionId: args.sessionId,
      sessionKey,
    });
  }
}

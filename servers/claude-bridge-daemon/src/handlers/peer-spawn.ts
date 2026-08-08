import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { projectsRoot, sessionFile } from "@claude-bridge/shared";
import { z } from "zod";
import { harvestEnv, sanitizeEnv } from "../env-whitelist.ts";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { PeerHostDriver, PeerRecord } from "../state.ts";
import type { HandlerContext } from "./context.ts";
import { forkGuard } from "./fork-guard.ts";
import { isResumableSessionId } from "./peer-restart.ts";
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
    label: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Explicit window label, overriding the one derived from displayName + team. " +
          "This is how an operator's `control_config set label=…` survives a restart.",
      ),
    /**
     * When `envBase` was sampled — or `null` for "carried, and we do not know".
     *
     * Three states, and the difference matters:
     *   absent  — this is a fresh harvest, stamp it with now
     *   string  — carried from a record that knew when it was sampled, keep that
     *   null    — carried from a record that did not know; keep not knowing
     *
     * v0.11.0 had only the first behaviour, so every `peer_restart` stamped
     * `harvestedAt` with the restart time over values that had been sampled days
     * earlier. Measured on 2026-08-06: all 22 rolled peers claimed a harvest at
     * 17:06–17:09 for an environment taken at adoption on 08-05. That is the
     * defect this whole release exists to prevent, committed by the field
     * written to prevent it.
     */
    envHarvestedAt: z.string().nullable().optional(),
  })
  .strict();

export type PeerSpawnArgs = z.infer<typeof PeerSpawnArgsSchema>;

/**
 * Does this session's transcript live under some OTHER working directory?
 *
 * Claude Code stores transcripts under a directory derived from `cwd`, so the
 * same session id is present or absent depending on where you stand. Telling a
 * caller "not here, but there" turns a dead end into an instruction; the 4 August
 * defect was exactly a peer relaunched in the wrong directory, and it produced
 * the same "No conversation found" as a transcript that never existed.
 *
 * Best effort and deliberately cheap: one directory listing, no recursion, and
 * any error means "cannot say", never "does not exist".
 */
function findTranscriptElsewhere(sessionId: string, cwd: string): string | null {
  try {
    const here = dirname(sessionFile(cwd, sessionId));
    for (const dir of readdirSync(projectsRoot())) {
      const candidate = join(projectsRoot(), dir, `${sessionId}.jsonl`);
      if (basename(join(projectsRoot(), dir)) === basename(here)) continue;
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No projects directory, no permission — cannot say.
  }
  return null;
}

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
    // Is there anything to resume? (N10, 2026-08-08)
    //
    // `claude --resume <uuid>` with no matching transcript prints
    // "No conversation found with session ID: <uuid>" and exits 1 — instantly,
    // before any probe can catch it. The peer then reads as a spawn that
    // "did not survive", which is a shrug where a diagnosis was available for
    // the cost of one `existsSync`.
    //
    // A missing transcript has TWO causes and they need different fixes, so the
    // check reports which one it is rather than merging them:
    //
    //   - it does not exist at all — the session id is wrong, or the peer never
    //     held a conversation (a session file is written at boot; a TRANSCRIPT
    //     only once something is said);
    //   - it exists under a DIFFERENT working directory. Claude Code looks for
    //     transcripts under a directory derived from `cwd`, so relaunching a
    //     peer somewhere else hides its own history from it. That was a real
    //     defect on 2026-08-04, and it produces this identical error message.
    // Only Claude Code keeps transcripts, so only Claude Code is asked about
    // one — the same rule the registration check follows. A relaunch of a shell
    // or a wrapper with `resume` set means something else to that program, and
    // refusing it here would be this handler inventing a rule for a command it
    // knows nothing about.
    const isClaude = args.command.split("/").pop() === "claude";
    const transcript = sessionFile(args.cwd, args.sessionId);
    if (isClaude && isResumableSessionId(args.sessionId) && !existsSync(transcript)) {
      const elsewhere = findTranscriptElsewhere(args.sessionId, args.cwd);
      await writeEvent({
        event: "peer_spawn_refused",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          sessionId: args.sessionId,
          reason: "resume_transcript_missing",
          cwd: args.cwd,
          transcript,
          elsewhere,
        },
      });
      return errResult(
        req.id,
        req.tool,
        "resume_transcript_missing",
        elsewhere
          ? `There is no transcript for ${args.sessionId} under cwd '${args.cwd}' (looked for ${transcript}) — but one exists at ${elsewhere}. Claude Code finds transcripts by working directory, so this peer would start, fail to find its own history and exit. Spawn it in the directory its transcript belongs to.`
          : `There is no transcript for ${args.sessionId} anywhere under ~/.claude/projects (looked for ${transcript}). \`--resume\` would print "No conversation found" and exit immediately. Either the session id is wrong, or that session never held a conversation — a session file is written at boot, a transcript only once something is said.`,
        { sessionId: args.sessionId, cwd: args.cwd, transcript, foundElsewhere: elsewhere },
      );
    }
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
        label: args.label ?? windowLabelFor(args.displayName, args.team),
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
          ? {
              spawnEnv: harvestEnv(args.envBase),
              // Only stamp what we actually sampled. `envHarvestedAt` absent
              // means a fresh harvest; present (string or null) means the caller
              // carried these values and already knows their provenance — or
              // knows that it does not.
              ...(args.envHarvestedAt === undefined
                ? { harvestedAt: new Date().toISOString() }
                : args.envHarvestedAt !== null
                  ? { harvestedAt: args.envHarvestedAt }
                  : {}),
            }
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
      // The same value the record stores, not a second derivation of it.
      // Computing it twice is how the record and the window get to disagree.
      windowName: args.label ?? windowLabelFor(args.displayName, args.team),
      cwd: args.cwd,
      command: args.command,
      args: spawnArgs,
      env,
    });
    // record.sessionKey is the CANONICAL (driver-sanitized) form —
    // persist that so every subsequent host op receives the exact same
    // target the driver already owns (T1 fix, v0.10.0-rc.2).
    const canonicalKey = record.sessionKey;

    // Was it still there a moment later? (N9, 2026-08-08)
    //
    // The driver probes for a pid the instant the host command returns, and a
    // process that is about to exit is still a live pid at that instant. So
    // this handler answered `ok` over three peers that were dead within the
    // second — measured 3 of 3, and the registry then held `status: "live"` for
    // all three. The same shape as the phantom-live record below, one storey
    // later: not "the spawn produced nothing", but "the spawn produced
    // something that did not last".
    //
    // A short second look is enough, because the deaths this catches are
    // immediate by nature: a refused `--resume`, a missing binary, a cwd that
    // does not exist. Anything that survives half a second has got past them.
    if (record.probe?.kind === "pid" && ctx.hostDriver.probePane) {
      await new Promise((r) => setTimeout(r, ctx.spawnConfirmMs ?? 500));
      const again = await ctx.hostDriver.probePane(canonicalKey);
      if (again.kind === "dead" || again.kind === "no-such-target") {
        record.probe = again.kind === "dead" ? again : record.probe;
        record.alive = false;
        if (again.kind === "dead") record.pid = again.pid;
      }
    }

    // A spawn that produced no running process is a FAILURE, however
    // cleanly the host command exited (fix, 2026-08-04).
    //
    // Before this, the driver's `alive` was a literal `true` and this
    // handler never looked at it: state went to `status: "live"`, a
    // `peer_started` event went into the audit trail, and the caller got
    // `outcome: ok` with `pid: null` as the sole hint. That is a phantom
    // live peer — `team_layout` sees it as running and never resurrects it,
    // and every operator report about it is a lie told with confidence.
    // NOT KNOWING is not the same as KNOWING IT DIED, and only one of them
    // justifies destroying anything.
    //
    // Until v0.11.5 both arrived here as `alive: false`, and this branch
    // answered by deleting the record and killing the session. So a tmux query
    // that timed out under load — or failed for any reason other than the
    // target being absent — took a peer that may well have been running, and
    // took the pane with it. The pane is where the explanation lives, which is
    // why the failure of 2026-08-07 07:05:59 could not be reproduced by anyone
    // afterwards: the tool tidies away exactly what an investigator needs.
    //
    // On uncertainty: keep the record, keep the session, say so, and let
    // `team_reconcile` — which can measure repeatedly and at leisure — decide.
    // The same rule the drift report follows for `windowIndex`: when you are
    // not sure, mark it and hand it to the layer that can look again.
    // The pane is there and tmux says the process in it has ALREADY EXITED —
    // with a status, which is the most informative failure this handler can
    // report. It only occurs where `remain-on-exit` is set; without it the pane
    // vanishes and the probe answers `no-such-target` instead.
    //
    // This is a fact, so the session goes. But the pane goes to the archive
    // FIRST: it holds the command's own output, which is the difference between
    // "exited 127" and "exited 127 because the binary is not on the peer's
    // PATH". If the archive cannot be written, the pane STAYS — evidence
    // outranks tidiness.
    if (record.probe?.kind === "dead") {
      const { exitStatus } = record.probe;
      const archivePath =
        (await ctx.hostDriver
          .archivePane?.(canonicalKey, `spawn produced a process that exited ${exitStatus ?? "?"}`)
          .catch(() => null)) ?? null;
      await applyStateChange(ctx.state, (draft) => {
        delete draft.peers[args.sessionId];
      });
      if (archivePath) await ctx.hostDriver.kill(canonicalKey).catch(() => undefined);
      await writeEvent({
        event: "peer_spawn_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          sessionId: args.sessionId,
          sessionKey: canonicalKey,
          reason: "process_exited_after_spawn",
          exitStatus,
          archivePath,
          paneKept: archivePath === null,
          cwd: args.cwd,
          command: args.command,
        },
      });
      return errResult(
        req.id,
        req.tool,
        "spawn_process_exited",
        `The command started and exited${exitStatus === null ? "" : ` with status ${exitStatus}`}. ${
          archivePath
            ? `What the pane was showing is saved at ${archivePath}.`
            : `The pane could NOT be archived, so it was left standing — read it with \`tmux capture-pane -p -t ${canonicalKey}\` before removing it.`
        }`,
        {
          sessionId: args.sessionId,
          sessionKey: canonicalKey,
          exitStatus,
          archivePath,
          probe: record.probe,
          cwd: args.cwd,
          command: args.command,
        },
      );
    }
    if (record.probe?.kind === "unavailable") {
      await applyStateChange(ctx.state, (draft) => {
        const rec = draft.peers[args.sessionId];
        if (!rec) return;
        rec.observed.status = "unknown";
        rec.observed.lastUpdatedAt = new Date().toISOString();
      });
      await writeEvent({
        event: "peer_spawn_unverified",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          sessionId: args.sessionId,
          sessionKey: canonicalKey,
          reason: "pane_pid_unavailable",
          hostSaid: record.probe.raw,
          attempts: record.probe.attempts,
          cwd: args.cwd,
          command: args.command,
        },
      });
      return errResult(
        req.id,
        req.tool,
        "spawn_unverified",
        `The session was created, but whether anything is running in it could not be determined after ${record.probe.attempts} attempts. ` +
          `Nothing was destroyed: inspect the pane with \`tmux capture-pane -p -t ${canonicalKey}\`, then either \`team_reconcile\` or \`peer_stop\`. ` +
          `The host said: ${record.probe.raw}`,
        {
          sessionId: args.sessionId,
          sessionKey: canonicalKey,
          probe: record.probe,
          cwd: args.cwd,
          command: args.command,
        },
      );
    }
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
        `The session was created and the host reports no such target — the command exited immediately. Host said: ${record.probe?.kind === "no-such-target" ? record.probe.raw : "(driver reported not-alive without detail)"}`,
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

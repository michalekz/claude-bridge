import { z } from "zod";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { handlePeerSpawn } from "./peer-spawn.ts";
import { handlePeerStop } from "./peer-stop.ts";

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
  const record =
    ctx.state.peers[args.peer] ??
    Object.values(ctx.state.peers).find((r) => r.name === args.peer) ??
    null;
  if (!record) {
    return errResult(
      req.id,
      req.tool,
      "peer_not_found",
      `No peer with id/name '${args.peer}' in daemon state`,
      { peer: args.peer },
    );
  }

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
      resume: true,
      model: args.model ?? record.model ?? null,
      accountProfile: args.accountProfile ?? record.accountProfile ?? null,
      extraAllowEnv: [],
      extraEnv: {},
    },
    requestedBy: req.requestedBy,
  };
  const spawnResult = await handlePeerSpawn(spawnArgs, ctx);
  if (spawnResult.outcome === "error") {
    return errResult(
      req.id,
      req.tool,
      "restart_spawn_failed",
      spawnResult.error?.message ?? "peer_spawn failed",
      { spawnResult },
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

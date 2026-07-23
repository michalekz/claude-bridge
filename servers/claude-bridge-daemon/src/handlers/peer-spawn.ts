import { z } from "zod";
import { sanitizeEnv } from "../env-whitelist.ts";
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
  })
  .strict();

export type PeerSpawnArgs = z.infer<typeof PeerSpawnArgsSchema>;

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
  const env = sanitizeEnv(process.env, {
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
      name: args.displayName,
      hostDriver: hostDriverName as PeerHostDriver,
      tmuxTarget: sessionKey,
      pid: null,
      status: "starting",
      model: args.model ?? null,
      accountProfile: args.accountProfile ?? null,
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    } satisfies PeerRecord;
  });

  try {
    const record = await ctx.hostDriver.spawn({
      sessionKey,
      cwd: args.cwd,
      command: args.command,
      args: spawnArgs,
      env,
    });
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[args.sessionId];
      if (!rec) return;
      rec.pid = record.pid;
      rec.status = "live";
      rec.lastUpdatedAt = new Date().toISOString();
    });
    await writeEvent({
      event: "peer_started",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: args.sessionId,
        sessionKey,
        pid: record.pid,
        hostDriver: hostDriverName,
        resume: args.resume,
        model: args.model ?? null,
        accountProfile: args.accountProfile ?? null,
      },
    });
    return okResult(req.id, req.tool, {
      sessionId: args.sessionId,
      sessionKey,
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

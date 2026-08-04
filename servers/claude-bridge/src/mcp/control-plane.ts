import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../util/atomic-write.ts";
import { makeLogger } from "../util/logger.ts";
import type { ServerContext } from "./context.ts";

const log = makeLogger("control-plane");

/**
 * MCP wire for the v0.10.0 control-plane daemon.
 *
 * The daemon runs as a separate systemd/launchd/task-scheduler user
 * service (see docs/architecture.md ADR-008). These tools do NOT talk
 * to the daemon over sockets — they read the same files the daemon
 * writes (`state.json`, `daemon.lock`, `heartbeat`) and write requests
 * into the daemon's inbox (`requests/<id>.json`).
 *
 * If the daemon is not installed, all tools return
 * `err("daemon_not_running", …)` with a `setupPointer` — analogous to
 * the `hasLiveData:false` shape used by `peer_context_status`.
 */

function controlDir(): string {
  return join(homedir(), ".claude-bridge", "control");
}

function daemonLockPath(): string {
  return join(controlDir(), "daemon.lock");
}

function stateFilePath(): string {
  return join(controlDir(), "state.json");
}

function heartbeatPath(): string {
  return join(controlDir(), "heartbeat");
}

function requestPath(id: string): string {
  return join(controlDir(), "requests", `${id}.json`);
}

function resultPath(id: string): string {
  return join(controlDir(), "results", `${id}.json`);
}

const HEARTBEAT_STALE_MS = 30_000;

interface LockPayload {
  pid: number;
  startedAt: string;
  procStart: string | null;
}

interface StatePeek {
  stateVersion: number;
  daemonVersion: string;
  daemonStartedAt: string;
  peers: Record<string, unknown>;
}

export interface DaemonPresence {
  running: boolean;
  reason?: "no_lock_file" | "heartbeat_stale" | "lock_read_error";
  lock: LockPayload | null;
  heartbeatAgeMs: number | null;
  state: StatePeek | null;
}

async function readLock(): Promise<LockPayload | null> {
  try {
    const raw = await readFile(daemonLockPath(), "utf-8");
    return JSON.parse(raw) as LockPayload;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    log.warn("lock_read_failed", { err: String(e) });
    return null;
  }
}

async function readState(): Promise<StatePeek | null> {
  try {
    const raw = await readFile(stateFilePath(), "utf-8");
    return JSON.parse(raw) as StatePeek;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    log.warn("state_read_failed", { err: String(e) });
    return null;
  }
}

async function readHeartbeatAgeMs(): Promise<number | null> {
  try {
    const s = await stat(heartbeatPath());
    return Date.now() - s.mtimeMs;
  } catch {
    return null;
  }
}

export async function probeDaemon(): Promise<DaemonPresence> {
  const [lock, state, heartbeatAgeMs] = await Promise.all([
    readLock(),
    readState(),
    readHeartbeatAgeMs(),
  ]);
  if (!lock) {
    return {
      running: false,
      reason: "no_lock_file",
      lock,
      heartbeatAgeMs,
      state,
    };
  }
  if (heartbeatAgeMs === null || heartbeatAgeMs > HEARTBEAT_STALE_MS) {
    return {
      running: false,
      reason: "heartbeat_stale",
      lock,
      heartbeatAgeMs,
      state,
    };
  }
  return { running: true, lock, heartbeatAgeMs, state };
}

// ============================================================================
// Result shape (matches the shape produced by tools.ts::ok/err)
// ============================================================================

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...(data as object) }) }],
  };
}

function err(code: string, message?: string, details?: unknown): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, code, message, details }),
      },
    ],
  };
}

const SETUP_POINTER =
  "Daemon not detected. Install with `node ~/.claude/claude-bridge-daemon.cjs install --systemd` (Linux) — see docs/architecture.md ADR-008.";

// ============================================================================
// control_status — daemon health + peer summary from state.json
// ============================================================================

export const ControlStatusArgs = z.object({}).strict();

export async function controlStatusTool(): Promise<ToolResult> {
  const presence = await probeDaemon();
  if (!presence.running) {
    return err("daemon_not_running", SETUP_POINTER, {
      reason: presence.reason,
      lock: presence.lock,
      heartbeatAgeMs: presence.heartbeatAgeMs,
      state: presence.state,
    });
  }
  return ok({
    daemon: {
      running: true,
      pid: presence.lock?.pid ?? null,
      startedAt: presence.lock?.startedAt ?? null,
      procStart: presence.lock?.procStart ?? null,
      heartbeatAgeMs: presence.heartbeatAgeMs,
    },
    state: presence.state
      ? {
          stateVersion: presence.state.stateVersion,
          daemonVersion: presence.state.daemonVersion,
          daemonStartedAt: presence.state.daemonStartedAt,
          peerCount: Object.keys(presence.state.peers ?? {}).length,
        }
      : null,
  });
}

// ============================================================================
// peer_stop — fire-and-forget request into daemon inbox
// ============================================================================

export const PeerStopArgs = z
  .object({
    peer: z.string().describe("Peer sessionId or display name"),
    reason: z.string().optional(),
    force: z.boolean().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

function generateRequestId(): string {
  const ms = Date.now().toString(36);
  const rand = randomBytes(2).toString("hex");
  return `${ms}-${rand}`;
}

async function pollForResult(requestId: string, timeoutMs: number): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(resultPath(requestId), "utf-8");
      return JSON.parse(raw);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function submitDaemonRequest(
  ctx: ServerContext,
  tool: string,
  args: Record<string, unknown>,
  opts: { wait?: boolean; timeoutMs?: number },
): Promise<ToolResult> {
  const presence = await probeDaemon();
  if (!presence.running) {
    return err("daemon_not_running", SETUP_POINTER, {
      reason: presence.reason,
      heartbeatAgeMs: presence.heartbeatAgeMs,
    });
  }
  const requestId = generateRequestId();
  const envelope = {
    schemaVersion: 1,
    id: requestId,
    ts: new Date().toISOString(),
    tool,
    args,
    requestedBy: {
      sessionId: ctx.self.id,
      name: ctx.self.name,
    },
  };
  try {
    await atomicWriteJson(requestPath(requestId), envelope);
  } catch (e) {
    return err("request_write_failed", e instanceof Error ? e.message : String(e));
  }
  if (opts.wait) {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const result = await pollForResult(requestId, timeoutMs);
    if (!result) {
      return ok({
        requestId,
        queuedAt: envelope.ts,
        waited: true,
        timedOut: true,
      });
    }
    return ok({ requestId, queuedAt: envelope.ts, waited: true, result });
  }
  return ok({ requestId, queuedAt: envelope.ts });
}

export async function peerStopTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerStopArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = { peer: args.peer };
  if (args.reason !== undefined) daemonArgs["reason"] = args.reason;
  if (args.force !== undefined) daemonArgs["force"] = args.force;
  return submitDaemonRequest(ctx, "peer_stop", daemonArgs, {
    wait: args.wait,
    timeoutMs: args.timeoutMs,
  });
}

// ============================================================================
// peer_spawn — start a new peer through the daemon
// ============================================================================

export const PeerSpawnArgs = z
  .object({
    sessionId: z.string().min(1),
    displayName: z.string().min(1),
    cwd: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    resume: z.boolean().optional(),
    model: z.string().optional(),
    accountProfile: z.string().optional(),
    extraAllowEnv: z.array(z.string()).optional(),
    extraEnv: z.record(z.string()).optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export async function peerSpawnTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerSpawnArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = {
    sessionId: args.sessionId,
    displayName: args.displayName,
    cwd: args.cwd,
    command: args.command,
    args: args.args ?? [],
    resume: args.resume ?? false,
    extraAllowEnv: args.extraAllowEnv ?? [],
    extraEnv: args.extraEnv ?? {},
  };
  if (args.model !== undefined) daemonArgs["model"] = args.model;
  if (args.accountProfile !== undefined) daemonArgs["accountProfile"] = args.accountProfile;
  return submitDaemonRequest(ctx, "peer_spawn", daemonArgs, {
    wait: args.wait,
    timeoutMs: args.timeoutMs,
  });
}

// ============================================================================
// peer_restart
// ============================================================================

export const PeerRestartArgs = z
  .object({
    peer: z.string().min(1),
    reason: z.string().optional(),
    force: z.boolean().optional(),
    model: z.string().optional(),
    accountProfile: z.string().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export async function peerRestartTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerRestartArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = { peer: args.peer };
  if (args.reason !== undefined) daemonArgs["reason"] = args.reason;
  if (args.force !== undefined) daemonArgs["force"] = args.force;
  if (args.model !== undefined) daemonArgs["model"] = args.model;
  if (args.accountProfile !== undefined) daemonArgs["accountProfile"] = args.accountProfile;
  return submitDaemonRequest(ctx, "peer_restart", daemonArgs, {
    wait: args.wait,
    timeoutMs: args.timeoutMs,
  });
}

// ============================================================================
// peer_compact — orchestrated /compact injection (charter §8 audited path)
// ============================================================================

export const PeerCompactArgs = z
  .object({
    peer: z.string().min(1),
    anchorTimeoutMs: z.number().int().positive().max(300_000).optional(),
    ackPollMs: z.number().int().positive().max(10_000).optional(),
    skipAnchorRequest: z.boolean().optional(),
    reason: z.string().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

export async function peerCompactTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerCompactArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = { peer: args.peer };
  if (args.anchorTimeoutMs !== undefined) daemonArgs["anchorTimeoutMs"] = args.anchorTimeoutMs;
  if (args.ackPollMs !== undefined) daemonArgs["ackPollMs"] = args.ackPollMs;
  if (args.skipAnchorRequest !== undefined)
    daemonArgs["skipAnchorRequest"] = args.skipAnchorRequest;
  if (args.reason !== undefined) daemonArgs["reason"] = args.reason;
  return submitDaemonRequest(ctx, "peer_compact", daemonArgs, {
    wait: args.wait,
    timeoutMs: args.timeoutMs,
  });
}

// ============================================================================
// team_layout — declarative reconcile (apply / prune)
// ============================================================================

export const TeamLayoutArgs = z
  .object({
    team: z.string().min(1),
    apply: z.boolean().optional(),
    prune: z.boolean().optional(),
    /** Inline spec bypasses the on-disk teams/<team>.json file. */
    inline: z.unknown().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export async function teamLayoutTool(
  ctx: ServerContext,
  args: z.infer<typeof TeamLayoutArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = { team: args.team };
  if (args.apply !== undefined) daemonArgs["apply"] = args.apply;
  if (args.prune !== undefined) daemonArgs["prune"] = args.prune;
  if (args.inline !== undefined) daemonArgs["inline"] = args.inline;
  return submitDaemonRequest(ctx, "team_layout", daemonArgs, {
    wait: args.wait ?? true,
    timeoutMs: args.timeoutMs ?? 15_000,
  });
}

// ============================================================================
// team_status — read-only aggregation of state.peers + host driver
// ============================================================================

export const TeamStatusArgs = z
  .object({
    team: z.string().optional(),
    verbose: z.boolean().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export async function teamStatusTool(
  ctx: ServerContext,
  args: z.infer<typeof TeamStatusArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = {};
  if (args.team !== undefined) daemonArgs["team"] = args.team;
  if (args.verbose !== undefined) daemonArgs["verbose"] = args.verbose;
  // team_status is read-only; default `wait:true` so callers get data,
  // not just an ack — matches the mental model of "gimme the status".
  return submitDaemonRequest(ctx, "team_status", daemonArgs, {
    wait: args.wait ?? true,
    timeoutMs: args.timeoutMs ?? 5_000,
  });
}

// ============================================================================
// team_stop — controlled sleep of a whole team (v0.10.1)
// ============================================================================

export const TeamStopArgs = z
  .object({
    team: z.string().min(1),
    /**
     * Kill peers that never acked the stop-request. Off by default: a peer
     * that has not parked its work keeps running rather than losing it.
     */
    force: z.boolean().optional(),
    /**
     * How long each peer gets to flush its anchor and memory before the
     * daemon gives up on it. Daemon default is 120 s PER PEER.
     */
    anchorTimeoutMs: z.number().int().positive().max(600_000).optional(),
    ackPollMs: z.number().int().positive().max(10_000).optional(),
    /** Preview the stop order without touching anything. */
    dryRun: z.boolean().optional(),
    inline: z.unknown().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(900_000).optional(),
  })
  .strict();

export async function teamStopTool(
  ctx: ServerContext,
  args: z.infer<typeof TeamStopArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = { team: args.team };
  if (args.force !== undefined) daemonArgs["force"] = args.force;
  if (args.anchorTimeoutMs !== undefined) daemonArgs["anchorTimeoutMs"] = args.anchorTimeoutMs;
  if (args.ackPollMs !== undefined) daemonArgs["ackPollMs"] = args.ackPollMs;
  if (args.dryRun !== undefined) daemonArgs["dryRun"] = args.dryRun;
  if (args.inline !== undefined) daemonArgs["inline"] = args.inline;

  // A real stop walks the team one peer at a time, each with its own ack
  // window, so the whole call can legitimately run for minutes. The default
  // client budget has to cover that or the caller times out on work that is
  // proceeding correctly. A dry run answers immediately.
  const perPeerBudget = args.anchorTimeoutMs ?? 120_000;
  const defaultTimeout = args.dryRun ? 5_000 : Math.min(perPeerBudget * 6 + 30_000, 900_000);
  return submitDaemonRequest(ctx, "team_stop", daemonArgs, {
    wait: args.wait ?? true,
    timeoutMs: args.timeoutMs ?? defaultTimeout,
  });
}

// ============================================================================
// team_adopt — take over peers the daemon did not spawn (v0.10.1)
// ============================================================================

export const TeamAdoptArgs = z
  .object({
    team: z.string().min(1),
    mode: z.enum(["auto", "manual"]).optional(),
    /** Adopt only peers whose host session matches. Plain name or `/regex/`. */
    hostSession: z.string().min(1).optional(),
    /** manual mode: host session key -> Claude session id. */
    mapping: z.record(z.string().min(1)).optional(),
    /**
     * Defaults to TRUE in the daemon — adoption writes foreign processes into
     * daemon state, so taking real ownership must be spelled out.
     */
    dryRun: z.boolean().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export async function teamAdoptTool(
  ctx: ServerContext,
  args: z.infer<typeof TeamAdoptArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = { team: args.team };
  if (args.mode !== undefined) daemonArgs["mode"] = args.mode;
  if (args.hostSession !== undefined) daemonArgs["hostSession"] = args.hostSession;
  if (args.mapping !== undefined) daemonArgs["mapping"] = args.mapping;
  if (args.dryRun !== undefined) daemonArgs["dryRun"] = args.dryRun;
  // Discovery scans the process table; always worth waiting for the answer.
  return submitDaemonRequest(ctx, "team_adopt", daemonArgs, {
    wait: args.wait ?? true,
    timeoutMs: args.timeoutMs ?? 20_000,
  });
}

// ============================================================================
// team_release / team_reconcile / team_restart — lifecycle trio (v0.10.6)
// ============================================================================

export const TeamReleaseArgs = z
  .object({
    peers: z.array(z.string().min(1)).optional(),
    team: z.string().min(1).optional(),
    reason: z.string().optional(),
    /** Defaults to TRUE in the daemon. */
    dryRun: z.boolean().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export async function teamReleaseTool(
  ctx: ServerContext,
  args: z.infer<typeof TeamReleaseArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = {};
  if (args.peers !== undefined) daemonArgs["peers"] = args.peers;
  if (args.team !== undefined) daemonArgs["team"] = args.team;
  if (args.reason !== undefined) daemonArgs["reason"] = args.reason;
  if (args.dryRun !== undefined) daemonArgs["dryRun"] = args.dryRun;
  return submitDaemonRequest(ctx, "team_release", daemonArgs, {
    wait: args.wait ?? true,
    timeoutMs: args.timeoutMs ?? 15_000,
  });
}

export const TeamReconcileArgs = z
  .object({
    team: z.string().min(1).optional(),
    markDead: z.boolean().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export async function teamReconcileTool(
  ctx: ServerContext,
  args: z.infer<typeof TeamReconcileArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = {};
  if (args.team !== undefined) daemonArgs["team"] = args.team;
  if (args.markDead !== undefined) daemonArgs["markDead"] = args.markDead;
  // Walks the process table and every tmux window — same budget as adoption.
  return submitDaemonRequest(ctx, "team_reconcile", daemonArgs, {
    wait: args.wait ?? true,
    timeoutMs: args.timeoutMs ?? 20_000,
  });
}

export const TeamRestartArgs = z
  .object({
    peers: z.array(z.string().min(1)).optional(),
    team: z.string().min(1).optional(),
    reason: z.string().optional(),
    settleMs: z.number().int().min(0).max(120_000).optional(),
    continueOnError: z.boolean().optional(),
    /** Defaults to TRUE in the daemon. */
    dryRun: z.boolean().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict();

export async function teamRestartTool(
  ctx: ServerContext,
  args: z.infer<typeof TeamRestartArgs>,
): Promise<ToolResult> {
  const daemonArgs: Record<string, unknown> = {};
  if (args.peers !== undefined) daemonArgs["peers"] = args.peers;
  if (args.team !== undefined) daemonArgs["team"] = args.team;
  if (args.reason !== undefined) daemonArgs["reason"] = args.reason;
  if (args.settleMs !== undefined) daemonArgs["settleMs"] = args.settleMs;
  if (args.continueOnError !== undefined) daemonArgs["continueOnError"] = args.continueOnError;
  if (args.dryRun !== undefined) daemonArgs["dryRun"] = args.dryRun;

  // A rolling restart takes as long as the peers do. The default budget covers
  // a whole fleet at the default settle time — a timeout mid-roll would leave
  // the caller with no answer about peers that were already restarted, which
  // is the one outcome worse than a slow one.
  const peerCount = args.peers?.length ?? 25;
  const settle = args.settleMs ?? 3_000;
  const estimate = peerCount * (settle + 15_000);
  return submitDaemonRequest(ctx, "team_restart", daemonArgs, {
    wait: args.wait ?? true,
    timeoutMs: args.timeoutMs ?? Math.min(600_000, Math.max(60_000, estimate)),
  });
}

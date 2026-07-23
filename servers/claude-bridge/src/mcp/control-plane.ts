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
    return { running: false, reason: "no_lock_file", lock, heartbeatAgeMs, state };
  }
  if (heartbeatAgeMs === null || heartbeatAgeMs > HEARTBEAT_STALE_MS) {
    return { running: false, reason: "heartbeat_stale", lock, heartbeatAgeMs, state };
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
    content: [{ type: "text", text: JSON.stringify({ ok: false, code, message, details }) }],
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

export async function peerStopTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerStopArgs>,
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
    tool: "peer_stop",
    args: {
      peer: args.peer,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.force !== undefined ? { force: args.force } : {}),
    },
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
  if (args.wait) {
    const timeoutMs = args.timeoutMs ?? 10_000;
    const result = await pollForResult(requestId, timeoutMs);
    if (!result) {
      return ok({ requestId, queuedAt: envelope.ts, waited: true, timedOut: true });
    }
    return ok({ requestId, queuedAt: envelope.ts, waited: true, result });
  }
  return ok({ requestId, queuedAt: envelope.ts });
}

import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { IdentitySource } from "../identity.ts";
import { atomicWriteJson } from "../util/atomic-write.ts";
import { bridgeRoot } from "../util/paths.ts";

/**
 * Heartbeat-based peer registry.
 *
 * Each peer writes `<baseDir>/status/<peerId>.json` periodically, where
 * `peerId` is the Claude Code sessionId UUID (stable, never collides).
 *
 * Discovery model (per cc2cc audit):
 * - No central registry process
 * - No join/leave events — silent presence via file mtime
 * - "online" = heartbeat written within ONLINE_THRESHOLD_MS
 * - Stale files (older than STALE_THRESHOLD_MS) get auto-cleaned during scan
 *
 * Trade-offs vs. broker-based (peers-mcp pattern):
 *   + No daemon to manage, no socket recovery, no idle exit
 *   + Filesystem-debuggable: `ls ~/.claude-bridge/status/` shows current state
 *   - Higher discovery latency (HEARTBEAT_INTERVAL_MS, default 5s)
 *   - Cross-FS not supported (only same-machine)
 *
 * v0.2.0: keyed on peerId (sessionId), not display name. Multiple chats in
 * the same cwd now show up as distinct peers.
 */

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const ONLINE_THRESHOLD_MS = 30_000;
export const STALE_THRESHOLD_MS = 60 * 60 * 1_000;

export const HeartbeatSchema = z
  .object({
    /** Stable peer id (Claude Code sessionId UUID). Doubles as the filename stem. */
    id: z.string().min(1),
    /** FS-safe slug name (may collide across peers). */
    name: z.string().min(1),
    /** Human-readable original title (defaults to `name` if no raw available). */
    displayName: z.string().optional(),
    pid: z.number().int(),
    cwd: z.string().optional(),
    lastSeen: z.string(), // ISO 8601
    source: z.string().optional(), // IdentitySource for display name
    version: z.string().optional(),
  })
  .passthrough();

// Explicit interfaces (not z.infer) so API types stay clean.
// Zod's `.passthrough()` adds an index signature that breaks property access
// under `noPropertyAccessFromIndexSignature` and disrupts `Omit<>`.
export interface Heartbeat {
  id: string;
  name: string;
  displayName?: string;
  pid: number;
  cwd?: string;
  lastSeen: string;
  source?: string;
  version?: string;
}

/** Payload supplied to `startHeartbeat` — same shape sans `lastSeen` (set by the registry). */
export interface HeartbeatInput {
  id: string;
  name: string;
  displayName?: string;
  pid: number;
  cwd?: string;
  source?: string;
  version?: string;
}

export interface ActivePeer extends Heartbeat {
  /** Age of the heartbeat in ms (now - lastSeen) */
  ageMs: number;
}

export interface PeerRegistryOptions {
  /** Override bridge root (default ~/.claude-bridge). Use absolute paths in tests. */
  baseDir?: string;
  /** Heartbeat interval in ms (default 5_000) */
  intervalMs?: number;
  /** Override Date.now() — for tests */
  now?: () => number;
}

export interface HeartbeatHandle {
  /** Write heartbeat immediately (outside the timer cycle) */
  flush(): Promise<void>;
  /** Replace cached payload fields (id stays fixed). Used for name refresh. */
  update(patch: Partial<Omit<HeartbeatInput, "id">>): void;
  /** Stop timer and remove heartbeat file (graceful shutdown) */
  stop(): Promise<void>;
}

export interface PeerRegistry {
  startHeartbeat(payload: HeartbeatInput): Promise<HeartbeatHandle>;
  listActivePeers(): Promise<ActivePeer[]>;
}

function statusDir(opts: PeerRegistryOptions): string {
  return join(opts.baseDir ?? bridgeRoot(), "status");
}

function heartbeatPath(opts: PeerRegistryOptions, peerId: string): string {
  return join(statusDir(opts), `${peerId}.json`);
}

async function readHeartbeat(path: string): Promise<Heartbeat | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const result = HeartbeatSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data as unknown as Heartbeat;
  } catch {
    return null;
  }
}

async function sweepStale(dir: string, now: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    try {
      const s = await stat(path);
      if (now - s.mtimeMs > STALE_THRESHOLD_MS) {
        await unlink(path).catch(() => undefined);
      }
    } catch {
      // ignore
    }
  }
}

export function createPeerRegistry(opts: PeerRegistryOptions = {}): PeerRegistry {
  const interval = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());

  async function writeOne(payload: Heartbeat): Promise<void> {
    const path = heartbeatPath(opts, payload.id);
    await atomicWriteJson(path, payload);
  }

  return {
    async startHeartbeat(payload) {
      // Cached payload — mutable via `update()` so name can refresh after boot.
      let current: Heartbeat = {
        ...payload,
        lastSeen: new Date(now()).toISOString(),
      };
      await writeOne(current);

      const timer = setInterval(() => {
        current = { ...current, lastSeen: new Date(now()).toISOString() };
        void writeOne(current).catch(() => undefined);
      }, interval);
      timer.unref?.();

      return {
        async flush() {
          current = { ...current, lastSeen: new Date(now()).toISOString() };
          await writeOne(current);
        },
        update(patch) {
          current = { ...current, ...patch };
        },
        async stop() {
          clearInterval(timer);
          await unlink(heartbeatPath(opts, payload.id)).catch(() => undefined);
        },
      };
    },

    async listActivePeers() {
      const dir = statusDir(opts);
      const currentMs = now();
      await sweepStale(dir, currentMs);

      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return [];
      }

      const result: ActivePeer[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const path = join(dir, entry);
        const hb = await readHeartbeat(path);
        if (!hb) continue;
        const ageMs = currentMs - Date.parse(hb.lastSeen);
        if (Number.isNaN(ageMs) || ageMs > ONLINE_THRESHOLD_MS) continue;
        result.push({ ...hb, ageMs });
      }
      return result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
  };
}

export type { IdentitySource };

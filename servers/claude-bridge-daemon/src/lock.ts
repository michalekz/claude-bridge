import { readFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { atomicWriteJson, daemonLockPath, makeLogger } from "@claude-bridge/shared";

/**
 * Daemon single-writer lock.
 *
 * Layout of `~/.claude-bridge/control/daemon.lock` (JSON):
 *   { pid: number, startedAt: string(ISO), procStart: string|null }
 *
 * `procStart` is the value from /proc/<pid>/stat field 22 (start time in
 * jiffies since boot) on Linux — a fingerprint unaffected by pid reuse. On
 * darwin/win32 it stays null and we rely on `kill(0, pid)` liveness alone.
 *
 * Acquisition:
 *   1. If lock absent → write.
 *   2. If lock present → read → check process alive (kill(0)) → on Linux,
 *      compare procStart. Match → refuse (another daemon owns it).
 *      Mismatch or dead → stale → take over.
 *
 * Release: unlink. `beforeExit` handler in the main daemon loop calls this
 * so a crashed daemon leaves the file behind but takeover detects it stale.
 */

const log = makeLogger("daemon.lock");

export interface LockPayload {
  pid: number;
  startedAt: string;
  procStart: string | null;
}

export class LockAcquireError extends Error {
  constructor(
    message: string,
    public readonly heldBy: LockPayload,
  ) {
    super(message);
    this.name = "LockAcquireError";
  }
}

export function readProcStart(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // Field 22 (1-indexed) is starttime. Comm is field 2 and may contain
    // spaces inside parens — take the substring AFTER the closing paren.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim();
    const fields = afterComm.split(/\s+/);
    // afterComm starts at field 3 (state), so starttime = index 19 (22-3).
    const starttime = fields[19];
    return starttime ?? null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function isStale(payload: LockPayload): boolean {
  if (!isProcessAlive(payload.pid)) return true;
  if (process.platform === "linux" && payload.procStart) {
    const currentStart = readProcStart(payload.pid);
    if (currentStart !== null && currentStart !== payload.procStart) return true;
  }
  return false;
}

export async function readLock(): Promise<LockPayload | null> {
  try {
    const raw = await readFile(daemonLockPath(), "utf-8");
    const parsed = JSON.parse(raw) as LockPayload;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    log.warn("lock_read_error", { code, err: String(e) });
    return null;
  }
}

export async function acquireLock(): Promise<LockPayload> {
  const existing = await readLock();
  if (existing) {
    if (isStale(existing)) {
      log.warn("lock_takeover_stale", { heldBy: existing });
    } else {
      throw new LockAcquireError(
        `daemon.lock held by live pid ${existing.pid} (started ${existing.startedAt})`,
        existing,
      );
    }
  }
  const payload: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    procStart: readProcStart(process.pid),
  };
  await atomicWriteJson(daemonLockPath(), payload);
  log.info("lock_acquired", { pid: payload.pid });
  return payload;
}

export async function releaseLock(): Promise<void> {
  try {
    await unlink(daemonLockPath());
    log.info("lock_released");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log.warn("lock_release_error", { code, err: String(e) });
  }
}

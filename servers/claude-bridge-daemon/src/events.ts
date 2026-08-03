import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { controlDir, eventsFilePath, makeLogger } from "@claude-bridge/shared";

/**
 * Append-only audit log — one NDJSON event per line.
 *
 * Schema pinned fields (§4.3 of the zadání):
 *   { schemaVersion, ts, level, event, by, requestId?, details }
 *
 * Rotation by size lives in F2; alpha writes single events.jsonl.
 * Never edit or remove entries in-place — audit trail is forever.
 */

const log = makeLogger("daemon.events");

export const EVENTS_SCHEMA_VERSION = 1;

export type EventLevel = "info" | "warn" | "error";

export interface EventIdentity {
  sessionId: string | null;
  name: string;
}

export interface DaemonEvent {
  event: string;
  level?: EventLevel;
  by?: EventIdentity;
  requestId?: string;
  details?: Record<string, unknown>;
}

interface WireEvent {
  schemaVersion: number;
  ts: string;
  pid: number;
  level: EventLevel;
  event: string;
  by: EventIdentity | null;
  requestId: string | null;
  details: Record<string, unknown>;
}

let ensured = false;
async function ensureDir(): Promise<void> {
  if (ensured) return;
  await mkdir(dirname(eventsFilePath()), { recursive: true });
  ensured = true;
}

/**
 * Size-based rotation (v0.10.2). The alpha comment said "rotation lives in
 * F2"; F2 never came and the file is append-only forever. It stayed small
 * only because the daemon has been idle — one `team_stop` over a real fleet
 * writes thousands of lines, and the RPC overlap bug found on 3. 8. would
 * have written ~12 000 in a single call.
 *
 * `events.jsonl` → `.1` → `.2` → `.3`, oldest discarded. Rotation renames,
 * never truncates: an entry that was written is never edited or removed
 * in-place, which is the audit-trail rule the file has always carried.
 */
export const EVENTS_MAX_BYTES_DEFAULT = 16 * 1024 * 1024;
export const EVENTS_KEEP_ROTATIONS = 3;

/**
 * Overridable so operators can tune it and so the rotation tests don't have
 * to write 16 MB per case to reach the boundary.
 */
export function eventsMaxBytes(): number {
  const raw = process.env["CLAUDE_BRIDGE_EVENTS_MAX_BYTES"];
  if (!raw) return EVENTS_MAX_BYTES_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : EVENTS_MAX_BYTES_DEFAULT;
}

/**
 * Bytes in the live file. -1 = not yet known, seed from stat on first write.
 *
 * This is a counter, not a stat-per-write, so it assumes the daemon is the
 * ONLY writer to events.jsonl — which it is, by design (single-writer state,
 * ADR-008). If anything else appends, the counter drifts low and rotation is
 * late rather than wrong.
 */
let liveBytes = -1;

/** Test seam — forget the cached size so a fresh file is re-measured. */
export function resetEventsSizeCache(): void {
  liveBytes = -1;
}

async function rotateIfNeeded(pendingBytes: number): Promise<void> {
  const path = eventsFilePath();
  const maxBytes = eventsMaxBytes();

  if (liveBytes < 0) {
    try {
      liveBytes = (await stat(path)).size;
    } catch {
      liveBytes = 0; // no file yet
    }
  }

  if (liveBytes + pendingBytes <= maxBytes) {
    liveBytes += pendingBytes;
    return;
  }

  // Shift the generations down, dropping whatever falls off the end.
  for (let i = EVENTS_KEEP_ROTATIONS - 1; i >= 1; i--) {
    await rename(`${path}.${i}`, `${path}.${i + 1}`).catch(() => undefined);
  }
  try {
    await rename(path, `${path}.1`);
    liveBytes = pendingBytes;
    log.info("events_rotated", { keep: EVENTS_KEEP_ROTATIONS, maxBytes });
  } catch (e) {
    // Rotation failed — keep appending rather than lose the event. Reset the
    // counter so we retry on the next write instead of every single one.
    liveBytes = 0;
    log.warn("events_rotate_failed", { err: String(e) });
  }
}

/**
 * Serialises writes. `writeEvent` is called from many concurrent handlers;
 * without this, two callers could interleave a rename with an append and the
 * append would land in the just-rotated file.
 */
let writeChain: Promise<void> = Promise.resolve();

export async function writeEvent(evt: DaemonEvent): Promise<void> {
  const run = writeChain.then(() => writeEventInner(evt));
  // Keep the chain alive even if one write rejects (writeEventInner already
  // swallows, but a future refactor shouldn't be able to wedge the daemon).
  writeChain = run.catch(() => undefined);
  return run;
}

async function writeEventInner(evt: DaemonEvent): Promise<void> {
  try {
    await ensureDir();
    const wire: WireEvent = {
      schemaVersion: EVENTS_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      pid: process.pid,
      level: evt.level ?? "info",
      event: evt.event,
      by: evt.by ?? null,
      requestId: evt.requestId ?? null,
      details: evt.details ?? {},
    };
    const line = `${JSON.stringify(wire)}\n`;
    await rotateIfNeeded(Buffer.byteLength(line, "utf-8"));
    await appendFile(eventsFilePath(), line, "utf-8");
  } catch (e) {
    // Audit-log write failure MUST not crash the daemon — but it MUST be
    // visible in stderr. This is the last-resort log path (v0.9.3 lesson:
    // structured stderr is diagnosis-critical).
    log.error("event_write_failed", { event: evt.event, err: String(e) });
  }
}

/**
 * Convenience for the launch/exit boundary — lifecycle events that must
 * appear even if the caller forgets `by`.
 */
export async function writeDaemonEvent(
  event: string,
  details: Record<string, unknown> = {},
  level: EventLevel = "info",
): Promise<void> {
  await writeEvent({
    event,
    level,
    by: { sessionId: null, name: "daemon" },
    details,
  });
}

// Ensure `controlDir()` is a value import, silence unused-import complaints
// in bundlers that tree-shake based on identifier reachability.
void controlDir;

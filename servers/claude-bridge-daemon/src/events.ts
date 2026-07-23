import { appendFile, mkdir } from "node:fs/promises";
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

export async function writeEvent(evt: DaemonEvent): Promise<void> {
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
    await appendFile(eventsFilePath(), `${JSON.stringify(wire)}\n`, "utf-8");
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

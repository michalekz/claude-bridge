import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { type SessionEvent, SessionEventSchema } from "./schemas.ts";

/**
 * Streaming JSONL parser for Claude Code session files.
 *
 * Yields validated SessionEvent objects one at a time. Designed for
 * memory-efficient processing — never loads the whole file.
 *
 * Errors:
 * - Malformed JSON lines are skipped with a warning (rare in practice — audit
 *   of 15 733 events found 0 corrupt lines).
 * - Validation failures are reported via `onValidationError` callback if
 *   provided, otherwise the line is skipped silently. Forward-compat is
 *   guaranteed by `.passthrough()` on schemas, so failures here usually
 *   indicate a real schema bug.
 */

export interface ParseOptions {
  /** Called for each line that fails to parse as JSON. */
  onJsonError?: (line: string, error: Error, lineNumber: number) => void;
  /** Called for each line that parses but fails schema validation. */
  onValidationError?: (raw: unknown, error: unknown, lineNumber: number) => void;
}

export async function* parseSessionFile(
  filePath: string,
  options: ParseOptions = {},
): AsyncGenerator<SessionEvent> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (line.trim().length === 0) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      options.onJsonError?.(line, e as Error, lineNumber);
      continue;
    }

    const result = SessionEventSchema.safeParse(raw);
    if (!result.success) {
      options.onValidationError?.(raw, result.error, lineNumber);
      continue;
    }

    yield result.data;
  }
}

/**
 * Convenience: collect all events from a session file into an array.
 * Use only for small files (< 100 MB). For larger files, prefer the
 * streaming generator.
 */
export async function readSessionFile(
  filePath: string,
  options: ParseOptions = {},
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of parseSessionFile(filePath, options)) {
    events.push(event);
  }
  return events;
}

/**
 * Counts events by type without loading content into memory.
 * Useful for quick session stats.
 */
export async function countEventsByType(filePath: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for await (const event of parseSessionFile(filePath)) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Raw event shape — what `parseSessionFileRaw` yields. We narrow to the keys
 * peer_chat_search actually reads. Untyped `unknown` for inner content because
 * we skip Zod validation here.
 */
export interface RawSessionEvent {
  type: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  // ai-title / custom-title meta events
  aiTitle?: string;
  customTitle?: string;
  // passthrough for forward compat / extra keys
  [key: string]: unknown;
}

/**
 * Stream parse JSONL without Zod validation — ~2× faster than parseSessionFile.
 *
 * Used by peer_chat_search where we scan many sessions and the Zod overhead
 * dominates. Trade-off: malformed events that would be rejected by the schema
 * pass through here — but search-time consumers handle missing fields defensively.
 *
 * For peer_chat_read (single-file scope) keep using parseSessionFile — the
 * validation cost is acceptable and catches schema drift early.
 */
export async function* parseSessionFileRaw(
  filePath: string,
  options: ParseOptions = {},
): AsyncGenerator<RawSessionEvent> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (line.trim().length === 0) continue;

    try {
      yield JSON.parse(line) as RawSessionEvent;
    } catch (e) {
      options.onJsonError?.(line, e as Error, lineNumber);
    }
  }
}

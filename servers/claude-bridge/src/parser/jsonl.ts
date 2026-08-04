import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { KNOWN_EVENT_TYPES, type SessionEvent, SessionEventSchema } from "./schemas.ts";

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

export interface EventTypeCounts {
  /** Count per `type`, exactly as the field appears in the file. */
  byType: Record<string, number>;
  /** Sum of `byType` — every non-blank line that parsed as JSON. */
  total: number;
  /** Observed types that `SessionEventSchema` does not model, with counts. */
  unmodelledTypes: Record<string, number>;
  /** Lines that are not valid JSON at all. */
  malformedLines: number;
}

/**
 * Counts events by type without loading content into memory.
 *
 * Counting does NOT validate (fix, 2026-08-04). It used to stream through
 * `parseSessionFile`, which drops every line `SessionEventSchema` rejects and,
 * with no `onValidationError` callback, drops them without a trace. The schema
 * is a nine-member discriminated union; a live transcript carries fourteen
 * types. Measured on a 19 767-line session: 17 173 counted, 2 594 discarded —
 * 13.1% of the file absent from a number labelled `totalEvents`.
 *
 * Two loss channels existed, and only the first is obvious:
 *   - unknown discriminant — `pr-link`, `mode`, `permission-mode`,
 *     `file-history-delta`, `agent-name` (2 591 lines)
 *   - KNOWN discriminant, failing field validation — 3 `last-prompt` lines in
 *     the same file
 *
 * Raw counts fix both. `unmodelledTypes` keeps the gap visible rather than
 * letting it quietly reappear as a smaller total.
 */
export async function countEventsByType(filePath: string): Promise<EventTypeCounts> {
  const byType: Record<string, number> = {};
  const unmodelledTypes: Record<string, number> = {};
  let total = 0;
  let malformedLines = 0;

  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    const type = (raw as { type?: unknown })?.type;
    // A line with no `type` is still a line — name it rather than drop it.
    const key = typeof type === "string" && type.length > 0 ? type : "(no type field)";
    byType[key] = (byType[key] ?? 0) + 1;
    total++;
    if (!KNOWN_EVENT_TYPES.has(key)) {
      unmodelledTypes[key] = (unmodelledTypes[key] ?? 0) + 1;
    }
  }

  return { byType, total, unmodelledTypes, malformedLines };
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

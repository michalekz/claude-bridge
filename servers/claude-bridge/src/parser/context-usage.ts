import { stat } from "node:fs/promises";
import { type RawSessionEvent, parseSessionFileRaw } from "./jsonl.ts";
import type { SessionRef } from "./session.ts";

/**
 * Context usage extraction from session JSONL.
 *
 * Empirical basis (verified 2026-06-24, 2026-06-29):
 *   The `usage.cache_read_input_tokens` field on the most recent assistant
 *   event matches `/context` Total exactly. This is the authoritative number
 *   equivalent to what /context shows — computable from disk JSONL with zero
 *   approximation, modulo timing (= JSONL is at-most one assistant turn behind
 *   real-time during own turn).
 */

export interface ContextUsage {
  /** Total tokens used (= /context Total). Equal to last assistant turn's cache_read_input_tokens. */
  tokensUsed: number;
  /** Model id from the same assistant event, e.g. "claude-opus-4-7" or "claude-opus-4-7-[1m]". */
  model: string | null;
  /** Detected context limit based on model variant. 200_000 standard, 1_000_000 for [1m]. */
  contextLimit: number;
  /** ISO timestamp of the assistant event whose usage we read. */
  lastTurnAt: string | null;
  /** Percent used (0-1). */
  percentUsed: number;
  /** Tokens remaining = limit - used. */
  tokensRemaining: number;
  /** Risk bucket: "low" < 60%, "medium" 60-85%, "high" > 85%. */
  autocompactRisk: "low" | "medium" | "high";
}

const ONE_M_PATTERN = /\[1m\]/i;
const STANDARD_LIMIT = 200_000;
const ONE_M_LIMIT = 1_000_000;

interface AssistantUsage {
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AssistantMessage {
  model?: string;
  usage?: AssistantUsage;
}

/**
 * Detect the context limit for a given model id.
 * Returns 1M for any [1m] variant, 200k otherwise.
 */
export function detectContextLimit(model: string | null | undefined): number {
  if (!model) return STANDARD_LIMIT;
  if (ONE_M_PATTERN.test(model)) return ONE_M_LIMIT;
  return STANDARD_LIMIT;
}

/**
 * Bucket usage percent into a risk label.
 */
export function riskBucket(percent: number): "low" | "medium" | "high" {
  if (percent < 0.6) return "low";
  if (percent < 0.85) return "medium";
  return "high";
}

/**
 * Read context usage from the latest assistant event in a session JSONL.
 *
 * Scans the file (streaming) and keeps the LAST assistant event with a usage
 * object containing `cache_read_input_tokens`. Returns null if the session
 * has no such event yet (brand-new session, never had a model turn).
 *
 * Cost: scans whole file once (~50-200 ms per MB). For frequent polling
 * consider caching the result and invalidating on mtime change.
 */
export async function readContextUsage(sessionRef: SessionRef): Promise<ContextUsage | null> {
  let lastUsage: AssistantUsage | null = null;
  let lastModel: string | null = null;
  let lastTimestamp: string | null = null;

  try {
    for await (const event of parseSessionFileRaw(sessionRef.filePath) as AsyncGenerator<
      RawSessionEvent & { message?: AssistantMessage }
    >) {
      if (event.type !== "assistant") continue;
      const usage = event.message?.usage;
      if (!usage || typeof usage.cache_read_input_tokens !== "number") continue;

      lastUsage = usage;
      lastModel = event.message?.model ?? null;
      if (typeof event.timestamp === "string") {
        lastTimestamp = event.timestamp;
      }
    }
  } catch {
    return null;
  }

  if (!lastUsage || typeof lastUsage.cache_read_input_tokens !== "number") {
    return null;
  }

  const tokensUsed = lastUsage.cache_read_input_tokens;
  // Limit detection: model name first (catches explicit [1m]).
  // Fallback heuristic: if tokensUsed > STANDARD_LIMIT, must be [1m] variant
  // (the 200k variant would have rejected the request before reaching this size).
  // The model string sometimes omits the [1m] tag because it's a session-level
  // setting, not part of the model id itself.
  let contextLimit = detectContextLimit(lastModel);
  if (contextLimit === STANDARD_LIMIT && tokensUsed > STANDARD_LIMIT) {
    contextLimit = ONE_M_LIMIT;
  }
  const percentUsed = contextLimit > 0 ? tokensUsed / contextLimit : 0;
  const tokensRemaining = Math.max(0, contextLimit - tokensUsed);

  return {
    tokensUsed,
    model: lastModel,
    contextLimit,
    lastTurnAt: lastTimestamp,
    percentUsed,
    tokensRemaining,
    autocompactRisk: riskBucket(percentUsed),
  };
}

/**
 * Convenience: read usage for a peer's most recent session by sessionId.
 * If multiple project copies exist (cwd migration), picks the most-recently-modified.
 */
export async function readContextUsageForSession(
  sessions: SessionRef[],
): Promise<ContextUsage | null> {
  if (sessions.length === 0) return null;
  // Pre-sort by mtime (most recent first) is already done upstream by findSessions/listAllSessions.
  const sessionRef = sessions[0] as SessionRef;
  // Verify file still exists / is reachable.
  try {
    await stat(sessionRef.filePath);
  } catch {
    return null;
  }
  return readContextUsage(sessionRef);
}

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

/**
 * Canonical model → context window mapping.
 *
 * Source: https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/models.md
 * Verified 2026-06-29.
 *
 * Per Anthropic platform docs: "For every model with a 1M-token context window,
 * 1M is the default: you don't need a beta header." Tj. 1M je DEFAULT pro
 * capable models (Opus, Sonnet, Fable, Mythos), Haiku zůstává 200k.
 *
 * Add new model ids here when Anthropic releases them. For unknown ids,
 * `detectContextLimit` falls back to the empirical heuristic.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Current generation (verified from https://platform.claude.com/docs/en/about-claude/models/overview, 2026-06-29)
  "claude-fable-5": ONE_M_LIMIT,
  "claude-mythos-5": ONE_M_LIMIT,
  "claude-mythos-preview": ONE_M_LIMIT,
  "claude-opus-4-8": ONE_M_LIMIT,
  "claude-sonnet-4-6": ONE_M_LIMIT,
  "claude-haiku-4-5": STANDARD_LIMIT, // jediný 200k v aktuální generaci
  // Legacy still available
  "claude-opus-4-7": ONE_M_LIMIT,
  "claude-opus-4-6": ONE_M_LIMIT,
  "claude-sonnet-4-5": STANDARD_LIMIT,
  "claude-opus-4-5": STANDARD_LIMIT,
  // Deprecated (retiring)
  "claude-opus-4-1": STANDARD_LIMIT,
};

/**
 * Strip suffixes from model id to get the base lookup key.
 *  - "claude-haiku-4-5-20251001" → "claude-haiku-4-5"  (date suffix)
 *  - "claude-opus-4-7-[1m]"     → "claude-opus-4-7"   ([1m] tag)
 */
function normalizeModelId(model: string): string {
  return model.replace(/\[1m\]/gi, "").replace(/-\d{8}$/, "");
}

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
 *
 * Resolution order:
 *  1. `[1m]` tag in model string → 1M (legacy explicit signal).
 *  2. Canonical lookup table (MODEL_CONTEXT_WINDOWS).
 *  3. Default 200k (unknown model).
 *
 * For unknown models, callers can apply an empirical fallback
 * (= if tokensUsed > STANDARD_LIMIT, must be 1M variant). See
 * `readContextUsage` for that defensive layer.
 */
export function detectContextLimit(model: string | null | undefined): number {
  if (!model) return STANDARD_LIMIT;
  if (ONE_M_PATTERN.test(model)) return ONE_M_LIMIT;

  const baseId = normalizeModelId(model);
  const known = MODEL_CONTEXT_WINDOWS[baseId];
  if (known !== undefined) return known;

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
  // Limit detection: canonical lookup table for known models; defensive
  // empirical fallback for unknown/future models — if usage exceeds 200k,
  // the model must be on a 1M-capable variant (200k would have rejected).
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

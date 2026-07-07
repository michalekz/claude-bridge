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

/**
 * How the contextLimit was determined. Consumers should treat
 * `unknown-model-fallback` results with caution — the model is not in the
 * canonical table, so 200k is a conservative guess; the real window may
 * be higher (e.g. 1M for new frontier models), making `percentUsed`
 * artificially inflated.
 */
export type ContextLimitSource =
  | "canonical-lookup" // Model found in MODEL_CONTEXT_WINDOWS (high confidence)
  | "explicit-1m-tag" // Model string carried `[1m]` suffix (legacy path)
  | "empirical-heuristic" // tokensUsed already > STANDARD_LIMIT → bumped to 1M
  | "unknown-model-fallback"; // Model unknown, using 200k default (⚠ possibly wrong)

export interface ContextUsage {
  /** Total tokens used (= /context Total). Sum of cache_read + cache_creation + input + output. */
  tokensUsed: number;
  /** Model id from the same assistant event, e.g. "claude-opus-4-7" or "claude-opus-4-7-[1m]". */
  model: string | null;
  /** Detected context limit based on model variant. 200_000 standard, 1_000_000 for [1m]. */
  contextLimit: number;
  /** Trace of how contextLimit was derived. Agents should treat `unknown-model-fallback` with caution. */
  contextLimitSource: ContextLimitSource;
  /** ISO timestamp of the assistant event whose usage we read. */
  lastTurnAt: string | null;
  /** Percent used (0-1). */
  percentUsed: number;
  /** Tokens remaining = limit - used. */
  tokensRemaining: number;
  /** Risk bucket: "low" < 60%, "medium" 60-85%, "high" > 85%. */
  autocompactRisk: "low" | "medium" | "high";
}

import { lookupModel } from "./model-metadata.ts";

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
 *
 * Resolution order:
 *  1. `[1m]` tag in model string → 1M (legacy explicit signal, overrides).
 *  2. Canonical model metadata lookup (see ./model-metadata.ts).
 *  3. Default 200k (unknown model).
 *
 * For unknown models, callers can apply an empirical fallback
 * (= if tokensUsed > STANDARD_LIMIT, must be 1M variant). See
 * `readContextUsage` for that defensive layer.
 */
export function detectContextLimit(model: string | null | undefined): number {
  if (!model) return STANDARD_LIMIT;
  if (ONE_M_PATTERN.test(model)) return ONE_M_LIMIT;

  const known = lookupModel(model);
  if (known) return known.contextWindow;

  return STANDARD_LIMIT;
}

/**
 * Same resolution as `detectContextLimit` but also reports the SOURCE of the
 * decision, so consumers can flag `unknown-model-fallback` cases as untrusted.
 *
 * Root cause of past bug (jira-architect HMH incident 2026-07-07): a new
 * Anthropic model (Claude Sonnet 5) with a 1M window was missing from the
 * canonical table; the fallback to STANDARD_LIMIT caused percentUsed to
 * inflate 5×. With `contextLimitSource` returned in the tool output, agents
 * can now see "the model was unknown to me, don't trust % blindly".
 */
export function detectContextLimitWithSource(
  model: string | null | undefined,
  tokensUsed: number,
): { limit: number; source: ContextLimitSource } {
  if (!model) return { limit: STANDARD_LIMIT, source: "unknown-model-fallback" };
  if (ONE_M_PATTERN.test(model)) return { limit: ONE_M_LIMIT, source: "explicit-1m-tag" };

  const known = lookupModel(model);
  if (known) return { limit: known.contextWindow, source: "canonical-lookup" };

  // Unknown model. Apply empirical safety net: if usage already blew past
  // STANDARD_LIMIT, the true window must be higher (200k variant would have
  // rejected before reaching this size). Trust the observation.
  if (tokensUsed > STANDARD_LIMIT) {
    return { limit: ONE_M_LIMIT, source: "empirical-heuristic" };
  }

  // Below STANDARD_LIMIT with unknown model: return conservative default with
  // explicit uncertainty flag. Consumer decides whether to trust the ratio.
  return { limit: STANDARD_LIMIT, source: "unknown-model-fallback" };
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
      if (!usage) continue;
      // Accept event if it has any of the usage fields we care about.
      const hasAnyUsage =
        typeof usage.cache_read_input_tokens === "number" ||
        typeof usage.cache_creation_input_tokens === "number" ||
        typeof usage.input_tokens === "number";
      if (!hasAnyUsage) continue;

      lastUsage = usage;
      lastModel = event.message?.model ?? null;
      if (typeof event.timestamp === "string") {
        lastTimestamp = event.timestamp;
      }
    }
  } catch {
    return null;
  }

  if (!lastUsage) {
    return null;
  }

  // tokensUsed = full context size after the last assistant turn.
  //   cache_read         — bytes read from prompt cache (mostly prior conversation)
  //   cache_creation     — bytes added to cache this turn (big after /clear or autocompact)
  //   input_tokens       — non-cached input (small per turn)
  //   output_tokens      — assistant's response (now part of history)
  // Summing all four matches /context Total across both mature and fresh sessions.
  // Reading cache_read alone undercounts by ~cache_creation for sessions that
  // recently went through cache invalidation (= near-100% bug if /clear just ran).
  const tokensUsed =
    (lastUsage.cache_read_input_tokens ?? 0) +
    (lastUsage.cache_creation_input_tokens ?? 0) +
    (lastUsage.input_tokens ?? 0) +
    (lastUsage.output_tokens ?? 0);
  // Limit detection: canonical lookup + empirical fallback + explicit source tag.
  const { limit: contextLimit, source: contextLimitSource } = detectContextLimitWithSource(
    lastModel,
    tokensUsed,
  );
  const percentUsed = contextLimit > 0 ? tokensUsed / contextLimit : 0;
  const tokensRemaining = Math.max(0, contextLimit - tokensUsed);

  return {
    tokensUsed,
    model: lastModel,
    contextLimit,
    contextLimitSource,
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

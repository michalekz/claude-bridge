import { stat } from "node:fs/promises";
import { type RawSessionEvent, parseSessionFileRaw } from "./jsonl.ts";
import { lookupModel } from "./model-metadata.ts";

/**
 * JSONL-based context reader — v0.9.4+ fallback path for readContextUsage
 * when the statusLine capture is absent or stale.
 *
 * Design principle (from control-plane zadání §10, ratified 2026-07-23):
 * telemetry must not have a single point of failure. StatusLine render-chain
 * (wrapper → symlink → file) is fragile; JSONL scan is authoritative for
 * tokensUsed (`cache_read + cache_creation + input + output` on the last
 * assistant event) and gives model name for canonical lookup.
 *
 * This is a partial reversal of v0.9.0 "live-data-only" — that release was
 * overzealous. It removed BOTH the heuristics AND the deterministic JSONL
 * scan. JSONL scan alone (without heuristics) is a valid autoritative source
 * for tokens; the heuristics come back only as EXPLICITLY FLAGGED fallbacks
 * for the `context_window_size` half of the equation.
 *
 * Return shape decouples "what we read from JSONL" (facts) from "how to
 * interpret contextLimit" (canonical vs. heuristic). Callers combine them.
 */

interface AssistantUsage {
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AssistantMessage {
  model?: string;
  usage?: AssistantUsage;
  stop_reason?: string;
}

const STANDARD_LIMIT = 200_000;
const ONE_M_LIMIT = 1_000_000;

/**
 * Raw context data extracted from the session JSONL. Facts only —
 * `contextLimit` interpretation lives in `canonicalContextLimit()`.
 */
export interface JSONLContextData {
  /** Sum of usage tokens on the last assistant event. */
  tokensUsed: number;
  /** Model id from the same assistant event (may still carry `[1m]` in
   * old JSONLs — normalize before lookup). */
  model: string | null;
  /** ISO timestamp of the last assistant event. */
  lastTurnAt: string | null;
  /** True when the last event in the JSONL is a user event postdating the
   * last assistant event — i.e., agent is mid-turn and `tokensUsed` is a
   * lower bound of the actual (in-flight) context.
   *
   * Detection (per zadání §10 Zdeněk 23. 7.): last event timestamp > last
   * assistant event timestamp AND last event is user (not another assistant
   * continuation). Compact watchdog rules on turn boundaries anyway, so
   * this is a signal for consumers, not a blocker. */
  turnInProgress: boolean;
}

/**
 * Read the last assistant event's usage + optional turnInProgress detection.
 * Returns null when the JSONL is unreadable or has no assistant events yet
 * (brand-new session).
 */
export async function readContextFromJSONL(filePath: string): Promise<JSONLContextData | null> {
  try {
    await stat(filePath);
  } catch {
    return null;
  }

  let lastAssistantUsage: AssistantUsage | null = null;
  let lastAssistantModel: string | null = null;
  let lastAssistantTimestamp: string | null = null;
  let lastEventTimestamp: string | null = null;
  let lastEventType: string | null = null;

  try {
    for await (const event of parseSessionFileRaw(filePath) as AsyncGenerator<
      RawSessionEvent & { message?: AssistantMessage }
    >) {
      // Track last-event-of-any-type for turnInProgress detection.
      if (typeof event.timestamp === "string") {
        lastEventTimestamp = event.timestamp;
        lastEventType = event.type;
      }

      if (event.type !== "assistant") continue;
      const usage = event.message?.usage;
      if (!usage) continue;

      const hasAnyUsage =
        typeof usage.cache_read_input_tokens === "number" ||
        typeof usage.cache_creation_input_tokens === "number" ||
        typeof usage.input_tokens === "number";
      if (!hasAnyUsage) continue;

      lastAssistantUsage = usage;
      lastAssistantModel = event.message?.model ?? null;
      if (typeof event.timestamp === "string") {
        lastAssistantTimestamp = event.timestamp;
      }
    }
  } catch {
    return null;
  }

  if (!lastAssistantUsage) return null;

  const tokensUsed =
    (lastAssistantUsage.cache_read_input_tokens ?? 0) +
    (lastAssistantUsage.cache_creation_input_tokens ?? 0) +
    (lastAssistantUsage.input_tokens ?? 0) +
    (lastAssistantUsage.output_tokens ?? 0);

  // turnInProgress: last event is user (or tool_result wrapper) that
  // postdates the last assistant event. Ignore file-metadata events
  // (ai-title, custom-title) — they can arrive well after a turn ends.
  const turnInProgress =
    lastEventType === "user" &&
    lastEventTimestamp !== null &&
    lastAssistantTimestamp !== null &&
    lastEventTimestamp > lastAssistantTimestamp;

  return {
    tokensUsed,
    model: lastAssistantModel,
    lastTurnAt: lastAssistantTimestamp,
    turnInProgress,
  };
}

/**
 * How the contextLimit was determined from a JSONL-derived model name.
 * Distinct from `ContextLimitSource` — this is the CAVEAT inside the
 * "jsonl-canonical" branch, not a source enum value.
 */
export type ContextLimitCaveat =
  /** Model was in the canonical Anthropic model table — full trust. */
  | "canonical-match"
  /** Model unknown AND tokensUsed > STANDARD_LIMIT — must be a 1M variant. */
  | "empirical-guess-1m"
  /** Model unknown AND tokensUsed ≤ STANDARD_LIMIT — conservative 200k default,
   * `percentUsed` may be inflated for genuine 1M models. */
  | "unknown-model-default-200k";

export interface ContextLimitResolution {
  limit: number;
  caveat: ContextLimitCaveat;
}

/**
 * Resolve the context window limit for a model name derived from JSONL.
 * Uses the same canonical table `model_info` MCP tool exposes; falls back
 * to explicit heuristics with named caveats (returning `caveat === "canonical-match"`
 * means the consumer can trust `percentUsed` fully).
 *
 * Note: the `[1m]` tag is stripped in canonical lookup (v0.7.3+ normalizer),
 * so a `[1m]` variant of a canonically-known model is still a canonical match.
 */
export function canonicalContextLimit(
  model: string | null | undefined,
  tokensUsed: number,
): ContextLimitResolution {
  const known = lookupModel(model);
  if (known) {
    return { limit: known.contextWindow, caveat: "canonical-match" };
  }
  // Model unknown. Empirical safety net: if usage already exceeds the
  // standard 200k limit, the real window must be 1M (200k variants would
  // have refused earlier).
  if (tokensUsed > STANDARD_LIMIT) {
    return { limit: ONE_M_LIMIT, caveat: "empirical-guess-1m" };
  }
  return { limit: STANDARD_LIMIT, caveat: "unknown-model-default-200k" };
}

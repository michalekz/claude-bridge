import { canonicalContextLimit, readContextFromJSONL } from "./jsonl-context.ts";
import type { ContextLimitCaveat } from "./jsonl-context.ts";
import { readStatusLineLive } from "./live-data.ts";
import type { SessionRef } from "./session.ts";

/**
 * Context usage reader — dual-source priority chain (v0.9.4+).
 *
 * Design principle (control-plane zadání §10, ratified 2026-07-23):
 * telemetry must not have a single point of failure. The v0.9.0-v0.9.3
 * era relied exclusively on the statusLine render chain (wrapper → symlink
 * → per-session file); when any step broke, `peer_context_status` returned
 * `hasLiveData: false` even though authoritative data was available in the
 * session JSONL.
 *
 * Priority chain (v0.9.4):
 *  1. **`statusline-stdin`** — statusLine capture live/statusline/<id>.json.
 *     Autoritative when present. Provides `context_window_size` +
 *     `used_percentage` + `total_input/output_tokens` directly from CC's
 *     API response mirror.
 *  2. **`jsonl-canonical`** — JSONL scan (last assistant event usage sum)
 *     + canonical model lookup for `contextLimit`. Deterministic when the
 *     model is in the canonical Anthropic docs table. Falls through to
 *     explicit heuristic caveats (`contextLimitCaveat`) when the model is
 *     unknown.
 *  3. **`no-live-data`** — Both sources unavailable (fresh session, no
 *     assistant turn yet, and no statusLine capture). Returns setupPointer.
 *
 * Partial reversal of v0.9.0: heuristic fallback flags return but are
 * EXPLICITLY LABELED inside the `jsonl-canonical` branch via `contextLimitCaveat`,
 * not as top-level `contextLimitSource` values. Consumers see one primary
 * source per response; caveats are subordinate detail.
 */

export type ContextLimitSource = "statusline-stdin" | "jsonl-canonical" | "no-live-data";

export interface ContextUsage {
  /** True if any live source produced data. */
  hasLiveData: boolean;
  /** Total tokens = sum of input + output + cache_read + cache_creation
   * from the most recent assistant event (JSONL) or from statusLine
   * capture's `total_input + total_output` when available. */
  tokensUsed: number;
  /** Model display name (statusLine) or id (JSONL). May be null on brand-new
   * sessions before first assistant event. */
  model: string | null;
  /** Context window size (denominator). 0 when hasLiveData=false. */
  contextLimit: number;
  /** How contextLimit was determined — one of three values per zadání §10. */
  contextLimitSource: ContextLimitSource;
  /** Optional caveat inside `jsonl-canonical` branch: `canonical-match`
   * (trust full), `empirical-guess-1m` (⚠ tokens>200k guess), or
   * `unknown-model-default-200k` (⚠ percentUsed may be inflated). Absent
   * when contextLimitSource is `statusline-stdin` (statusLine is
   * authoritative — no caveat). */
  contextLimitCaveat?: ContextLimitCaveat;
  /** ISO timestamp of last data point. */
  lastTurnAt: string | null;
  /** Percent used (0-1). Direct from statusLine `used_percentage` when
   * available; else computed from tokensUsed / contextLimit. */
  percentUsed: number;
  /** Tokens remaining = max(0, contextLimit - tokensUsed). */
  tokensRemaining: number;
  /** Risk bucket. `unknown` when contextLimit is 0 (no-live-data). */
  autocompactRisk: "low" | "medium" | "high" | "unknown";
  /** True when JSONL indicates an in-flight turn — `tokensUsed` is a lower
   * bound of the actual (in-flight) context; compact watchdog jedná on
   * turn boundaries anyway. Only set when the JSONL source is consulted;
   * with statusLine primary the field is null (statusLine is more current
   * than JSONL — it captures the request payload directly). */
  turnInProgress: boolean | null;
  /** Effort level from statusLine payload. Null in JSONL branch. */
  effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | null;
  /** Claude Code version from statusLine payload. Null in JSONL branch. */
  claudeCodeVersion: string | null;
  /** Setup instruction pointer when hasLiveData=false. */
  setupPointer?: string;
}

const SETUP_POINTER =
  "Install the chained statusLine wrapper for autoritative live context data, " +
  "or ensure the session JSONL has at least one assistant event for the JSONL " +
  "fallback path. See docs/SETUP-LIVE-DATA.md.";

/**
 * Bucket usage percent into a risk label.
 */
export function riskBucket(percent: number): "low" | "medium" | "high" {
  if (percent < 0.6) return "low";
  if (percent < 0.85) return "medium";
  return "high";
}

/**
 * v0.9.4 dual-source priority chain: statusLine capture → JSONL scan →
 * no-live-data.
 */
export async function readContextUsage(sessionRef: SessionRef): Promise<ContextUsage | null> {
  // Priority 1: statusLine capture (authoritative when present).
  const statuslineResult = await readFromStatusLine(sessionRef.sessionId);
  if (statuslineResult) return statuslineResult;

  // Priority 2: JSONL scan + canonical lookup fallback.
  const jsonlResult = await readFromJSONL(sessionRef.filePath);
  if (jsonlResult) return jsonlResult;

  // Priority 3: both sources dry — return null so caller can wrap with
  // noLiveDataStatus() for the peer_context_status output shape.
  return null;
}

async function readFromStatusLine(sessionId: string): Promise<ContextUsage | null> {
  const envelope = await readStatusLineLive(sessionId);
  if (!envelope) return null;

  const payload = envelope.payload;
  const cw = payload.context_window;
  const contextLimit = cw?.context_window_size ?? 0;
  if (contextLimit === 0) return null; // capture exists but no context_window yet

  const usage = cw?.current_usage;
  const sumOfCurrent =
    (usage?.input_tokens ?? 0) +
    (usage?.output_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0);
  const totalFromPayload =
    typeof cw?.total_input_tokens === "number" && typeof cw?.total_output_tokens === "number"
      ? cw.total_input_tokens + cw.total_output_tokens
      : null;
  const tokensUsed = totalFromPayload ?? sumOfCurrent;

  const percentFromPayload =
    typeof cw?.used_percentage === "number" ? cw.used_percentage / 100 : null;
  const percentUsed = percentFromPayload ?? tokensUsed / contextLimit;
  const tokensRemaining = Math.max(0, contextLimit - tokensUsed);

  return {
    hasLiveData: true,
    tokensUsed,
    model: payload.model?.display_name ?? null,
    contextLimit,
    contextLimitSource: "statusline-stdin",
    lastTurnAt: envelope.capturedAt,
    percentUsed,
    tokensRemaining,
    autocompactRisk: riskBucket(percentUsed),
    turnInProgress: null, // statusLine reflects the API-time snapshot — no separate turn-progress signal
    effortLevel: payload.effort?.level ?? null,
    claudeCodeVersion: payload.version ?? null,
  };
}

async function readFromJSONL(filePath: string): Promise<ContextUsage | null> {
  const jsonl = await readContextFromJSONL(filePath);
  if (!jsonl) return null;

  const { limit, caveat } = canonicalContextLimit(jsonl.model, jsonl.tokensUsed);
  const percentUsed = limit > 0 ? jsonl.tokensUsed / limit : 0;
  const tokensRemaining = Math.max(0, limit - jsonl.tokensUsed);

  return {
    hasLiveData: true,
    tokensUsed: jsonl.tokensUsed,
    model: jsonl.model,
    contextLimit: limit,
    contextLimitSource: "jsonl-canonical",
    contextLimitCaveat: caveat,
    lastTurnAt: jsonl.lastTurnAt,
    percentUsed,
    tokensRemaining,
    autocompactRisk: limit > 0 ? riskBucket(percentUsed) : "unknown",
    turnInProgress: jsonl.turnInProgress,
    effortLevel: null, // not present in JSONL usage — statusLine required
    claudeCodeVersion: null,
  };
}

/**
 * Convenience: read usage for a peer's session. Since v0.9.1 the statusLine
 * source is per-session (partitioned by sessionId), so this is a thin
 * wrapper for API compatibility with peer_context_status.
 */
export async function readContextUsageForSession(
  sessions: SessionRef[],
): Promise<ContextUsage | null> {
  if (sessions.length === 0) return null;
  return readContextUsage(sessions[0] as SessionRef);
}

/**
 * "No live data" placeholder for peer_context_status output. Used by
 * tools.ts when neither statusLine nor JSONL scan yielded data.
 */
export function noLiveDataStatus(): ContextUsage {
  return {
    hasLiveData: false,
    tokensUsed: 0,
    model: null,
    contextLimit: 0,
    contextLimitSource: "no-live-data",
    lastTurnAt: null,
    percentUsed: 0,
    tokensRemaining: 0,
    autocompactRisk: "unknown",
    turnInProgress: null,
    effortLevel: null,
    claudeCodeVersion: null,
    setupPointer: SETUP_POINTER,
  };
}

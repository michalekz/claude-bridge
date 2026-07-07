import { readStatusLineLive } from "./live-data.ts";
import type { SessionRef } from "./session.ts";

/**
 * Context usage — live-data-only source of truth (v0.9.0+).
 *
 * Sole source: `~/.claude-bridge/live/statusline.json` written by the
 * chained statusLine wrapper (bin/claude-bridge-statusline). Claude Code
 * 2.1.80+ sends `context_window.context_window_size` and per-category
 * token counts on stdin every render — no heuristics, no lookup tables.
 *
 * Removed in v0.9.0 (breaking change):
 *  - JSONL scan via parseSessionFileRaw for usage fields
 *  - detectContextLimit / detectContextLimitWithSource with the fallback
 *    chain (empirical-heuristic, unknown-model-fallback, settings-json-1m-tag,
 *    explicit-1m-tag, canonical-lookup for context detection)
 *  - Import of settings.ts (settings-json fallback dead code)
 *  - Import of model-metadata.ts (canonical table dead code for context)
 *
 * The canonical model table lives on in `model_info` MCP tool as read-only
 * reference for agents that want model metadata — pricing, capabilities,
 * lifecycle — not for context detection.
 *
 * Behavior when live data is missing:
 *  - Returns { hasLiveData: false, setupPointer } — no fallback guess.
 *  - Consumer (peer_context_status) surfaces this via contextLimitSource
 *    = "no-live-data" so the agent knows to instruct the user to install
 *    the statusLine wrapper (or the OAuth PostToolUse fallback, v0.9.0-beta).
 */

export type ContextLimitSource = "statusline-stdin" | "no-live-data";

export interface ContextUsage {
  /** True if live/statusline.json was readable and had context_window data. */
  hasLiveData: boolean;
  /** Total tokens = sum of input + output + cache_read + cache_creation. */
  tokensUsed: number;
  /** Model display name from statusLine payload (may be null on very
   * fresh sessions before first render). */
  model: string | null;
  /** Context window size from statusLine payload. 0 if hasLiveData=false. */
  contextLimit: number;
  /** How the limit was determined. Only two values in v0.9.0. */
  contextLimitSource: ContextLimitSource;
  /** ISO timestamp of the statusLine capture (= last CC render). */
  lastTurnAt: string | null;
  /** Percent used (0-1). Direct from statusLine used_percentage if present,
   * else computed from tokensUsed / contextLimit. */
  percentUsed: number;
  /** Tokens remaining = contextLimit - tokensUsed. */
  tokensRemaining: number;
  /** Risk bucket: "low" < 60%, "medium" 60-85%, "high" > 85%. */
  autocompactRisk: "low" | "medium" | "high" | "unknown";
  /** v0.9.0+ live-data extras from statusLine. */
  effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | null;
  /** Claude Code version reported in statusLine payload. */
  claudeCodeVersion: string | null;
  /** Setup instruction pointer when hasLiveData=false. */
  setupPointer?: string;
}

const SETUP_POINTER =
  "Install the chained statusLine wrapper: set settings.json.statusLine.command " +
  "to `node ${CLAUDE_PLUGIN_ROOT}/dist/statusline.cjs`. See docs/SETUP-LIVE-DATA.md.";

/**
 * Bucket usage percent into a risk label.
 */
export function riskBucket(percent: number): "low" | "medium" | "high" {
  if (percent < 0.6) return "low";
  if (percent < 0.85) return "medium";
  return "high";
}

/**
 * v0.9.0: live-data-only context usage.
 *
 * `sessionRef` is kept in the signature for API compatibility with
 * pre-v0.9.0 callers, but it's no longer used — rate limits are user-scoped
 * (single live file for all peers on this account). Cross-peer differences
 * in current session's context usage will be addressed in v0.10.0 by
 * storing per-session live envelopes (statusline.json → statusline/<id>.json).
 * For now, the last-written statusline.json wins.
 */
export async function readContextUsage(_sessionRef: SessionRef): Promise<ContextUsage | null> {
  const envelope = await readStatusLineLive();
  if (!envelope) return null;

  const payload = envelope.payload;
  const cw = payload.context_window;
  const contextLimit = cw?.context_window_size ?? 0;
  const usage = cw?.current_usage;
  const tokensUsed =
    (usage?.input_tokens ?? 0) +
    (usage?.output_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0);

  const percentFromPayload =
    typeof cw?.used_percentage === "number" ? cw.used_percentage / 100 : null;
  const percentUsed = percentFromPayload ?? (contextLimit > 0 ? tokensUsed / contextLimit : 0);
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
    autocompactRisk: contextLimit > 0 ? riskBucket(percentUsed) : "unknown",
    effortLevel: payload.effort?.level ?? null,
    claudeCodeVersion: payload.version ?? null,
  };
}

/**
 * Convenience: read usage for a peer's session. Since v0.9.0 the data
 * source is a single account-wide file (not per-session), this is a
 * thin wrapper for API compatibility.
 */
export async function readContextUsageForSession(
  sessions: SessionRef[],
): Promise<ContextUsage | null> {
  if (sessions.length === 0) return null;
  return readContextUsage(sessions[0] as SessionRef);
}

/**
 * v0.9.0 helper: construct a "no data" placeholder for peer_context_status
 * output. Used when live/statusline.json is absent. Consumer sees clear
 * `contextLimitSource: "no-live-data"` + a setup pointer instead of a
 * misleading percentage.
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
    effortLevel: null,
    claudeCodeVersion: null,
    setupPointer: SETUP_POINTER,
  };
}

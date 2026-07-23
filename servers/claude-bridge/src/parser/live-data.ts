import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "../util/atomic-write.ts";
import { bridgeRoot } from "../util/paths.ts";

/**
 * Live data reader/writer — canonical source of truth for rate limits and
 * context window usage (v0.9.0+).
 *
 * Two live sources, both under `~/.claude-bridge/live/`:
 *
 *  1. **`statusline/<sessionId>.json`** — written by the chained statusLine
 *     wrapper on every Claude Code statusLine render, one file per session.
 *     Contains stdin JSON payload from CC 2.1.80+: rate_limits, context_window,
 *     effort, model, version. Refresh cadence = statusLine render frequency
 *     (roughly per turn). AUTHORITATIVE for the SESSION's context_window;
 *     rate_limits are user-scoped so any recent file's rate_limits value
 *     is equally valid for the account.
 *
 *  2. **`oauth-api.json`** — written by the `claude-bridge-refresh-limits`
 *     PostToolUse hook when it triggers (throttled ~1/min). Contains the
 *     OAuth `/api/oauth/usage` response body. Secondary source for rate
 *     limits (richer fields: spend, extras, per-model quotas, codenames).
 *
 * v0.9.1 breaking change (from v0.9.0 layout):
 *  - The single `live/statusline.json` file (user-scoped) is REPLACED by
 *    `live/statusline/<sessionId>.json` (per-session).
 *  - v0.9.0 bug: last-writer-wins on the user-scoped file, so cross-peer
 *    `peer_context_status` returned identical (wrong) tokensUsed for all
 *    peers. Per-session partition fixes that.
 *  - Rate limits are still user-scoped (per POSIX account); we aggregate
 *    them by taking the newest per-session file's rate_limits payload.
 *
 * Removed in v0.9.0 (breaking):
 *  - ~/.claude/.usage_cache.json fossil read (was benabraham's secondary
 *    cache, factually not CC's — see CREDITS.md v0.8.3).
 *  - All context-limit heuristics in peer_context_status: empirical-heuristic,
 *    unknown-model-fallback, settings-json-1m-tag, explicit-1m-tag, and
 *    canonical-lookup for context detection. Canonical model table remains
 *    in model_info tool as read-only reference.
 */

// Lazy path resolution: `bridgeRoot()` reads `homedir()` at call time, so
// paths honor mocked homedir in tests. Static constants would freeze the
// path at import time and defeat the mock.
export function liveDir(): string {
  return join(bridgeRoot(), "live");
}
export function statusLineDir(): string {
  return join(liveDir(), "statusline");
}
export function statusLineSessionPath(sessionId: string): string {
  return join(statusLineDir(), `${sessionId}.json`);
}
/**
 * Legacy v0.9.0 path — kept for one-release backward-compat fallback so
 * users who updated to v0.9.1 but haven't triggered a new statusLine render
 * yet still see data from the pre-v0.9.1 shared file.
 */
export function legacyStatusLinePath(): string {
  return join(liveDir(), "statusline.json");
}
export function oauthLivePath(): string {
  return join(liveDir(), "oauth-api.json");
}

/**
 * Shape of the JSON Claude Code 2.1.80+ sends on stdin to the statusLine
 * hook. Derived by static analysis of benabraham/claude-code-status-line
 * v5.4.0 `data.get(...)` call sites (2026-07-07 recon).
 *
 * All fields are optional because CC may omit them on older versions or
 * during edge cases (session start before first assistant turn, etc.).
 */
export interface StatusLineStdinPayload {
  /** Session id from CC. v0.9.1+ writers use this to partition per-session
   * captures. Authoritative — CC sends it in the stdin payload. */
  session_id?: string;
  cwd?: string;
  model?: { display_name?: string };
  version?: string;
  worktree?: string;
  workspace?: unknown;
  effort?: { level?: "low" | "medium" | "high" | "xhigh" | "max" };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
  context_window?: {
    /** Total context window size (denominator). Authoritative — matches
     * canonical model window without any lookup table. */
    context_window_size?: number;
    /** Percentage 0-100 of context used. Direct signal from Anthropic API
     * response — no need to compute from tokens. */
    used_percentage?: number;
    /** Total tokens sent this turn (input side, including cache). CC 2.1.80+
     * exposes this at the same level as `current_usage`. Authoritative if
     * present — matches `/context` header. */
    total_input_tokens?: number;
    /** Total tokens received this turn (output side). */
    total_output_tokens?: number;
    /** Nested per-category token counts. Sum of input + output + both
     * cache fields ≈ total tokens (= /context Total). */
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Persistent envelope for `statusline/<sessionId>.json`. Wraps the raw
 * stdin payload with metadata for staleness reasoning and per-peer tracking.
 */
export interface StatusLineLiveEnvelope {
  /** ISO timestamp when the wrapper wrote this file. */
  capturedAt: string;
  /** Session id — matches payload.session_id when CC provides it, otherwise
   * falls back to CLAUDE_CODE_SESSION_ID env var or cwd-derived hash. */
  sessionId: string;
  /** Raw stdin payload from Claude Code. */
  payload: StatusLineStdinPayload;
}

/**
 * OAuth API response envelope. Written by the PostToolUse hook.
 * Structure follows the response of `/api/oauth/usage`.
 */
export interface OAuthApiLiveEnvelope {
  /** ISO timestamp when the hook wrote this file. */
  capturedAt: string;
  /** Raw response body from the OAuth API. */
  data: unknown;
}

async function readEnvelope<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as T;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read the statusLine live capture for a specific session (v0.9.1+).
 *
 * Path: `~/.claude-bridge/live/statusline/<sessionId>.json`
 *
 * Falls back to the legacy v0.9.0 `live/statusline.json` when the per-session
 * file is absent AND that legacy file's payload matches the requested
 * sessionId. This preserves data during the upgrade window before the
 * statusLine wrapper writes its first per-session capture.
 */
export async function readStatusLineLive(
  sessionId?: string,
): Promise<StatusLineLiveEnvelope | null> {
  if (sessionId) {
    const perSession = await readEnvelope<StatusLineLiveEnvelope>(statusLineSessionPath(sessionId));
    // v0.9.4 (§6/1): verify sessionId INSIDE the envelope matches the requested
    // one. Do not trust the path alone — a renamed/corrupted file could serve
    // foreign data. Same-value check for legacy fallback below.
    if (perSession && perSession.sessionId === sessionId) return perSession;
    // Legacy compat: if the shared file matches this session, use it.
    const legacy = await readEnvelope<StatusLineLiveEnvelope>(legacyStatusLinePath());
    if (legacy && legacy.sessionId === sessionId) return legacy;
    return null;
  }
  // No sessionId → callers want "whatever's newest" (used for rate_limits
  // aggregation, which is user-scoped). Prefer per-session dir, fall back
  // to legacy file.
  return findNewestStatusLine();
}

/**
 * Scan the per-session directory and return the newest envelope (by
 * capturedAt), or the legacy file if the dir is empty. Used for rate-limits
 * aggregation — rate limits are user-scoped so any recent capture reflects
 * the account's current state.
 */
export async function findNewestStatusLine(): Promise<StatusLineLiveEnvelope | null> {
  let newest: StatusLineLiveEnvelope | null = null;
  let newestMs = 0;
  try {
    const entries = await readdir(statusLineDir());
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const envelope = await readEnvelope<StatusLineLiveEnvelope>(join(statusLineDir(), entry));
      if (!envelope) continue;
      const capturedMs = Date.parse(envelope.capturedAt);
      if (Number.isNaN(capturedMs)) continue;
      if (capturedMs > newestMs) {
        newestMs = capturedMs;
        newest = envelope;
      }
    }
  } catch {
    // dir doesn't exist yet — fall through to legacy check
  }
  if (newest) return newest;
  return readEnvelope<StatusLineLiveEnvelope>(legacyStatusLinePath());
}

/**
 * Read the most recent OAuth API live capture, or null.
 */
export async function readOAuthApiLive(): Promise<OAuthApiLiveEnvelope | null> {
  return readEnvelope<OAuthApiLiveEnvelope>(oauthLivePath());
}

/**
 * Atomically write a statusLine capture, partitioned by session id (v0.9.1+).
 * Creates `~/.claude-bridge/live/statusline/` if it doesn't exist. Called
 * by the `claude-bridge-statusline` wrapper on every CC render.
 */
export async function writeStatusLineLive(envelope: StatusLineLiveEnvelope): Promise<void> {
  const path = statusLineSessionPath(envelope.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteJson(path, envelope);
}

/**
 * Atomically write an OAuth API capture. Called by the PostToolUse hook.
 */
export async function writeOAuthApiLive(envelope: OAuthApiLiveEnvelope): Promise<void> {
  await mkdir(dirname(oauthLivePath()), { recursive: true });
  await atomicWriteJson(oauthLivePath(), envelope);
}

/**
 * How old (in seconds) the given live envelope is at the given `now`.
 * Returns Infinity if the timestamp is malformed.
 */
export function envelopeAgeSeconds(
  envelope: { capturedAt: string },
  now: Date = new Date(),
): number {
  const captured = Date.parse(envelope.capturedAt);
  if (Number.isNaN(captured)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - captured) / 1000));
}

// Static ref so tree-shaking preserves stat import (used by tests for mtime).
void stat;

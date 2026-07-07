import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "../util/atomic-write.ts";
import { bridgeRoot } from "../util/paths.ts";

/**
 * Live data reader/writer — canonical source of truth for rate limits and
 * context window usage (v0.9.0+).
 *
 * Two live sources, both under `~/.claude-bridge/live/`:
 *
 *  1. `statusline.json` — written by `claude-bridge-statusline` wrapper on
 *     every Claude Code statusLine render. Contains stdin JSON payload as
 *     sent by CC 2.1.80+: rate_limits, context_window, effort, model,
 *     version. Refresh cadence = statusLine render frequency (per turn).
 *     This is the AUTHORITATIVE source — no heuristics, no lookup tables.
 *
 *  2. `oauth-api.json` — written by `claude-bridge-refresh-limits`
 *     PostToolUse hook when it triggers (throttled). Contains OAuth API
 *     response from `https://api.anthropic.com/api/oauth/usage`. Fallback
 *     when statusLine is not configured. Deprecated endpoint per benabraham
 *     documentation; kept as an alternative for users who don't chain the
 *     statusLine.
 *
 * Read priority: statusline > oauth-api > null (with setup pointer).
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
export function statusLineLivePath(): string {
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
    /** Nested per-category token counts. Sum of input + output + both
     * cache fields = total tokens (= /context Total). */
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Persistent envelope for `statusline.json`. Wraps the raw stdin payload
 * with metadata for staleness reasoning and multi-peer tracking.
 */
export interface StatusLineLiveEnvelope {
  /** ISO timestamp when the wrapper wrote this file. */
  capturedAt: string;
  /** Session id from CC env (CLAUDE_CODE_SESSION_ID) or "unknown" if absent. */
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
 * Read the most recent statusLine live capture, or null if the file is
 * absent / malformed. Caller decides whether to fall back to OAuth or
 * fail with a setup pointer.
 */
export async function readStatusLineLive(): Promise<StatusLineLiveEnvelope | null> {
  return readEnvelope<StatusLineLiveEnvelope>(statusLineLivePath());
}

/**
 * Read the most recent OAuth API live capture, or null.
 */
export async function readOAuthApiLive(): Promise<OAuthApiLiveEnvelope | null> {
  return readEnvelope<OAuthApiLiveEnvelope>(oauthLivePath());
}

/**
 * Atomically write a statusLine capture. Creates `~/.claude-bridge/live/`
 * if it doesn't exist. Called by the `claude-bridge-statusline` wrapper.
 */
export async function writeStatusLineLive(envelope: StatusLineLiveEnvelope): Promise<void> {
  await mkdir(dirname(statusLineLivePath()), { recursive: true });
  await atomicWriteJson(statusLineLivePath(), envelope);
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

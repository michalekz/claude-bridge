/**
 * Environment whitelist for `peer_spawn` (§6/8 of the zadání —
 * blacklist nestačil dvakrát in v0.9.4 cascade; whitelist is the only
 * safe choice).
 *
 * Everything that reaches the spawned Claude Code process is composed
 * explicitly here — the daemon NEVER inherits from `process.env`
 * without filtering. The prime regression this closes is the 22. 7.
 * incident where a stray `ANTHROPIC_API_KEY` in the operator's shell
 * hitched a ride into a resumed session, disabling plugins and pushing
 * usage onto the API-key billing bucket instead of the subscription.
 */

/**
 * Base set of variables that are safe (and useful) to pass through
 * regardless of team profile. Anything not in this list — or in the
 * caller-supplied extras — is dropped.
 */
export const BASE_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "TMPDIR",
  "TMUX",
  "TMUX_PANE",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);

/**
 * Prefixes that are ALWAYS stripped even when the caller lists them —
 * they carry state that leaks the operator's session into the spawned
 * peer. Match against fully-qualified variable names, case-sensitive.
 */
export const HARD_STRIP_PREFIXES: readonly string[] = Object.freeze([
  "ANTHROPIC_",
  "CLAUDE_",
  "CC_",
  "CLAUDE_CODE_",
]);

export interface SanitizeEnvOptions {
  /** Extra variable NAMES (not values) to allow through from callerEnv. */
  extraAllow?: readonly string[];
  /** Fully-formed overrides applied last — bypass allow/strip logic. */
  overrides?: Record<string, string>;
}

/**
 * Build a fresh environment for a spawned peer.
 *
 * Precedence (later wins):
 *   1. BASE_ALLOWLIST ∪ extraAllow — pull from `callerEnv`
 *   2. HARD_STRIP_PREFIXES — drop anything matching
 *   3. `overrides` — final say (e.g. `CLAUDE_CONFIG_DIR`)
 */
export function sanitizeEnv(
  callerEnv: NodeJS.ProcessEnv,
  opts: SanitizeEnvOptions = {},
): Record<string, string> {
  const allow = new Set<string>([...BASE_ALLOWLIST, ...(opts.extraAllow ?? [])]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(callerEnv)) {
    if (value === undefined) continue;
    if (!allow.has(key)) continue;
    if (HARD_STRIP_PREFIXES.some((p) => key.startsWith(p))) continue;
    out[key] = value;
  }
  if (opts.overrides) {
    for (const [key, value] of Object.entries(opts.overrides)) {
      if (HARD_STRIP_PREFIXES.some((p) => key.startsWith(p)) && !isSpawnEssentialClaudeVar(key)) {
        // Even overrides are gated for the Claude/Anthropic prefix — only
        // the tiny list of vars the daemon actively NEEDS to set (e.g.
        // CLAUDE_CONFIG_DIR for subscription profile) gets through.
        continue;
      }
      out[key] = value;
    }
  }
  return out;
}

/**
 * Whitelist of Claude/Anthropic env vars the daemon is allowed to set
 * on the spawned peer (via `overrides`). Everything else in that
 * namespace is refused even when explicitly listed.
 */
export function isSpawnEssentialClaudeVar(name: string): boolean {
  return SPAWN_ESSENTIAL_CLAUDE_VARS.has(name);
}

const SPAWN_ESSENTIAL_CLAUDE_VARS = new Set<string>([
  // Points CC at a specific config/credentials profile — the mechanism
  // subscription-based auth uses.
  "CLAUDE_CONFIG_DIR",
]);

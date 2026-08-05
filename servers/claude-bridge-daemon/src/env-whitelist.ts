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
 * Variables the HOST supplies to whatever it puts in a pane — properties of
 * the pane, not of the process sitting in it.
 *
 * They belong in `BASE_ALLOWLIST` (a peer needs them to run) and must never
 * be written into `PeerRecord.spawnEnv`, because that record outlives the
 * pane it was harvested from. `spawnEnv` answers "what may this peer carry";
 * these answer "where is it running right now" — the same allowlist was
 * serving both questions, and the second one has no stable answer.
 *
 * Observed 2026-08-04: `kb-ops` was harvested in pane `%71`, relaunched into
 * `%1011`, and kept `TMUX_PANE=%71` in its environment — a pointer to a pane
 * that no longer exists. `TERM` failed the other way round: the daemon runs
 * under systemd with no terminal, so a harvest taken from a peer the outage
 * had already stripped recorded no `TERM` at all, and every later relaunch
 * reproduced that absence. Neither is fixable by editing the allowlist; both
 * are fixed by not persisting these three.
 *
 * Nothing is lost by dropping them at harvest time: the pane reads all three
 * from tmux for itself at spawn — see `paneCommand` in `hosts/tmux-driver.ts`.
 */
export const HOST_PROVIDED_VARS: readonly string[] = Object.freeze(["TERM", "TMUX", "TMUX_PANE"]);

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
 * Filter an environment for PERSISTENCE into `PeerRecord.spawnEnv`.
 *
 * Same rules as `sanitizeEnv`, minus `HOST_PROVIDED_VARS` — see that constant
 * for why an environment that is correct to *run* with is wrong to *store*.
 * Use this at every harvest site (`team_adopt`); use `sanitizeEnv` when
 * composing the environment a process is about to start with.
 */
export function harvestEnv(
  callerEnv: NodeJS.ProcessEnv,
  opts: SanitizeEnvOptions = {},
): Record<string, string> {
  return stripHostProvided(sanitizeEnv(callerEnv, opts));
}

/**
 * Drop `HOST_PROVIDED_VARS` from an already-built environment.
 *
 * Also applied when loading state written by an earlier version, so records
 * harvested before this fix stop carrying a dead `TMUX_PANE` forward.
 */
export function stripHostProvided(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (HOST_PROVIDED_VARS.includes(key)) continue;
    out[key] = value;
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

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { makeLogger } from "../util/logger.ts";
import { bridgeRoot, claudeHome } from "../util/paths.ts";

/**
 * `claude-bridge-setup-check` — bundled SessionStart hook (v0.9.0-rc+).
 *
 * Wiring: shipped inside the plugin via `.claude-plugin/hooks/hooks.json`,
 * so it activates automatically after `/plugin install` and `/plugin
 * marketplace update`. User does NOT edit settings.json manually.
 *
 * Behavior on every SessionStart:
 *  1. Detect the currently-installed plugin cache dir (highest semver in
 *     ~/.claude/plugins/cache/claude-bridge/claude-bridge/[version]/).
 *  2. Maintain two stable-path symlinks so settings.json can reference them
 *     without version pinning:
 *       ~/.claude/claude-bridge-statusline.cjs → cache/<ver>/dist/statusline.cjs
 *       ~/.claude/claude-bridge-refresh-limits.cjs → cache/<ver>/dist/refresh-limits.cjs
 *  3. Read state from ~/.claude-bridge/setup-state.json:
 *       { pluginVersion: string, lastBannerShownForVersion: string,
 *         statusLineConfigured: boolean, hookConfigured: boolean }
 *  4. Inspect ~/.claude/settings.json:
 *       - Is statusLine.command === wrapper script we manage?
 *       - Is any PostToolUse hook pointing at our refresh-limits binary?
 *  5. Emit a viditelný banner to stderr when:
 *       - plugin version changed since last banner, OR
 *       - setup is incomplete (missing statusLine wrapper or hook)
 *     Banner points at docs/SETUP-LIVE-DATA.md with exact copy-paste
 *     snippets. Silent no-op when setup is complete and version unchanged.
 *  6. Auto-generate a wrapper shell script at
 *     ~/.claude/claude-bridge-statusline-wrapper.sh that reads the user's
 *     ORIGINAL statusLine command (captured from settings.json before we
 *     ever touched it) and passes it as CLAUDE_BRIDGE_UNDERLYING_STATUSLINE
 *     to statusline.cjs. Preserves user's existing status line (benabraham,
 *     custom, whatever) via subprocess passthrough.
 *
 * Never crashes — SessionStart hooks with non-zero exit block the session
 * from starting on some CC versions. All errors log to stderr, exit 0.
 *
 * State file format:
 *   ~/.claude-bridge/setup-state.json
 *   {
 *     "pluginVersion": "0.9.0",
 *     "lastBannerShownForVersion": "0.9.0",
 *     "originalStatusLine": "~/.claude/claude-code-status-line.py",
 *     "statusLineConfigured": true,
 *     "hookConfigured": true,
 *     "lastCheckedAt": "2026-07-07T15:00:00Z"
 *   }
 */

const log = makeLogger("setup-check");

interface SetupState {
  pluginVersion?: string;
  lastBannerShownForVersion?: string;
  originalStatusLine?: string;
  statusLineConfigured?: boolean;
  hookConfigured?: boolean;
  lastCheckedAt?: string;
}

interface ClaudeSettings {
  statusLine?: { type?: string; command?: string };
  hooks?: {
    PostToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
  };
}

const CACHE_DIR = join(claudeHome(), "plugins", "cache", "claude-bridge", "claude-bridge");
const STATUSLINE_SYMLINK = join(claudeHome(), "claude-bridge-statusline.cjs");
const REFRESH_LIMITS_SYMLINK = join(claudeHome(), "claude-bridge-refresh-limits.cjs");
const WRAPPER_SCRIPT = join(claudeHome(), "claude-bridge-statusline-wrapper.sh");
const STATE_FILE = join(bridgeRoot(), "setup-state.json");
const SETTINGS_FILE = join(claudeHome(), "settings.json");

/**
 * Compare semver-ish strings. Returns >0 if a > b, <0 if a < b, 0 equal.
 * Handles pre-release suffixes ("0.9.0-alpha.2" < "0.9.0") the way npm does.
 */
function compareVersions(a: string, b: string): number {
  const [aBase, aPre] = a.split("-", 2);
  const [bBase, bPre] = b.split("-", 2);
  const aParts = (aBase ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bParts = (bBase ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // Base equal. Pre-release lower than release. Otherwise string compare.
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre.localeCompare(bPre);
  return 0;
}

async function findLatestCacheVersion(): Promise<string | null> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(CACHE_DIR);
    if (entries.length === 0) return null;
    return entries.sort(compareVersions).pop() ?? null;
  } catch {
    return null;
  }
}

async function readState(): Promise<SetupState> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw) as SetupState;
  } catch {
    return {};
  }
}

async function writeState(state: SetupState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function readSettings(): Promise<ClaudeSettings | null> {
  try {
    const raw = await readFile(SETTINGS_FILE, "utf-8");
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return null;
  }
}

/**
 * Refresh both symlinks to point at the given cache version.
 * Uses unlink+symlink instead of `ln -sfn` to work without shell.
 */
async function refreshSymlinks(cacheVersion: string): Promise<void> {
  const statusLineTarget = join(
    CACHE_DIR,
    cacheVersion,
    "servers",
    "claude-bridge",
    "dist",
    "statusline.cjs",
  );
  const refreshLimitsTarget = join(
    CACHE_DIR,
    cacheVersion,
    "servers",
    "claude-bridge",
    "dist",
    "refresh-limits.cjs",
  );

  for (const [linkPath, target] of [
    [STATUSLINE_SYMLINK, statusLineTarget],
    [REFRESH_LIMITS_SYMLINK, refreshLimitsTarget],
  ] as const) {
    if (!existsSync(target)) {
      log.warn("setup_check_symlink_target_missing", { linkPath, target });
      continue;
    }
    try {
      // Best-effort remove existing link/file. Fails silently if absent.
      try {
        await unlink(linkPath);
      } catch {
        // ignore
      }
      await symlink(target, linkPath);
    } catch (e) {
      log.warn("setup_check_symlink_failed", {
        linkPath,
        target,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/**
 * Determine the user's ORIGINAL statusLine command — the one that was in
 * settings.json before the plugin ever touched it. Sources tried:
 *  1. State file (persisted on first run when we detect a non-plugin command)
 *  2. Fallback: heuristic — if settings.json currently points at our
 *     wrapper.sh, we don't have the original captured yet, return null.
 */
async function detectOriginalStatusLine(
  currentCommand: string | undefined,
  savedOriginal: string | undefined,
): Promise<string | null> {
  const looksLikeUs = (cmd: string | undefined): boolean =>
    !!cmd &&
    (cmd.includes("claude-bridge-statusline") || cmd.includes("claude-bridge-statusline-wrapper"));

  if (savedOriginal && !looksLikeUs(savedOriginal)) return savedOriginal;
  if (currentCommand && !looksLikeUs(currentCommand)) return currentCommand;
  return null;
}

/**
 * Write / refresh the wrapper shell script that sets
 * CLAUDE_BRIDGE_UNDERLYING_STATUSLINE and execs statusline.cjs.
 *
 * Safety: if `originalStatusLine` is null AND the wrapper file already
 * exists, don't overwrite it. Rationale — we don't want to clobber a
 * user's manual CLAUDE_BRIDGE_UNDERLYING_STATUSLINE setup when the state
 * file was cleared or when settings.json was already switched to our
 * wrapper before setup-check ever ran (chicken-and-egg on first install).
 */
async function writeWrapperScript(originalStatusLine: string | null): Promise<void> {
  if (originalStatusLine === null && existsSync(WRAPPER_SCRIPT)) {
    return;
  }
  const originalExport = originalStatusLine
    ? `export CLAUDE_BRIDGE_UNDERLYING_STATUSLINE="${originalStatusLine.replace(/"/g, '\\"')}"`
    : "# no underlying statusLine detected (setup-check found only plugin commands)\n" +
      "# to add one, set CLAUDE_BRIDGE_UNDERLYING_STATUSLINE below or edit settings.json";
  const body = `#!/bin/sh
# claude-bridge statusLine wrapper — auto-generated by setup-check hook.
# DO NOT EDIT MANUALLY — the SessionStart hook overwrites this file on
# every plugin update. To customize, edit ~/.claude/settings.json
# statusLine.command directly (which will disable auto-generation).
${originalExport}

exec node "${STATUSLINE_SYMLINK}"
`;
  await writeFile(WRAPPER_SCRIPT, body);
  await chmod(WRAPPER_SCRIPT, 0o755);
}

/**
 * Inspect settings.json to decide whether setup is complete.
 */
function isStatusLineConfigured(settings: ClaudeSettings | null): boolean {
  const cmd = settings?.statusLine?.command;
  if (!cmd) return false;
  return (
    cmd.includes("claude-bridge-statusline") || cmd.includes("claude-bridge-statusline-wrapper")
  );
}

function isHookConfigured(settings: ClaudeSettings | null): boolean {
  const groups = settings?.hooks?.PostToolUse ?? [];
  for (const group of groups) {
    for (const h of group.hooks ?? []) {
      if (h.command?.includes("claude-bridge-refresh-limits")) return true;
    }
  }
  return false;
}

function banner(state: {
  cacheVersion: string;
  statusLineConfigured: boolean;
  hookConfigured: boolean;
  isVersionChange: boolean;
}): string | null {
  const missing: string[] = [];
  if (!state.statusLineConfigured) missing.push("statusLine wrapper");
  if (!state.hookConfigured) missing.push("PostToolUse hook");

  if (missing.length === 0 && !state.isVersionChange) return null;

  const header = `━━━━━━━ claude-bridge v${state.cacheVersion} setup ━━━━━━━`;
  const footer = "━".repeat(header.length);
  const lines: string[] = [header];

  if (state.isVersionChange && missing.length === 0) {
    lines.push(`✓ Live-data hooks active. Symlinks refreshed for v${state.cacheVersion}.`);
    lines.push("");
    lines.push("What's new — see CHANGELOG.md in the plugin repo.");
    lines.push(footer);
    return lines.join("\n");
  }

  lines.push("⚠ Live-data setup incomplete. peer_context_status / rate_limit_status");
  lines.push("  will return `hasLiveData: false` until you finish setup.");
  lines.push("");
  lines.push(`Missing: ${missing.join(" + ")}`);
  lines.push("");
  lines.push("Add to ~/.claude/settings.json:");
  lines.push("");
  if (!state.statusLineConfigured) {
    lines.push('  "statusLine": {');
    lines.push('    "type": "command",');
    lines.push(`    "command": "${WRAPPER_SCRIPT.replace(homedir(), "~")}"`);
    lines.push("  },");
    lines.push("");
  }
  if (!state.hookConfigured) {
    lines.push('  "hooks": {');
    lines.push('    "PostToolUse": [{');
    lines.push('      "matcher": ".*",');
    lines.push('      "hooks": [{');
    lines.push('        "type": "command",');
    lines.push(`        "command": "node ${REFRESH_LIMITS_SYMLINK.replace(homedir(), "~")}",`);
    lines.push('        "timeout": 6');
    lines.push("      }]");
    lines.push("    }]");
    lines.push("  }");
    lines.push("");
  }
  lines.push("Full guide: docs/SETUP-LIVE-DATA.md in the claude-bridge repo.");
  lines.push(footer);
  return lines.join("\n");
}

export async function main(): Promise<number> {
  const cacheVersion = await findLatestCacheVersion();
  if (!cacheVersion) {
    log.warn("setup_check_no_cache_version");
    return 0;
  }

  await refreshSymlinks(cacheVersion);

  const [state, settings] = await Promise.all([readState(), readSettings()]);

  const statusLineConfigured = isStatusLineConfigured(settings);
  const hookConfigured = isHookConfigured(settings);

  const originalStatusLine = await detectOriginalStatusLine(
    settings?.statusLine?.command,
    state.originalStatusLine,
  );
  await writeWrapperScript(originalStatusLine);

  const isVersionChange =
    !state.lastBannerShownForVersion ||
    compareVersions(cacheVersion, state.lastBannerShownForVersion) > 0;

  const bannerText = banner({
    cacheVersion,
    statusLineConfigured,
    hookConfigured,
    isVersionChange: isVersionChange && statusLineConfigured && hookConfigured,
  });

  if (bannerText) {
    process.stderr.write(`\n${bannerText}\n\n`);
  }

  // Persist state.
  const nextState: SetupState = {
    pluginVersion: cacheVersion,
    lastBannerShownForVersion: bannerText ? cacheVersion : state.lastBannerShownForVersion,
    ...(originalStatusLine ? { originalStatusLine } : {}),
    statusLineConfigured,
    hookConfigured,
    lastCheckedAt: new Date().toISOString(),
  };
  try {
    await writeState(nextState);
  } catch (e) {
    log.warn("setup_check_state_write_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      log.error("setup_check_fatal", {
        err: e instanceof Error ? e.message : String(e),
      });
      process.exit(0); // must never block session start
    },
  );
}

// keep resolve, stat imported for future path validation
void resolve;
void stat;

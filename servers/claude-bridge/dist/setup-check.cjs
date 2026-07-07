"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/setup-check/main.ts
var main_exports = {};
__export(main_exports, {
  main: () => main
});
module.exports = __toCommonJS(main_exports);
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path2 = require("node:path");

// src/util/logger.ts
var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
var envLevel = process.env["LOG_LEVEL"] || "info";
var minLevel = LEVELS[envLevel] ?? LEVELS.info;
var pretty = process.env["LOG_FORMAT"] === "pretty";
function emit(level, component, msg, fields) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    component,
    msg,
    ...fields
  };
  const line = pretty ? `[${entry.ts}] ${level.toUpperCase()} (${component}) ${msg}${fields ? ` ${JSON.stringify(fields)}` : ""}` : JSON.stringify(entry);
  process.stderr.write(`${line}
`);
}
function makeLogger(component) {
  return {
    debug: (m, f) => emit("debug", component, m, f),
    info: (m, f) => emit("info", component, m, f),
    warn: (m, f) => emit("warn", component, m, f),
    error: (m, f) => emit("error", component, m, f),
    child: (c) => makeLogger(`${component}.${c}`)
  };
}

// src/util/paths.ts
var import_node_os = require("node:os");
var import_node_path = require("node:path");
function claudeHome() {
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude");
}
function bridgeRoot() {
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude-bridge");
}

// src/setup-check/main.ts
var log = makeLogger("setup-check");
var CACHE_DIR = (0, import_node_path2.join)(claudeHome(), "plugins", "cache", "claude-bridge", "claude-bridge");
var STATUSLINE_SYMLINK = (0, import_node_path2.join)(claudeHome(), "claude-bridge-statusline.cjs");
var REFRESH_LIMITS_SYMLINK = (0, import_node_path2.join)(claudeHome(), "claude-bridge-refresh-limits.cjs");
var WRAPPER_SCRIPT = (0, import_node_path2.join)(claudeHome(), "claude-bridge-statusline-wrapper.sh");
var STATE_FILE = (0, import_node_path2.join)(bridgeRoot(), "setup-state.json");
var SETTINGS_FILE = (0, import_node_path2.join)(claudeHome(), "settings.json");
function compareVersions(a, b) {
  const [aBase, aPre] = a.split("-", 2);
  const [bBase, bPre] = b.split("-", 2);
  const aParts = (aBase ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bParts = (bBase ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre.localeCompare(bPre);
  return 0;
}
async function findLatestCacheVersion() {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(CACHE_DIR);
    if (entries.length === 0) return null;
    return entries.sort(compareVersions).pop() ?? null;
  } catch {
    return null;
  }
}
async function readState() {
  try {
    const raw = await (0, import_promises.readFile)(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
async function writeState(state) {
  await (0, import_promises.mkdir)((0, import_node_path2.dirname)(STATE_FILE), { recursive: true });
  await (0, import_promises.writeFile)(STATE_FILE, `${JSON.stringify(state, null, 2)}
`);
}
async function readSettings() {
  try {
    const raw = await (0, import_promises.readFile)(SETTINGS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function refreshSymlinks(cacheVersion) {
  const statusLineTarget = (0, import_node_path2.join)(
    CACHE_DIR,
    cacheVersion,
    "servers",
    "claude-bridge",
    "dist",
    "statusline.cjs"
  );
  const refreshLimitsTarget = (0, import_node_path2.join)(
    CACHE_DIR,
    cacheVersion,
    "servers",
    "claude-bridge",
    "dist",
    "refresh-limits.cjs"
  );
  for (const [linkPath, target] of [
    [STATUSLINE_SYMLINK, statusLineTarget],
    [REFRESH_LIMITS_SYMLINK, refreshLimitsTarget]
  ]) {
    if (!(0, import_node_fs.existsSync)(target)) {
      log.warn("setup_check_symlink_target_missing", { linkPath, target });
      continue;
    }
    try {
      try {
        await (0, import_promises.unlink)(linkPath);
      } catch {
      }
      await (0, import_promises.symlink)(target, linkPath);
    } catch (e) {
      log.warn("setup_check_symlink_failed", {
        linkPath,
        target,
        err: e instanceof Error ? e.message : String(e)
      });
    }
  }
}
async function detectOriginalStatusLine(currentCommand, savedOriginal) {
  const looksLikeUs = (cmd) => !!cmd && (cmd.includes("claude-bridge-statusline") || cmd.includes("claude-bridge-statusline-wrapper"));
  if (savedOriginal && !looksLikeUs(savedOriginal)) return savedOriginal;
  if (currentCommand && !looksLikeUs(currentCommand)) return currentCommand;
  return null;
}
async function writeWrapperScript(originalStatusLine) {
  if (originalStatusLine === null && (0, import_node_fs.existsSync)(WRAPPER_SCRIPT)) {
    return;
  }
  const originalExport = originalStatusLine ? `export CLAUDE_BRIDGE_UNDERLYING_STATUSLINE="${originalStatusLine.replace(/"/g, '\\"')}"` : "# no underlying statusLine detected (setup-check found only plugin commands)\n# to add one, set CLAUDE_BRIDGE_UNDERLYING_STATUSLINE below or edit settings.json";
  const body = `#!/bin/sh
# claude-bridge statusLine wrapper \u2014 auto-generated by setup-check hook.
# DO NOT EDIT MANUALLY \u2014 the SessionStart hook overwrites this file on
# every plugin update. To customize, edit ~/.claude/settings.json
# statusLine.command directly (which will disable auto-generation).
${originalExport}

exec node "${STATUSLINE_SYMLINK}"
`;
  await (0, import_promises.writeFile)(WRAPPER_SCRIPT, body);
  await (0, import_promises.chmod)(WRAPPER_SCRIPT, 493);
}
function isStatusLineConfigured(settings) {
  const cmd = settings?.statusLine?.command;
  if (!cmd) return false;
  return cmd.includes("claude-bridge-statusline") || cmd.includes("claude-bridge-statusline-wrapper");
}
function isHookConfigured(settings) {
  const groups = settings?.hooks?.PostToolUse ?? [];
  for (const group of groups) {
    for (const h of group.hooks ?? []) {
      if (h.command?.includes("claude-bridge-refresh-limits")) return true;
    }
  }
  return false;
}
function banner(state) {
  const missing = [];
  if (!state.statusLineConfigured) missing.push("statusLine wrapper");
  if (!state.hookConfigured) missing.push("PostToolUse hook");
  if (missing.length === 0 && !state.isVersionChange) return null;
  const header = `\u2501\u2501\u2501\u2501\u2501\u2501\u2501 claude-bridge v${state.cacheVersion} setup \u2501\u2501\u2501\u2501\u2501\u2501\u2501`;
  const footer = "\u2501".repeat(header.length);
  const lines = [header];
  if (state.isVersionChange && missing.length === 0) {
    lines.push(`\u2713 Live-data hooks active. Symlinks refreshed for v${state.cacheVersion}.`);
    lines.push("");
    lines.push("What's new \u2014 see CHANGELOG.md in the plugin repo.");
    lines.push(footer);
    return lines.join("\n");
  }
  lines.push("\u26A0 Live-data setup incomplete. peer_context_status / rate_limit_status");
  lines.push("  will return `hasLiveData: false` until you finish setup.");
  lines.push("");
  lines.push(`Missing: ${missing.join(" + ")}`);
  lines.push("");
  lines.push("Add to ~/.claude/settings.json:");
  lines.push("");
  if (!state.statusLineConfigured) {
    lines.push('  "statusLine": {');
    lines.push('    "type": "command",');
    lines.push(`    "command": "${WRAPPER_SCRIPT.replace((0, import_node_os2.homedir)(), "~")}"`);
    lines.push("  },");
    lines.push("");
  }
  if (!state.hookConfigured) {
    lines.push('  "hooks": {');
    lines.push('    "PostToolUse": [{');
    lines.push('      "matcher": ".*",');
    lines.push('      "hooks": [{');
    lines.push('        "type": "command",');
    lines.push(`        "command": "node ${REFRESH_LIMITS_SYMLINK.replace((0, import_node_os2.homedir)(), "~")}",`);
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
async function main() {
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
    state.originalStatusLine
  );
  await writeWrapperScript(originalStatusLine);
  const isVersionChange = !state.lastBannerShownForVersion || compareVersions(cacheVersion, state.lastBannerShownForVersion) > 0;
  const bannerText = banner({
    cacheVersion,
    statusLineConfigured,
    hookConfigured,
    isVersionChange: isVersionChange && statusLineConfigured && hookConfigured
  });
  if (bannerText) {
    process.stderr.write(`
${bannerText}

`);
  }
  const nextState = {
    pluginVersion: cacheVersion,
    lastBannerShownForVersion: bannerText ? cacheVersion : state.lastBannerShownForVersion,
    ...originalStatusLine ? { originalStatusLine } : {},
    statusLineConfigured,
    hookConfigured,
    lastCheckedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    await writeState(nextState);
  } catch (e) {
    log.warn("setup_check_state_write_failed", {
      err: e instanceof Error ? e.message : String(e)
    });
  }
  return 0;
}
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      log.error("setup_check_fatal", {
        err: e instanceof Error ? e.message : String(e)
      });
      process.exit(0);
    }
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  main
});

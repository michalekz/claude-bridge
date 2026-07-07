"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/statusline/main.ts
var main_exports = {};
__export(main_exports, {
  main: () => main
});
module.exports = __toCommonJS(main_exports);
var import_node_child_process = require("node:child_process");
var import_node_os2 = require("node:os");

// src/parser/live-data.ts
var import_promises2 = require("node:fs/promises");
var import_node_path3 = require("node:path");

// src/util/atomic-write.ts
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var DEFAULT_RETRIES = 5;
var DEFAULT_RETRY_DELAY_MS = 50;
var RETRYABLE_CODES = /* @__PURE__ */ new Set(["EBUSY", "EPERM", "EACCES", "EEXIST"]);
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isRetryable(error) {
  if (typeof error !== "object" || error === null) return false;
  const code = error.code;
  return code !== void 0 && RETRYABLE_CODES.has(code);
}
function tempPath(targetPath) {
  const dir = (0, import_node_path.dirname)(targetPath);
  const suffix = (0, import_node_crypto.randomBytes)(8).toString("hex");
  return (0, import_node_path.join)(dir, `.${suffix}.tmp`);
}
async function atomicWrite(targetPath, content, options = {}) {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const encoding = options.encoding ?? "utf-8";
  const ensureDir = options.ensureDir ?? true;
  if (ensureDir) {
    await (0, import_promises.mkdir)((0, import_node_path.dirname)(targetPath), { recursive: true });
  }
  const tmp = tempPath(targetPath);
  try {
    if (typeof content === "string") {
      await (0, import_promises.writeFile)(tmp, content, encoding);
    } else {
      await (0, import_promises.writeFile)(tmp, content);
    }
  } catch (writeErr) {
    await (0, import_promises.unlink)(tmp).catch(() => void 0);
    throw writeErr;
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await (0, import_promises.rename)(tmp, targetPath);
      return;
    } catch (e) {
      lastError = e;
      if (!isRetryable(e) || attempt === retries) {
        await (0, import_promises.unlink)(tmp).catch(() => void 0);
        throw e;
      }
      const delay = baseDelay * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw lastError;
}
async function atomicWriteJson(targetPath, value, options) {
  const content = `${JSON.stringify(value, null, 2)}
`;
  return atomicWrite(targetPath, content, options);
}

// src/util/paths.ts
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");
function bridgeRoot() {
  return (0, import_node_path2.join)((0, import_node_os.homedir)(), ".claude-bridge");
}

// src/parser/live-data.ts
function liveDir() {
  return (0, import_node_path3.join)(bridgeRoot(), "live");
}
function statusLineLivePath() {
  return (0, import_node_path3.join)(liveDir(), "statusline.json");
}
async function writeStatusLineLive(envelope) {
  await (0, import_promises2.mkdir)((0, import_node_path3.dirname)(statusLineLivePath()), { recursive: true });
  await atomicWriteJson(statusLineLivePath(), envelope);
}

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

// src/statusline/main.ts
var log = makeLogger("statusline-wrapper");
async function readAllStdin() {
  return new Promise((resolve2, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve2(data));
    process.stdin.on("error", reject);
  });
}
function extractSessionId(payload) {
  const fromEnv = process.env["CLAUDE_CODE_SESSION_ID"];
  if (fromEnv) return fromEnv;
  const cwd = payload.cwd ?? "unknown-cwd";
  return `unknown-${cwd.replace(/[^a-zA-Z0-9]/g, "-").slice(-40)}`;
}
async function captureLive(parsed) {
  const envelope = {
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessionId: parsed.sessionId,
    payload: parsed.payload
  };
  try {
    await writeStatusLineLive(envelope);
  } catch (e) {
    log.warn("statusline_live_write_failed", {
      err: e instanceof Error ? e.message : String(e)
    });
  }
}
async function passthrough(underlying, stdinRaw) {
  return new Promise((resolve2) => {
    const isWin = (0, import_node_os2.platform)() === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", underlying] : ["-c", underlying];
    let child;
    try {
      child = (0, import_node_child_process.spawn)(shell, args, {
        stdio: ["pipe", "pipe", "inherit"]
      });
    } catch (e) {
      log.warn("statusline_passthrough_spawn_failed", {
        underlying,
        err: e instanceof Error ? e.message : String(e)
      });
      resolve2(0);
      return;
    }
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    child.on("error", (e) => {
      log.warn("statusline_passthrough_child_error", {
        underlying,
        err: e instanceof Error ? e.message : String(e)
      });
      resolve2(0);
    });
    child.on("exit", (code) => {
      resolve2(code ?? 0);
    });
    try {
      child.stdin?.write(stdinRaw);
      child.stdin?.end();
    } catch (e) {
      log.warn("statusline_passthrough_stdin_write_failed", {
        err: e instanceof Error ? e.message : String(e)
      });
    }
  });
}
async function main() {
  const stdinRaw = await readAllStdin();
  if (!stdinRaw.trim()) {
    process.stderr.write(
      "claude-bridge-statusline: expected JSON on stdin from Claude Code.\nSee docs/SETUP-LIVE-DATA.md for install instructions.\n"
    );
    return 0;
  }
  let parsed = null;
  let sessionId = "unknown";
  try {
    const p = JSON.parse(stdinRaw);
    if (typeof p === "object" && p !== null) {
      parsed = p;
      sessionId = extractSessionId(p);
    }
  } catch (e) {
    log.warn("statusline_parse_failed", {
      err: e instanceof Error ? e.message : String(e)
    });
  }
  const capturePromise = parsed ? captureLive({ payload: parsed, sessionId }) : Promise.resolve();
  const underlying = process.env["CLAUDE_BRIDGE_UNDERLYING_STATUSLINE"];
  let exitCode = 0;
  if (underlying) {
    exitCode = await passthrough(underlying, stdinRaw);
  }
  await capturePromise;
  return exitCode;
}
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      log.error("statusline_wrapper_fatal", {
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

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

// src/refresh-limits/main.ts
var main_exports = {};
__export(main_exports, {
  main: () => main
});
module.exports = __toCommonJS(main_exports);
var import_node_child_process2 = require("node:child_process");
var import_promises4 = require("node:fs/promises");
var import_node_path5 = require("node:path");

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
function claudeHome() {
  return (0, import_node_path2.join)((0, import_node_os.homedir)(), ".claude");
}
function bridgeRoot() {
  return (0, import_node_path2.join)((0, import_node_os.homedir)(), ".claude-bridge");
}

// src/parser/live-data.ts
function liveDir() {
  return (0, import_node_path3.join)(bridgeRoot(), "live");
}
function oauthLivePath() {
  return (0, import_node_path3.join)(liveDir(), "oauth-api.json");
}
async function writeOAuthApiLive(envelope) {
  await (0, import_promises2.mkdir)((0, import_node_path3.dirname)(oauthLivePath()), { recursive: true });
  await atomicWriteJson(oauthLivePath(), envelope);
}

// src/parser/oauth-token.ts
var import_node_child_process = require("node:child_process");
var import_promises3 = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path4 = require("node:path");
var import_node_util = require("node:util");
function credentialsPath() {
  return (0, import_node_path4.join)(claudeHome(), ".credentials.json");
}
async function readTokenFromFile() {
  try {
    const raw = await (0, import_promises3.readFile)(credentialsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || token.length === 0) return null;
    return token;
  } catch {
    return null;
  }
}
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
async function readTokenFromKeychain() {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5e3, encoding: "utf-8" }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || token.length === 0) return null;
    return token;
  } catch {
    return null;
  }
}
async function readOAuthToken() {
  if ((0, import_node_os2.platform)() === "darwin") {
    const fromKeychain = await readTokenFromKeychain();
    if (fromKeychain) return fromKeychain;
  }
  return readTokenFromFile();
}
function isTokenSafeForHeader(token) {
  return /^[a-zA-Z0-9\-._~+/=]+$/.test(token);
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

// src/refresh-limits/main.ts
var log = makeLogger("refresh-limits");
var THROTTLE_SECONDS = 60;
var OAUTH_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
var USER_AGENT = "claude-bridge/0.9.0-alpha";
var BETA_HEADER = "anthropic-beta: oauth-2025-04-20";
var CURL_TIMEOUT_SECONDS = 5;
function throttleMarkerPath() {
  return (0, import_node_path5.join)(liveDir(), "last-oauth-refresh");
}
async function shouldThrottle(now = /* @__PURE__ */ new Date()) {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(throttleMarkerPath());
    const ageSeconds = (now.getTime() - s.mtimeMs) / 1e3;
    return ageSeconds < THROTTLE_SECONDS;
  } catch {
    return false;
  }
}
async function touchThrottleMarker() {
  const path = throttleMarkerPath();
  await (0, import_promises4.mkdir)((0, import_node_path5.dirname)(path), { recursive: true });
  await (0, import_promises4.writeFile)(path, `${(/* @__PURE__ */ new Date()).toISOString()}
`);
}
async function fetchUsageViaCurl(token) {
  return new Promise((resolve2) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let child;
    try {
      child = (0, import_node_child_process2.spawn)(
        "curl",
        [
          "-s",
          "-f",
          "--config",
          "-",
          "-H",
          "Accept: application/json",
          "-H",
          "Content-Type: application/json",
          "-H",
          `User-Agent: ${USER_AGENT}`,
          "-H",
          BETA_HEADER,
          "--max-time",
          String(CURL_TIMEOUT_SECONDS),
          OAUTH_ENDPOINT
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (e) {
      log.warn("refresh_limits_curl_spawn_failed", {
        err: e instanceof Error ? e.message : String(e)
      });
      resolve2(null);
      return;
    }
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });
    child.on("error", () => resolve2(null));
    child.on("exit", (code) => {
      if (code !== 0) {
        log.warn("refresh_limits_curl_nonzero", {
          exitCode: code,
          stderr: stderrBuf.slice(0, 200)
        });
        resolve2(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdoutBuf);
        resolve2(parsed);
      } catch (e) {
        log.warn("refresh_limits_response_parse_failed", {
          err: e instanceof Error ? e.message : String(e)
        });
        resolve2(null);
      }
    });
    try {
      child.stdin?.write(`header = "Authorization: Bearer ${token}"
`);
      child.stdin?.end();
    } catch (e) {
      log.warn("refresh_limits_stdin_write_failed", {
        err: e instanceof Error ? e.message : String(e)
      });
    }
  });
}
async function drainStdin() {
  return new Promise((resolve2) => {
    process.stdin.on("data", () => void 0);
    process.stdin.on("end", () => resolve2());
    process.stdin.on("error", () => resolve2());
  });
}
async function main() {
  const stdinDrained = drainStdin();
  if (await shouldThrottle()) {
    await stdinDrained;
    return 0;
  }
  const token = await readOAuthToken();
  if (!token) {
    log.warn("refresh_limits_no_token");
    await stdinDrained;
    return 0;
  }
  if (!isTokenSafeForHeader(token)) {
    log.warn("refresh_limits_token_unsafe_chars");
    await stdinDrained;
    return 0;
  }
  const data = await fetchUsageViaCurl(token);
  if (data === null) {
    await stdinDrained;
    return 0;
  }
  const envelope = {
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    data
  };
  try {
    await writeOAuthApiLive(envelope);
    await touchThrottleMarker();
  } catch (e) {
    log.warn("refresh_limits_write_failed", {
      err: e instanceof Error ? e.message : String(e)
    });
  }
  await stdinDrained;
  return 0;
}
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      log.error("refresh_limits_fatal", {
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

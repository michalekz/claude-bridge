#!/usr/bin/env node
"use strict";

// src/index.ts
var import_promises8 = require("node:fs/promises");

// ../../packages/shared/src/atomic-write.ts
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
  const ensureDir2 = options.ensureDir ?? true;
  if (ensureDir2) {
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

// ../../packages/shared/src/logger.ts
var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
var envLevel = process.env["LOG_LEVEL"] || "info";
var minLevel = LEVELS[envLevel] ?? LEVELS.info;
var pretty = process.env["LOG_FORMAT"] === "pretty";
function emit(level, component, msg, fields) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    pid: process.pid,
    component,
    msg,
    ...fields
  };
  const line = pretty ? `[${entry.ts}] ${level.toUpperCase()} pid=${entry.pid} (${component}) ${msg}${fields ? ` ${JSON.stringify(fields)}` : ""}` : JSON.stringify(entry);
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

// ../../packages/shared/src/paths.ts
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");
function bridgeRoot() {
  return (0, import_node_path2.join)((0, import_node_os.homedir)(), ".claude-bridge");
}

// ../../packages/shared/src/control-paths.ts
var import_node_path3 = require("node:path");
function controlDir() {
  return (0, import_node_path3.join)(bridgeRoot(), "control");
}
function daemonLockPath() {
  return (0, import_node_path3.join)(controlDir(), "daemon.lock");
}
function stateFilePath() {
  return (0, import_node_path3.join)(controlDir(), "state.json");
}
function eventsFilePath() {
  return (0, import_node_path3.join)(controlDir(), "events.jsonl");
}
function requestsDir() {
  return (0, import_node_path3.join)(controlDir(), "requests");
}
function requestsDoneDir() {
  return (0, import_node_path3.join)(requestsDir(), "done");
}
function requestPath(requestId) {
  return (0, import_node_path3.join)(requestsDir(), `${requestId}.json`);
}
function requestDonePath(requestId) {
  return (0, import_node_path3.join)(requestsDoneDir(), `${requestId}.json`);
}
function resultsDir() {
  return (0, import_node_path3.join)(controlDir(), "results");
}
function resultPath(requestId) {
  return (0, import_node_path3.join)(resultsDir(), `${requestId}.json`);
}
function heartbeatPath() {
  return (0, import_node_path3.join)(controlDir(), "heartbeat");
}

// src/events.ts
var import_promises2 = require("node:fs/promises");
var import_node_path4 = require("node:path");
var log = makeLogger("daemon.events");
var EVENTS_SCHEMA_VERSION = 1;
var ensured = false;
async function ensureDir() {
  if (ensured) return;
  await (0, import_promises2.mkdir)((0, import_node_path4.dirname)(eventsFilePath()), { recursive: true });
  ensured = true;
}
async function writeEvent(evt) {
  try {
    await ensureDir();
    const wire = {
      schemaVersion: EVENTS_SCHEMA_VERSION,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      pid: process.pid,
      level: evt.level ?? "info",
      event: evt.event,
      by: evt.by ?? null,
      requestId: evt.requestId ?? null,
      details: evt.details ?? {}
    };
    await (0, import_promises2.appendFile)(eventsFilePath(), `${JSON.stringify(wire)}
`, "utf-8");
  } catch (e) {
    log.error("event_write_failed", { event: evt.event, err: String(e) });
  }
}
async function writeDaemonEvent(event, details = {}, level = "info") {
  await writeEvent({
    event,
    level,
    by: { sessionId: null, name: "daemon" },
    details
  });
}

// src/rpc.ts
var import_promises3 = require("node:fs/promises");
var log2 = makeLogger("daemon.rpc");
var REQUEST_SCHEMA_VERSION = 1;
async function ensureRpcDirs() {
  await (0, import_promises3.mkdir)(requestsDir(), { recursive: true });
  await (0, import_promises3.mkdir)(requestsDoneDir(), { recursive: true });
  await (0, import_promises3.mkdir)(resultsDir(), { recursive: true });
}
async function listPendingRequests() {
  try {
    const files = await (0, import_promises3.readdir)(requestsDir());
    return files.filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return [];
    log2.warn("requests_list_error", { err: String(e) });
    return [];
  }
}
async function readRequest(fileName) {
  const requestId = fileName.replace(/\.json$/, "");
  try {
    const raw = await (0, import_promises3.readFile)(requestPath(requestId), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.id || !parsed.tool) {
      log2.warn("request_invalid_shape", { fileName });
      return null;
    }
    return parsed;
  } catch (e) {
    log2.warn("request_read_error", { fileName, err: String(e) });
    return null;
  }
}
async function markRequestDone(requestId) {
  try {
    await (0, import_promises3.rename)(requestPath(requestId), requestDonePath(requestId));
  } catch (e) {
    log2.warn("request_mark_done_failed", { requestId, err: String(e) });
  }
}
async function writeResult(res) {
  await atomicWriteJson(resultPath(res.id), res);
}
function okResult(id, tool, data) {
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    id,
    tool,
    outcome: "ok",
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    data
  };
}
function errResult(id, tool, code, message, details) {
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    id,
    tool,
    outcome: "error",
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    error: { code, message, details }
  };
}

// src/handlers.ts
async function handlePeerStop(req, ctx) {
  const peer = String(req.args["peer"] ?? "");
  if (!peer) {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { reason: "missing_peer_arg" }
    });
    return errResult(req.id, req.tool, "missing_arg", "`peer` argument is required");
  }
  const record = ctx.state.peers[peer];
  if (!record) {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "info",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { peer, reason: "peer_not_found" }
    });
    return errResult(req.id, req.tool, "peer_not_found", `No peer with id/name '${peer}' in daemon state`, {
      peer
    });
  }
  await writeEvent({
    event: "peer_stop_stub",
    level: "warn",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { peer, hostDriver: record.hostDriver, note: "full stop wired in v0.10.0-beta" }
  });
  return errResult(
    req.id,
    req.tool,
    "not_implemented_in_alpha",
    "peer_stop is a stub in v0.10.0-alpha; full lifecycle implementation lands in v0.10.0-beta",
    { peer }
  );
}
async function handleControlStatus(req, ctx) {
  return okResult(req.id, req.tool, {
    daemonVersion: ctx.daemonVersion,
    daemonStartedAt: ctx.state.daemonStartedAt,
    stateVersion: ctx.state.stateVersion,
    peerCount: Object.keys(ctx.state.peers).length
  });
}
var HANDLERS = {
  peer_stop: handlePeerStop,
  control_status: handleControlStatus
};
async function dispatch(req, ctx) {
  const handler = HANDLERS[req.tool];
  if (!handler) {
    await writeEvent({
      event: "request_unknown_tool",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { tool: req.tool }
    });
    return errResult(req.id, req.tool, "unknown_tool", `No handler for tool '${req.tool}'`, {
      supported: Object.keys(HANDLERS)
    });
  }
  return handler(req, ctx);
}

// src/heartbeat.ts
var import_promises4 = require("node:fs/promises");
var log3 = makeLogger("daemon.heartbeat");
var timer = null;
async function touch() {
  const now = /* @__PURE__ */ new Date();
  try {
    await (0, import_promises4.utimes)(heartbeatPath(), now, now);
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") {
      await (0, import_promises4.writeFile)(heartbeatPath(), "");
    } else {
      log3.warn("heartbeat_touch_failed", { err: String(e) });
    }
  }
}
async function startHeartbeat(intervalMs = 5e3) {
  await touch();
  timer = setInterval(() => {
    void touch();
  }, intervalMs);
  timer.unref();
}
function stopHeartbeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// src/lock.ts
var import_promises5 = require("node:fs/promises");
var import_node_fs = require("node:fs");
var log4 = makeLogger("daemon.lock");
var LockAcquireError = class extends Error {
  constructor(message, heldBy) {
    super(message);
    this.heldBy = heldBy;
    this.name = "LockAcquireError";
  }
};
function readProcStart(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat3 = (0, import_node_fs.readFileSync)(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat3.slice(stat3.lastIndexOf(")") + 1).trim();
    const fields = afterComm.split(/\s+/);
    const starttime = fields[19];
    return starttime ?? null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = e.code;
    return code === "EPERM";
  }
}
function isStale(payload) {
  if (!isProcessAlive(payload.pid)) return true;
  if (process.platform === "linux" && payload.procStart) {
    const currentStart = readProcStart(payload.pid);
    if (currentStart !== null && currentStart !== payload.procStart) return true;
  }
  return false;
}
async function readLock() {
  try {
    const raw = await (0, import_promises5.readFile)(daemonLockPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return null;
    log4.warn("lock_read_error", { code, err: String(e) });
    return null;
  }
}
async function acquireLock() {
  const existing = await readLock();
  if (existing) {
    if (isStale(existing)) {
      log4.warn("lock_takeover_stale", { heldBy: existing });
    } else {
      throw new LockAcquireError(
        `daemon.lock held by live pid ${existing.pid} (started ${existing.startedAt})`,
        existing
      );
    }
  }
  const payload = {
    pid: process.pid,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    procStart: readProcStart(process.pid)
  };
  await atomicWriteJson(daemonLockPath(), payload);
  log4.info("lock_acquired", { pid: payload.pid });
  return payload;
}
async function releaseLock() {
  try {
    await (0, import_promises5.unlink)(daemonLockPath());
    log4.info("lock_released");
  } catch (e) {
    const code = e.code;
    if (code !== "ENOENT") log4.warn("lock_release_error", { code, err: String(e) });
  }
}

// src/state.ts
var import_promises6 = require("node:fs/promises");
var log5 = makeLogger("daemon.state");
var STATE_VERSION = 1;
var StateVersionMismatch = class extends Error {
  constructor(onDisk, supported) {
    super(
      `state.json stateVersion=${onDisk} exceeds daemon-supported ${supported}; rollback path is not supported \u2014 upgrade or wipe the state file explicitly`
    );
    this.onDisk = onDisk;
    this.supported = supported;
    this.name = "StateVersionMismatch";
  }
};
function emptyState(daemonVersion) {
  return {
    stateVersion: STATE_VERSION,
    daemonVersion,
    daemonStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
    peers: {}
  };
}
async function loadState(daemonVersion) {
  try {
    const raw = await (0, import_promises6.readFile)(stateFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    const onDisk = parsed.stateVersion ?? 0;
    if (onDisk > STATE_VERSION) throw new StateVersionMismatch(onDisk, STATE_VERSION);
    if (onDisk < STATE_VERSION) {
      log5.warn("state_migration_needed", { onDisk, target: STATE_VERSION });
      return emptyState(daemonVersion);
    }
    const doc = {
      stateVersion: STATE_VERSION,
      daemonVersion,
      daemonStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
      peers: parsed.peers ?? {}
    };
    return doc;
  } catch (e) {
    if (e instanceof StateVersionMismatch) throw e;
    const code = e.code;
    if (code === "ENOENT") {
      log5.info("state_missing_bootstrap");
      return emptyState(daemonVersion);
    }
    log5.error("state_load_error", { err: String(e) });
    throw e;
  }
}
async function saveState(doc) {
  await atomicWriteJson(stateFilePath(), doc);
}

// src/daemon.ts
var log6 = makeLogger("daemon");
var POLL_INTERVAL_MS = 250;
async function runDaemon(opts) {
  try {
    await acquireLock();
  } catch (e) {
    if (e instanceof LockAcquireError) {
      log6.error("lock_held_by_another_daemon", {
        heldBy: e.heldBy
      });
      process.exitCode = 3;
      return;
    }
    throw e;
  }
  await ensureRpcDirs();
  const state = await loadState(opts.daemonVersion);
  await saveState(state);
  await writeDaemonEvent("daemon_started", {
    daemonVersion: opts.daemonVersion,
    pid: process.pid,
    stateVersion: state.stateVersion,
    peerCount: Object.keys(state.peers).length
  });
  await startHeartbeat();
  let stopping = false;
  let pollTimer = null;
  const shutdown = async (signal, code = 0) => {
    if (stopping) return;
    stopping = true;
    if (pollTimer) clearInterval(pollTimer);
    stopHeartbeat();
    await writeDaemonEvent("daemon_stopping", { signal });
    await releaseLock();
    await writeDaemonEvent("daemon_stopped", { signal });
    process.exitCode = code;
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => {
    log6.info("sighup_reload_stub", { note: "config reload lands in v0.10.0-beta" });
  });
  process.on("SIGPIPE", () => void 0);
  const processQueue = async () => {
    if (stopping) return;
    const pending = await listPendingRequests();
    for (const fileName of pending) {
      if (stopping) return;
      const req = await readRequest(fileName);
      if (!req) {
        const badId = fileName.replace(/\.json$/, "");
        await markRequestDone(badId);
        await writeEvent({
          event: "request_malformed",
          level: "warn",
          requestId: badId
        });
        continue;
      }
      await writeEvent({
        event: "request_received",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { tool: req.tool }
      });
      const result = await dispatch(req, { state, daemonVersion: opts.daemonVersion });
      await writeResult(result);
      await markRequestDone(req.id);
      await writeEvent({
        event: "request_completed",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { tool: req.tool, outcome: result.outcome }
      });
    }
  };
  if (opts.once) {
    await processQueue();
    await shutdown("once");
    return;
  }
  pollTimer = setInterval(() => {
    void processQueue().catch((e) => log6.error("queue_error", { err: String(e) }));
  }, POLL_INTERVAL_MS);
}

// src/install.ts
var import_node_child_process = require("node:child_process");
var import_promises7 = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path5 = require("node:path");
var log7 = makeLogger("daemon.install");
var UNIT_NAME = "claude-bridge-daemon.service";
function systemdUserDir() {
  return (0, import_node_path5.join)((0, import_node_os2.homedir)(), ".config", "systemd", "user");
}
function unitPath() {
  return (0, import_node_path5.join)(systemdUserDir(), UNIT_NAME);
}
function assertLinux() {
  if (process.platform !== "linux") {
    throw new Error(
      `claude-bridge-daemon install --systemd is Linux-only in v0.10.0-alpha. macOS launchd and Windows Task Scheduler ship in v0.10.0 F3.`
    );
  }
}
function resolveDaemonBin() {
  const argv1 = process.argv[1];
  if (!argv1) throw new Error("process.argv[1] missing \u2014 cannot determine daemon binary path");
  if (!argv1.startsWith("/")) return (0, import_node_path5.resolve)(process.cwd(), argv1);
  return argv1;
}
async function readTemplate() {
  const anchor = resolveDaemonBin();
  const anchorDir = (0, import_node_path5.dirname)(anchor);
  const candidates = [
    (0, import_node_path5.resolve)(anchorDir, "..", "templates", UNIT_NAME),
    (0, import_node_path5.resolve)(anchorDir, "templates", UNIT_NAME)
  ];
  for (const candidate of candidates) {
    try {
      return await (0, import_promises7.readFile)(candidate, "utf-8");
    } catch {
    }
  }
  throw new Error(`Systemd unit template not found (looked in ${candidates.join(", ")})`);
}
function findNodeBin() {
  return process.execPath;
}
async function installSystemd() {
  assertLinux();
  const daemonBin = resolveDaemonBin();
  const nodeBin = findNodeBin();
  await ensureBinariesExist(daemonBin, nodeBin);
  const template = await readTemplate();
  const rendered = template.replace(/__NODE_BIN__/g, nodeBin).replace(/__DAEMON_BIN__/g, daemonBin);
  await (0, import_promises7.mkdir)(systemdUserDir(), { recursive: true });
  await (0, import_promises7.writeFile)(unitPath(), rendered, "utf-8");
  log7.info("unit_written", { path: unitPath() });
  runSystemctl("daemon-reload");
  runSystemctl("enable", UNIT_NAME);
  runSystemctl("start", UNIT_NAME);
  log7.info("daemon_started_via_systemd");
}
async function uninstallSystemd() {
  assertLinux();
  try {
    runSystemctl("stop", UNIT_NAME);
  } catch (e) {
    log7.warn("systemd_stop_failed", { err: String(e) });
  }
  try {
    runSystemctl("disable", UNIT_NAME);
  } catch (e) {
    log7.warn("systemd_disable_failed", { err: String(e) });
  }
  try {
    await (0, import_promises7.unlink)(unitPath());
  } catch (e) {
    const code = e.code;
    if (code !== "ENOENT") log7.warn("unit_unlink_failed", { err: String(e) });
  }
  runSystemctl("daemon-reload");
  log7.info("uninstalled");
}
function runSystemctl(...args) {
  (0, import_node_child_process.execFileSync)("systemctl", ["--user", ...args], { stdio: "inherit" });
}
async function ensureBinariesExist(daemonBin, nodeBin) {
  for (const [label, path] of [
    ["daemon", daemonBin],
    ["node", nodeBin]
  ]) {
    try {
      await (0, import_promises7.stat)(path);
    } catch {
      throw new Error(`${label} binary not found at ${path} \u2014 build daemon first (npm run build)`);
    }
  }
}

// package.json
var package_default = {
  name: "claude-bridge-daemon",
  version: "0.10.0-alpha.0",
  private: true,
  description: "Control-plane daemon for the claude-bridge plugin: peer lifecycle, telemetry, audit. Distributed as opt-in artefact \u2014 see ADR-008.",
  type: "module",
  main: "dist/daemon.cjs",
  bin: {
    "claude-bridge-daemon": "dist/daemon.cjs"
  },
  scripts: {
    build: "esbuild src/index.ts --bundle --platform=node --target=node18 --format=cjs --outfile=dist/daemon.cjs --banner:js='#!/usr/bin/env node' --loader:.json=json && mkdir -p templates && cp src/templates/claude-bridge-daemon.service templates/",
    dev: "tsx --watch src/index.ts",
    start: "node dist/daemon.cjs",
    test: "vitest run tests/",
    "test:watch": "vitest tests/",
    typecheck: "tsc --noEmit",
    check: "biome check src tests"
  },
  dependencies: {
    "@claude-bridge/shared": "*",
    zod: "^3.23.8"
  },
  devDependencies: {
    "@biomejs/biome": "^1.9.4",
    "@types/node": "^22.9.0",
    esbuild: "^0.24.0",
    tsx: "^4.19.2",
    typescript: "^5.6.3",
    vitest: "^2.1.8"
  },
  engines: {
    node: ">=18"
  }
};

// src/index.ts
var log8 = makeLogger("daemon.cli");
var DAEMON_VERSION = package_default.version;
var HELP = `claude-bridge-daemon ${DAEMON_VERSION}

Commands:
  run                Run the daemon in the foreground (used by systemd)
  install --systemd  Install and start as a systemd --user service (Linux)
  uninstall --systemd
                     Stop, disable, and remove the systemd --user service
  status             Print daemon lock + heartbeat freshness
  version            Print the daemon version
  help               Print this message
`;
async function statusCommand() {
  const lock = await readLock();
  let heartbeatAgeMs = null;
  try {
    const s = await (0, import_promises8.stat)(heartbeatPath());
    heartbeatAgeMs = Date.now() - s.mtimeMs;
  } catch {
    heartbeatAgeMs = null;
  }
  const alive = lock !== null && heartbeatAgeMs !== null && heartbeatAgeMs < 3e4;
  const report = {
    daemonVersion: DAEMON_VERSION,
    alive,
    lock,
    heartbeatAgeMs
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
  process.exitCode = alive ? 0 : 1;
}
async function main(argv) {
  const cmd = argv[0] ?? "help";
  switch (cmd) {
    case "run": {
      await runDaemon({ daemonVersion: DAEMON_VERSION });
      return;
    }
    case "install": {
      if (argv[1] !== "--systemd") {
        process.stderr.write(`install requires --systemd flag
${HELP}`);
        process.exitCode = 2;
        return;
      }
      await installSystemd();
      return;
    }
    case "uninstall": {
      if (argv[1] !== "--systemd") {
        process.stderr.write(`uninstall requires --systemd flag
${HELP}`);
        process.exitCode = 2;
        return;
      }
      await uninstallSystemd();
      return;
    }
    case "status": {
      await statusCommand();
      return;
    }
    case "version": {
      process.stdout.write(`${DAEMON_VERSION}
`);
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(HELP);
      return;
    }
    default: {
      process.stderr.write(`Unknown command: ${cmd}
${HELP}`);
      process.exitCode = 2;
    }
  }
}
main(process.argv.slice(2)).catch((e) => {
  log8.error("cli_fatal", { err: String(e) });
  process.exitCode = 1;
});

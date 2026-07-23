/**
 * Structured NDJSON logger with pid trace.
 *
 * IMPORTANT: writes to stderr only. stdout is reserved for the MCP
 * JSON-RPC channel (in the MCP server) — mixing corrupts the protocol.
 *
 * Each entry carries `pid` so multiple concurrent processes (e.g. the
 * daemon, its child spawns, and the MCP server) can be disentangled in
 * a merged log stream (v0.9.3 lesson).
 *
 * LOG_LEVEL (env): "debug" | "info" | "warn" | "error" — default "info".
 * LOG_FORMAT=pretty — human-readable stderr instead of NDJSON.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (process.env["LOG_LEVEL"] as Level) || "info";
const minLevel = LEVELS[envLevel] ?? LEVELS.info;
const pretty = process.env["LOG_FORMAT"] === "pretty";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(component: string): Logger;
}

function emit(level: Level, component: string, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    pid: process.pid,
    component,
    msg,
    ...fields,
  };
  const line = pretty
    ? `[${entry.ts}] ${level.toUpperCase()} pid=${entry.pid} (${component}) ${msg}${
        fields ? ` ${JSON.stringify(fields)}` : ""
      }`
    : JSON.stringify(entry);
  process.stderr.write(`${line}\n`);
}

export function makeLogger(component: string): Logger {
  return {
    debug: (m, f) => emit("debug", component, m, f),
    info: (m, f) => emit("info", component, m, f),
    warn: (m, f) => emit("warn", component, m, f),
    error: (m, f) => emit("error", component, m, f),
    child: (c) => makeLogger(`${component}.${c}`),
  };
}

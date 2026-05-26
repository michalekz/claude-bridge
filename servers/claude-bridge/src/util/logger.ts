/**
 * Minimal structured logger for stdio MCP servers.
 *
 * IMPORTANT: We write to stderr only — stdout is reserved for the MCP
 * JSON-RPC channel. Writing to stdout would corrupt the protocol.
 *
 * Logs are NDJSON for easy parsing in production. In development, set
 * LOG_FORMAT=pretty for human-readable output.
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
    component,
    msg,
    ...fields,
  };
  const line = pretty
    ? `[${entry.ts}] ${level.toUpperCase()} (${component}) ${msg}${
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

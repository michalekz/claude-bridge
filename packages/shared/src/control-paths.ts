import { join } from "node:path";
import { bridgeRoot } from "./paths.ts";

/**
 * Path helpers for the control-plane namespace under
 * `~/.claude-bridge/control/` (v0.10.0+).
 *
 * Layout — see control-plane-zadani-2026-07-23.md §4.3:
 *
 *   ~/.claude-bridge/control/
 *   ├── daemon.lock           # PID lock (single-writer)
 *   ├── state.json            # authoritative daemon state (stateVersion + peers + teams)
 *   ├── events.jsonl          # append-only audit log
 *   ├── requests/<id>.json    # request inbox (MCP → daemon)
 *   ├── requests/done/        # consumed requests
 *   ├── results/<id>.json     # result envelope (daemon → MCP)
 *   ├── telemetry/<sid>.json  # per-peer telemetry cache (F2)
 *   ├── teams/<team>.json     # team declarations (F2)
 *   ├── accounts/<name>/      # auth profile dirs (F3)
 *   └── pending-logins/       # offline device-code fallback (F3)
 *
 *   ~/.claude-bridge/go/
 *   ├── active/<goId>.json    # GO registry entries (owner-writable only)
 *   ├── expired/
 *   └── log.jsonl             # GO audit (created/verified/expired/revoked)
 *
 *   ~/.claude-bridge/durable-identities.json
 *                             # owner-designated peer roles (velitel, architekt, keeper)
 */

export function controlDir(): string {
  return join(bridgeRoot(), "control");
}

export function daemonLockPath(): string {
  return join(controlDir(), "daemon.lock");
}

export function stateFilePath(): string {
  return join(controlDir(), "state.json");
}

export function eventsFilePath(): string {
  return join(controlDir(), "events.jsonl");
}

export function requestsDir(): string {
  return join(controlDir(), "requests");
}

export function requestsDoneDir(): string {
  return join(requestsDir(), "done");
}

export function requestPath(requestId: string): string {
  return join(requestsDir(), `${requestId}.json`);
}

export function requestDonePath(requestId: string): string {
  return join(requestsDoneDir(), `${requestId}.json`);
}

export function resultsDir(): string {
  return join(controlDir(), "results");
}

export function resultPath(requestId: string): string {
  return join(resultsDir(), `${requestId}.json`);
}

export function telemetryDir(): string {
  return join(controlDir(), "telemetry");
}

export function telemetryFilePath(sessionId: string): string {
  return join(telemetryDir(), `${sessionId}.json`);
}

export function teamsDir(): string {
  return join(controlDir(), "teams");
}

export function accountsDir(): string {
  return join(controlDir(), "accounts");
}

export function pendingLoginsDir(): string {
  return join(controlDir(), "pending-logins");
}

export function goDir(): string {
  return join(bridgeRoot(), "go");
}

export function goActiveDir(): string {
  return join(goDir(), "active");
}

export function goExpiredDir(): string {
  return join(goDir(), "expired");
}

export function goLogPath(): string {
  return join(goDir(), "log.jsonl");
}

export function goActivePath(goId: string): string {
  return join(goActiveDir(), `${goId}.json`);
}

export function durableIdentitiesPath(): string {
  return join(bridgeRoot(), "durable-identities.json");
}

export function heartbeatPath(): string {
  return join(controlDir(), "heartbeat");
}

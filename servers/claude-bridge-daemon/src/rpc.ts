import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import {
  atomicWriteJson,
  makeLogger,
  requestDonePath,
  requestPath,
  requestsDir,
  requestsDoneDir,
  resultPath,
  resultsDir,
} from "@claude-bridge/shared";

/**
 * File-based RPC protocol between MCP-side tools (writers) and the
 * daemon (single reader).
 *
 * Request envelope:
 *   { id, ts, tool, args, requestedBy: { sessionId, name }, authRef? }
 *
 * Semantics (§4.3): fire-and-forget by default. Callers who need to wait
 * poll `results/<id>.json`. Timeouts on the caller side never cancel the
 * request server-side — idempotence is enforced by tool handlers.
 */

const log = makeLogger("daemon.rpc");

export const REQUEST_SCHEMA_VERSION = 1;

export interface RequestIdentity {
  sessionId: string;
  name: string;
}

export interface RequestEnvelope {
  schemaVersion: number;
  id: string;
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  requestedBy: RequestIdentity;
  authRef?: string;
}

export type ResultOutcome = "ok" | "error";

export interface ResultEnvelope {
  schemaVersion: number;
  id: string;
  tool: string;
  outcome: ResultOutcome;
  finishedAt: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export async function ensureRpcDirs(): Promise<void> {
  await mkdir(requestsDir(), { recursive: true });
  await mkdir(requestsDoneDir(), { recursive: true });
  await mkdir(resultsDir(), { recursive: true });
}

export async function listPendingRequests(): Promise<string[]> {
  try {
    const files = await readdir(requestsDir());
    return files.filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    log.warn("requests_list_error", { err: String(e) });
    return [];
  }
}

export async function readRequest(fileName: string): Promise<RequestEnvelope | null> {
  const requestId = fileName.replace(/\.json$/, "");
  try {
    const raw = await readFile(requestPath(requestId), "utf-8");
    const parsed = JSON.parse(raw) as RequestEnvelope;
    if (!parsed.id || !parsed.tool) {
      log.warn("request_invalid_shape", { fileName });
      return null;
    }
    return parsed;
  } catch (e) {
    log.warn("request_read_error", { fileName, err: String(e) });
    return null;
  }
}

export async function markRequestDone(requestId: string): Promise<void> {
  try {
    await rename(requestPath(requestId), requestDonePath(requestId));
  } catch (e) {
    log.warn("request_mark_done_failed", { requestId, err: String(e) });
  }
}

export async function writeResult(res: ResultEnvelope): Promise<void> {
  await atomicWriteJson(resultPath(res.id), res);
}

export function okResult(id: string, tool: string, data?: unknown): ResultEnvelope {
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    id,
    tool,
    outcome: "ok",
    finishedAt: new Date().toISOString(),
    data,
  };
}

export function errResult(
  id: string,
  tool: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ResultEnvelope {
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    id,
    tool,
    outcome: "error",
    finishedAt: new Date().toISOString(),
    error: { code, message, details },
  };
}

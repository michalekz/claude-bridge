import { makeLogger } from "@claude-bridge/shared";
import { writeDaemonEvent, writeEvent } from "./events.ts";
import { dispatch } from "./handlers.ts";
import { startHeartbeat, stopHeartbeat } from "./heartbeat.ts";
import { LockAcquireError, acquireLock, releaseLock } from "./lock.ts";
import {
  ensureRpcDirs,
  listPendingRequests,
  markRequestDone,
  readRequest,
  writeResult,
} from "./rpc.ts";
import { loadState, saveState } from "./state.ts";

const log = makeLogger("daemon");

const POLL_INTERVAL_MS = 250;

interface RunOptions {
  daemonVersion: string;
  once?: boolean;
}

export async function runDaemon(opts: RunOptions): Promise<void> {
  try {
    await acquireLock();
  } catch (e) {
    if (e instanceof LockAcquireError) {
      log.error("lock_held_by_another_daemon", {
        heldBy: e.heldBy,
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
    peerCount: Object.keys(state.peers).length,
  });
  await startHeartbeat();

  let stopping = false;
  let pollTimer: NodeJS.Timeout | null = null;

  const shutdown = async (signal: string, code = 0): Promise<void> => {
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
    log.info("sighup_reload_stub", { note: "config reload lands in v0.10.0-beta" });
  });
  // Never crash on a broken downstream pipe (v0.9.3 lesson).
  process.on("SIGPIPE", () => undefined);

  const processQueue = async (): Promise<void> => {
    if (stopping) return;
    const pending = await listPendingRequests();
    for (const fileName of pending) {
      if (stopping) return;
      const req = await readRequest(fileName);
      if (!req) {
        // Move malformed request out of the inbox so we do not re-attempt.
        const badId = fileName.replace(/\.json$/, "");
        await markRequestDone(badId);
        await writeEvent({
          event: "request_malformed",
          level: "warn",
          requestId: badId,
        });
        continue;
      }
      await writeEvent({
        event: "request_received",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { tool: req.tool },
      });
      const result = await dispatch(req, { state, daemonVersion: opts.daemonVersion });
      await writeResult(result);
      await markRequestDone(req.id);
      await writeEvent({
        event: "request_completed",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { tool: req.tool, outcome: result.outcome },
      });
    }
  };

  if (opts.once) {
    await processQueue();
    await shutdown("once");
    return;
  }

  pollTimer = setInterval(() => {
    void processQueue().catch((e) => log.error("queue_error", { err: String(e) }));
  }, POLL_INTERVAL_MS);
  // Poll timer IS the daemon keep-alive — do NOT unref (v0.9.3 lesson: an
  // event loop that would otherwise drain must have an explicit anchor).
}

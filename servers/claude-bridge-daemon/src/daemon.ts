import { guardReentrancy, isPowerOfTwo, makeLogger } from "@claude-bridge/shared";
import { writeDaemonEvent, writeEvent } from "./events.ts";
import { dispatch } from "./handlers/index.ts";
import { sweepAllAcksAtStartup } from "./handlers/peer-compact.ts";
import { startHeartbeat, stopHeartbeat } from "./heartbeat.ts";
import { type SessionHostDriver, defaultHostDriver } from "./hosts/index.ts";
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
  hostDriver?: SessionHostDriver;
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
  const hostDriver = opts.hostDriver ?? defaultHostDriver();
  // An ack left by a daemon that died mid-compact would otherwise wait here
  // for the next request on that peer and be taken as its answer.
  const sweptAcks = await sweepAllAcksAtStartup();
  // Host hygiene (F0.5): version canary + orphan paste buffers. In the event
  // stream, not only the log — a daemon running on an unmeasured tmux version
  // must be visible in the audit trail, not just in journalctl.
  const hostHygiene = (await hostDriver.startupHygiene?.().catch(() => null)) ?? null;
  await writeDaemonEvent("daemon_started", {
    daemonVersion: opts.daemonVersion,
    pid: process.pid,
    stateVersion: state.stateVersion,
    peerCount: Object.keys(state.peers).length,
    sweptCompactAcks: sweptAcks,
    ...(hostHygiene ? { hostHygiene } : {}),
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

  const drainQueue = async (): Promise<void> => {
    if (stopping) return;
    const pending = await listPendingRequests();
    for (const fileName of pending) {
      if (stopping) return;
      // The claim must use the id derived from the FILENAME, not `req.id` —
      // they are normally identical, but a mismatch would make the rename miss
      // and leave the request pending forever, re-dispatched on every tick.
      const fileId = fileName.replace(/\.json$/, "");
      const req = await readRequest(fileName);
      if (!req) {
        // Move malformed request out of the inbox so we do not re-attempt.
        await markRequestDone(fileId);
        await writeEvent({
          event: "request_malformed",
          level: "warn",
          requestId: fileId,
        });
        continue;
      }
      if (req.id !== fileId) {
        log.warn("request_id_filename_mismatch", { fileId, envelopeId: req.id });
      }
      // CLAIM BEFORE DISPATCH (v0.10.1). The request leaves `requests/` before
      // the handler runs, so it can never be picked up a second time — not by
      // a later tick, and not by a fresh daemon after a crash. At-most-once is
      // the correct semantics here because handlers are NOT idempotent:
      // re-running `peer_compact` injects `/compact` again, re-running
      // `team_stop` writes another round of stop-request inbox messages.
      // A crash mid-dispatch surfaces as the caller timing out on its result
      // poll — visible — instead of silent duplicate side effects.
      if (!(await markRequestDone(fileId))) {
        await writeEvent({
          event: "request_claim_failed",
          level: "error",
          requestId: fileId,
          details: { tool: req.tool, note: "not dispatched — would re-run on next tick" },
        });
        continue;
      }
      await writeEvent({
        event: "request_received",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { tool: req.tool },
      });
      const startedAt = Date.now();
      const result = await dispatch(req, {
        state,
        hostDriver,
        daemonVersion: opts.daemonVersion,
      });
      await writeResult(result);
      await writeEvent({
        event: "request_completed",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { tool: req.tool, outcome: result.outcome, durationMs: Date.now() - startedAt },
      });
    }
  };

  /**
   * Re-entrancy guard (v0.10.1).
   *
   * `drainQueue` is fired from a 250 ms interval, but handlers can run for
   * minutes — `peer_compact` waits up to 30 s for an anchor ack and
   * `team_stop` waits up to 120 s PER PEER. Without this guard every tick
   * started another full drain: a 5-peer `team_stop` that nobody acks would
   * have spawned ~2400 overlapping handlers, each writing its own round of
   * inbox messages and firing its own tmux children.
   *
   * Serializing is also the correct design, not just a safety net: the daemon
   * is the single writer of `state`, so concurrent handlers would race on
   * `state.peers` anyway.
   */
  const processQueue = guardReentrancy(
    async () => {
      if (stopping) return;
      await drainQueue();
    },
    {
      // Log on a doubling curve — a 120 s handler drops ~480 ticks and the
      // journal must show the stall without 4 lines per second.
      onSkip: (skipped) => {
        if (isPowerOfTwo(skipped)) log.debug("queue_tick_skipped_busy", { skipped });
      },
      onError: (e) => log.error("queue_error", { err: String(e) }),
    },
  );

  if (opts.once) {
    await processQueue();
    await shutdown("once");
    return;
  }

  pollTimer = setInterval(() => {
    // `processQueue` is guarded and never rejects — no trailing .catch needed.
    void processQueue();
  }, POLL_INTERVAL_MS);
  // Poll timer IS the daemon keep-alive — do NOT unref (v0.9.3 lesson: an
  // event loop that would otherwise drain must have an explicit anchor).
}

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { makeLogger } from "../util/logger.ts";
import { defaultBridgeRoot } from "./store.ts";

const log = makeLogger("inbox-watcher");

/**
 * Filesystem watcher for own inbox pending dir.
 *
 * Fires `onArrived` when a new `.json` file appears in
 * `<baseDir>/inbox/<peerId>/pending/`.
 *
 * Uses chokidar with `awaitWriteFinish` for write-stability — the file is
 * fully flushed by the writer's atomic temp+rename before our callback fires.
 *
 * Design notes (from cc2cc + Relay session-watcher patterns):
 * - `ignoreInitial: true` — don't fire for files already present at boot.
 *   Piggyback consumption / boot drain handles those.
 * - `awaitWriteFinish` matches atomic-write semantics (rename is the
 *   stability event).
 * - Errors are swallowed and logged — watcher should never crash the server.
 *
 * v0.2.4: pre-create the watched dir before `chokidar.watch()` to guarantee
 * inotify_add_watch succeeds. Without this, chokidar silently returns a zombie
 * watcher (no events fire) when the dir doesn't exist yet — which is the case
 * at boot before any peer has sent a message.
 */

export interface InboxWatcherOptions {
  /** Override bridge root (default ~/.claude-bridge). */
  baseDir?: string;
  /** Stability threshold for awaitWriteFinish (default 50 ms). */
  stabilityMs?: number;
  /** Poll interval inside awaitWriteFinish (default 10 ms). */
  pollMs?: number;
}

export interface InboxWatcherHandle {
  /** Resolves once chokidar emits `ready` — the watcher is actively watching. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

export function startInboxWatcher(
  peerId: string,
  onArrived: () => void | Promise<void>,
  opts: InboxWatcherOptions = {},
): InboxWatcherHandle {
  const dir = join(opts.baseDir ?? defaultBridgeRoot(), "inbox", peerId, "pending");

  // Pre-create the dir so chokidar's inotify_add_watch succeeds on first try.
  // Without this, watching a non-existent path returns a zombie watcher that
  // never fires (silent failure — no throw, no error event).
  const dirReady = mkdir(dir, { recursive: true }).catch((e) => {
    log.warn("mkdir_failed", { dir, err: e instanceof Error ? e.message : String(e) });
  });

  // Defer chokidar.watch until mkdir resolves to avoid the race.
  let resolveReady: () => void;
  const ready = new Promise<void>((res) => {
    resolveReady = res;
  });

  let watcherInstance: FSWatcher | null = null;

  void dirReady.then(() => {
    // Windows: force polling. ReadDirectoryChangesW (chokidar's default backend
    // on Windows) sporadically misses ADD events for files arriving via atomic
    // rename — especially with antivirus in the loop. Empirically verified on a
    // Windows-native Claude Code session: file arrives in pending/, watcher
    // never fires, piggyback drains it on the next tool call (= no real-time
    // push). Polling every 200 ms is reliable; adds at most ~200 ms latency to
    // push delivery vs. inotify on Linux (still orders of magnitude faster than
    // waiting for the recipient's next tool call).
    // Linux/macOS keep native inotify/FSEvents — no change there.
    const isWindows = process.platform === "win32";
    const watcher: FSWatcher = chokidar.watch(dir, {
      persistent: true,
      ignoreInitial: true,
      usePolling: isWindows,
      interval: isWindows ? 200 : undefined,
      awaitWriteFinish: {
        stabilityThreshold: opts.stabilityMs ?? 50,
        pollInterval: opts.pollMs ?? 10,
      },
    });
    watcherInstance = watcher;

    watcher.on("add", (path: string) => {
      if (!path.endsWith(".json")) return;
      log.debug("file_added", { path });
      void (async () => {
        try {
          await onArrived();
        } catch (e) {
          log.error("onArrived_failed", { err: e instanceof Error ? e.message : String(e) });
        }
      })();
    });

    watcher.on("error", (e) => {
      log.warn("watcher_error", { err: e instanceof Error ? e.message : String(e) });
    });

    watcher.on("ready", () => {
      log.info("started", { dir });
      resolveReady();
    });
  });

  return {
    ready,
    async stop() {
      if (watcherInstance) {
        await watcherInstance.close();
      }
      log.info("stopped", { dir });
    },
  };
}

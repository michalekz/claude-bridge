import { utimes, writeFile } from "node:fs/promises";
import { heartbeatPath, makeLogger } from "@claude-bridge/shared";

/**
 * Heartbeat file — mtime advertised as daemon-alive.
 *
 * Any reader (control_status MCP tool, watchdog agent) can `stat(heartbeat)`
 * and treat mtime older than ~30 s as `daemon_not_running`.
 *
 * We `utimes` an existing file rather than rewriting content — cheaper on
 * disk and lets `fs.watch` consumers see the mtime bump without a full
 * write-cycle.
 */

const log = makeLogger("daemon.heartbeat");

let timer: NodeJS.Timeout | null = null;

async function touch(): Promise<void> {
  const now = new Date();
  try {
    await utimes(heartbeatPath(), now, now);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      await writeFile(heartbeatPath(), "");
    } else {
      log.warn("heartbeat_touch_failed", { err: String(e) });
    }
  }
}

export async function startHeartbeat(intervalMs = 5000): Promise<void> {
  await touch();
  timer = setInterval(() => {
    void touch();
  }, intervalMs);
  // Do not keep the event loop alive purely for the heartbeat — the main
  // request-poll loop is the primary keep-alive.
  timer.unref();
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

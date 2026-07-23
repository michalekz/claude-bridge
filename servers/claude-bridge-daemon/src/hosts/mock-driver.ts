import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { makeLogger } from "@claude-bridge/shared";
import type { SessionHostDriver, SessionHostRecord, SessionHostSpawnOptions } from "./driver.ts";

const log = makeLogger("daemon.host.mock");

/**
 * MockDriver — an in-memory host that spawns real child processes but
 * skips tmux. Used by acceptance tests so they can exercise the daemon
 * without needing a tmux server on the test machine (CI).
 *
 * `hostRespawnHook` lets tests simulate the bg-pty-host respawn class
 * of failure: after `kill()` succeeds, the hook re-registers the session
 * as if a supervisor brought it back. The daemon's verify step must
 * catch this and surface an error.
 */

interface MockSessionEntry {
  proc: ChildProcess | null;
  pid: number | null;
  respawnPending: boolean;
}

export interface MockDriverOptions {
  /**
   * When set, called after kill() removes a session. If it returns
   * `true`, the driver silently re-inserts the session (simulating a
   * misbehaving supervisor) before the daemon polls. The daemon MUST
   * catch this via its post-kill verify.
   */
  hostRespawnHook?: (sessionKey: string) => boolean;
}

export class MockDriver implements SessionHostDriver {
  readonly name = "mock" as const;
  private readonly sessions = new Map<string, MockSessionEntry>();
  private readonly hostRespawnHook: ((k: string) => boolean) | undefined;

  constructor(opts: MockDriverOptions = {}) {
    this.hostRespawnHook = opts.hostRespawnHook;
  }

  async hasSession(sessionKey: string): Promise<boolean> {
    return this.sessions.has(sessionKey);
  }

  async spawn(opts: SessionHostSpawnOptions): Promise<SessionHostRecord> {
    if (this.sessions.has(opts.sessionKey)) {
      throw new Error(`Mock session '${opts.sessionKey}' already exists`);
    }
    let proc: ChildProcess | null = null;
    let pid: number | null = null;
    try {
      proc = spawnProcess(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: "ignore",
        detached: true,
      });
      pid = proc.pid ?? null;
      proc.on("exit", () => this.sessions.delete(opts.sessionKey));
    } catch (e) {
      log.warn("mock_spawn_failed", { sessionKey: opts.sessionKey, err: String(e) });
      // For tests we still register — some acceptance cases assert on
      // state independent of whether the binary actually runs.
    }
    this.sessions.set(opts.sessionKey, { proc, pid, respawnPending: false });
    return { sessionKey: opts.sessionKey, alive: true, pid };
  }

  async kill(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    if (entry.proc && entry.pid !== null) {
      try {
        process.kill(-entry.pid, "SIGKILL");
      } catch {
        // process may already be gone; ignore
      }
    }
    this.sessions.delete(sessionKey);
    if (this.hostRespawnHook?.(sessionKey)) {
      // Simulated supervisor respawn — insert a synthetic record so the
      // daemon's verify step trips.
      this.sessions.set(sessionKey, { proc: null, pid: null, respawnPending: true });
    }
  }

  async listSessions(): Promise<SessionHostRecord[]> {
    const out: SessionHostRecord[] = [];
    for (const [sessionKey, entry] of this.sessions.entries()) {
      out.push({ sessionKey, alive: true, pid: entry.pid });
    }
    return out;
  }

  /** Test hook — forcibly clear all sessions between test cases. */
  reset(): void {
    for (const entry of this.sessions.values()) {
      if (entry.proc && entry.pid !== null) {
        try {
          process.kill(-entry.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    this.sessions.clear();
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeLogger } from "@claude-bridge/shared";
import type { SessionHostDriver, SessionHostRecord, SessionHostSpawnOptions } from "./driver.ts";

const execFileAsync = promisify(execFile);
const log = makeLogger("daemon.host.tmux");

/**
 * tmux-backed host driver.
 *
 * Sessions are addressed **by name**, never by fd or pid — that's what
 * lets the daemon rehydrate on restart (§6/6 state recovery) by simply
 * asking `tmux has-session`. tmux is responsible for keeping the shell
 * process group alive across everything short of `kill-session`.
 *
 * `kill()` uses `kill-session`, not `kill-window`, so any child processes
 * — including bg-pty-host-like supervisors that may have attached — are
 * torn down with the session's process group. `verifyKilled()` polls
 * post-kill to catch the respawn class of failure (msg mrxe9t7d).
 */

export interface TmuxDriverOptions {
  /** Absolute path to `tmux`; auto-detected from PATH when omitted. */
  tmuxBin?: string;
  /** Post-kill verify budget in ms (default 2000). */
  verifyTimeoutMs?: number;
  /** Post-kill verify poll interval in ms (default 200). */
  verifyIntervalMs?: number;
}

export class TmuxDriver implements SessionHostDriver {
  readonly name = "tmux" as const;
  private readonly tmuxBin: string;
  private readonly verifyTimeoutMs: number;
  private readonly verifyIntervalMs: number;

  constructor(opts: TmuxDriverOptions = {}) {
    this.tmuxBin = opts.tmuxBin ?? "tmux";
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? 2000;
    this.verifyIntervalMs = opts.verifyIntervalMs ?? 200;
  }

  async hasSession(sessionKey: string): Promise<boolean> {
    try {
      await execFileAsync(this.tmuxBin, ["has-session", "-t", sessionKey]);
      return true;
    } catch {
      return false;
    }
  }

  async spawn(opts: SessionHostSpawnOptions): Promise<SessionHostRecord> {
    const args = [
      "new-session",
      "-d",
      "-s",
      opts.sessionKey,
      "-c",
      opts.cwd,
      opts.command,
      ...opts.args,
    ];
    const { env } = opts;
    try {
      await execFileAsync(this.tmuxBin, args, { env });
    } catch (e) {
      log.error("tmux_spawn_failed", {
        sessionKey: opts.sessionKey,
        err: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    const pid = await this.readSessionPid(opts.sessionKey);
    return { sessionKey: opts.sessionKey, alive: true, pid };
  }

  async kill(sessionKey: string, opts: { force?: boolean } = {}): Promise<void> {
    // tmux kill-session is already a single-step signal to the whole
    // session's process group; `force` only affects our verify budget.
    try {
      await execFileAsync(this.tmuxBin, ["kill-session", "-t", sessionKey]);
    } catch (e) {
      // If the session was already gone, treat as success — idempotent.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("can't find session")) return;
      throw e;
    }
    const budget = opts.force === true ? this.verifyTimeoutMs / 2 : this.verifyTimeoutMs;
    const respawned = !(await this.verifyKilled(sessionKey, budget));
    if (respawned) {
      // Something re-created the session — bg-pty-host-shaped supervisor.
      // Surface it loudly; caller decides whether to force again or alarm.
      log.error("tmux_kill_respawn_detected", { sessionKey });
      throw new Error(
        `Session '${sessionKey}' respawned within ${budget}ms after kill — investigate supervisor (bg-pty-host?)`,
      );
    }
  }

  async listSessions(): Promise<SessionHostRecord[]> {
    try {
      const { stdout } = await execFileAsync(this.tmuxBin, [
        "list-sessions",
        "-F",
        "#{session_name}\t#{pane_pid}",
      ]);
      const records: SessionHostRecord[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [name, pidStr] = trimmed.split("\t");
        if (!name) continue;
        const parsedPid = pidStr ? Number.parseInt(pidStr, 10) : Number.NaN;
        records.push({
          sessionKey: name,
          alive: true,
          pid: Number.isNaN(parsedPid) ? null : parsedPid,
        });
      }
      return records;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "no server running" is the healthy empty state on a fresh box.
      if (msg.includes("no server running")) return [];
      throw e;
    }
  }

  async sendKeys(sessionKey: string, keys: string): Promise<void> {
    await execFileAsync(this.tmuxBin, ["send-keys", "-t", sessionKey, keys, "Enter"]);
  }

  private async readSessionPid(sessionKey: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync(this.tmuxBin, [
        "display-message",
        "-p",
        "-t",
        sessionKey,
        "#{pane_pid}",
      ]);
      const parsed = Number.parseInt(stdout.trim(), 10);
      return Number.isNaN(parsed) ? null : parsed;
    } catch {
      return null;
    }
  }

  private async verifyKilled(sessionKey: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (!(await this.hasSession(sessionKey))) return true;
      await new Promise((r) => setTimeout(r, this.verifyIntervalMs));
    }
    return !(await this.hasSession(sessionKey));
  }
}

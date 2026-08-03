import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlDir, makeLogger } from "@claude-bridge/shared";
import {
  type SessionHostDriver,
  type SessionHostRecord,
  type SessionHostSpawnOptions,
  sanitizeSessionKey,
} from "./driver.ts";

const execFileAsync = promisify(execFile);
const log = makeLogger("daemon.host.tmux");

/**
 * Every tmux invocation is bounded (v0.10.1).
 *
 * Without a timeout a wedged tmux server — stuck socket, `$TMUX_TMPDIR` on a
 * hung mount, a paused pane swallowing `send-keys` — leaves the promise
 * pending forever, pinning the child, its three stdio pipes and the whole
 * `await` chain up through the request handler. Combined with the poll loop
 * that was the path to fd exhaustion in minutes.
 *
 * `killSignal: SIGKILL` because a tmux that is already wedged will not
 * necessarily honour SIGTERM.
 */
const EXEC_DEFAULTS = { killSignal: "SIGKILL" } as const;
/** Read-only queries — must answer immediately or not at all. */
const QUERY_TIMEOUT_MS = 5_000;
/** Session create/destroy — may legitimately take longer than a query. */
const MUTATE_TIMEOUT_MS = 10_000;
/** Key injection — a pane that cannot accept keys in 5 s will not accept them. */
const SEND_KEYS_TIMEOUT_MS = 5_000;
/** Settle time between injecting text and reading the pane back. */
const DEFAULT_SEND_VERIFY_DELAY_MS = 250;

/**
 * Is the injected text visible in the captured pane?
 *
 * Compared on a whitespace-normalised tail because a long prompt wraps across
 * pane columns, so an exact substring match would fail on text that did in
 * fact arrive. The tail is distinctive enough to tell "arrived" from "vanished"
 * without being brittle about where tmux broke the line.
 */
export function paneContains(captured: string, keys: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const needle = flat(keys);
  if (needle.length === 0) return true;
  const haystack = flat(captured);
  // Match on the tail: the head of a long line may have scrolled off.
  const probe = needle.length > 40 ? needle.slice(-40) : needle;
  return haystack.includes(probe);
}

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
 *
 * **No linked-window guard, and that is deliberate.** The v0.10.1 plan called
 * for checking `#{window_linked_sessions_list}` and unlinking instead of
 * killing. Measured on tmux 3.x before implementing: link a window from
 * session A into session B, then `kill-session -t A` — the window survives in
 * B untouched. The hazard only exists for `kill-window`, which this driver
 * never issues, so a guard here would be code defending against nothing.
 */

export interface TmuxDriverOptions {
  /** Absolute path to `tmux`; auto-detected from PATH when omitted. */
  tmuxBin?: string;
  /** Post-kill verify budget in ms (default 2000). */
  verifyTimeoutMs?: number;
  /** Post-kill verify poll interval in ms (default 200). */
  verifyIntervalMs?: number;
  /** Settle time between injecting text and capturing the pane (default 250). */
  sendVerifyDelayMs?: number;
}

export class TmuxDriver implements SessionHostDriver {
  readonly name = "tmux" as const;
  private readonly tmuxBin: string;
  private readonly verifyTimeoutMs: number;
  private readonly verifyIntervalMs: number;
  private readonly sendVerifyDelayMs: number;

  constructor(opts: TmuxDriverOptions = {}) {
    this.tmuxBin = opts.tmuxBin ?? "tmux";
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? 2000;
    this.verifyIntervalMs = opts.verifyIntervalMs ?? 200;
    this.sendVerifyDelayMs = opts.sendVerifyDelayMs ?? DEFAULT_SEND_VERIFY_DELAY_MS;
  }

  async hasSession(sessionKey: string): Promise<boolean> {
    const canonical = sanitizeSessionKey(sessionKey);
    try {
      await execFileAsync(this.tmuxBin, ["has-session", "-t", canonical], {
        ...EXEC_DEFAULTS,
        timeout: QUERY_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async spawn(opts: SessionHostSpawnOptions): Promise<SessionHostRecord> {
    // Canonicalize the session key so tmux never sees `:` / `.` / spaces —
    // v0.10.0-rc.2 fix for the silent-rewrite bug caught by the test scenario.
    const canonicalKey = sanitizeSessionKey(opts.sessionKey);
    const args = [
      "new-session",
      "-d",
      "-s",
      canonicalKey,
      "-c",
      opts.cwd,
      opts.command,
      ...opts.args,
    ];
    const { env } = opts;
    try {
      await execFileAsync(this.tmuxBin, args, {
        ...EXEC_DEFAULTS,
        env,
        timeout: MUTATE_TIMEOUT_MS,
      });
    } catch (e) {
      log.error("tmux_spawn_failed", {
        sessionKey: opts.sessionKey,
        canonicalKey,
        err: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    if (canonicalKey !== opts.sessionKey) {
      log.info("session_key_canonicalized", {
        raw: opts.sessionKey,
        canonical: canonicalKey,
      });
    }
    const pid = await this.readSessionPid(canonicalKey);
    return { sessionKey: canonicalKey, alive: true, pid };
  }

  async kill(sessionKey: string, opts: { force?: boolean } = {}): Promise<void> {
    const canonical = sanitizeSessionKey(sessionKey);
    // Idempotent — the caller may not know whether the session is still
    // there (v0.10.0-rc.2 fix for T2 „stopping without host" reconcile).
    if (!(await this.hasSession(canonical))) return;
    try {
      await execFileAsync(this.tmuxBin, ["kill-session", "-t", canonical], {
        ...EXEC_DEFAULTS,
        timeout: MUTATE_TIMEOUT_MS,
      });
    } catch (e) {
      if (!(await this.hasSession(canonical))) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("can't find session")) return;
      throw e;
    }
    const budget = opts.force === true ? this.verifyTimeoutMs / 2 : this.verifyTimeoutMs;
    const respawned = !(await this.verifyKilled(canonical, budget));
    if (respawned) {
      log.error("tmux_kill_respawn_detected", { sessionKey: canonical });
      throw new Error(
        `Session '${canonical}' respawned within ${budget}ms after kill — investigate supervisor (bg-pty-host?)`,
      );
    }
  }

  async listSessions(): Promise<SessionHostRecord[]> {
    try {
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        ["list-sessions", "-F", "#{session_name}\t#{pane_pid}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS },
      );
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

  /**
   * Inject keys into a pane and PROVE they landed (v0.10.1).
   *
   * Evidence for why this is not optional: during the 2026-08-02 tmux
   * consolidation a `/exit` was sent to a peer and simply never arrived — no
   * trace in the transcript, the input box empty, the process untouched — and
   * the script that sent it then hung for 13 minutes with no log line. Two
   * lessons, both encoded here: a send without verification is undelivered
   * mail, and a wait without a log is an undiagnosable incident.
   *
   * Sequence:
   *   1. If the pane is in copy-mode it swallows input — cancel out of it first.
   *   2. Send the TEXT alone and confirm it is visible in the pane. This is the
   *      real check: it proves the keystrokes reached the application while the
   *      line is still uncommitted, so a failure costs nothing.
   *   3. Only then send Enter.
   *
   * Every attempt is appended to `control/logs/sendkeys-<sessionKey>.log`.
   * Throws when the text cannot be confirmed, so callers surface a hard failure
   * instead of assuming delivery.
   */
  async sendKeys(sessionKey: string, keys: string): Promise<void> {
    const canonical = sanitizeSessionKey(sessionKey);
    const inMode = await this.paneInMode(canonical);
    if (inMode) {
      // A pane left in copy-mode (someone scrolled back) discards send-keys.
      await this.tmux(["send-keys", "-t", canonical, "-X", "cancel"], SEND_KEYS_TIMEOUT_MS).catch(
        () => undefined,
      );
    }

    let delivered = false;
    let attempts = 0;
    let capturedTail = "";
    let lastError: string | null = null;
    // One retry: the common failure is a pane that was still settling, and a
    // second attempt costs a few hundred milliseconds.
    for (attempts = 1; attempts <= 2 && !delivered; attempts++) {
      try {
        await this.tmux(["send-keys", "-t", canonical, keys], SEND_KEYS_TIMEOUT_MS);
      } catch (e) {
        // A vanished pane makes tmux itself fail. Record it and keep going to
        // the logging path — an unlogged failure is the half of the
        // 2026-08-02 incident that made it undiagnosable.
        lastError = e instanceof Error ? e.message : String(e);
        continue;
      }
      await new Promise((r) => setTimeout(r, this.sendVerifyDelayMs));
      capturedTail = await this.capturePane(canonical);
      delivered = paneContains(capturedTail, keys);
    }

    await this.logSendKeys(canonical, {
      keys,
      paneInMode: inMode,
      attempts: attempts - 1,
      verdict: delivered ? "delivered" : "not-visible",
      ...(lastError ? { error: lastError } : {}),
      capturedTail: capturedTail.slice(-240),
    });

    if (!delivered) {
      log.error("tmux_send_keys_unverified", {
        sessionKey: canonical,
        attempts: attempts - 1,
        err: lastError,
      });
      throw new Error(
        `send-keys to '${canonical}' could not be verified after ${attempts - 1} attempts — text never appeared in the pane` +
          (lastError ? ` (tmux: ${lastError.split("\n")[0]})` : ""),
      );
    }
    await this.tmux(["send-keys", "-t", canonical, "Enter"], SEND_KEYS_TIMEOUT_MS);
  }

  /** `#{pane_in_mode}` is "1" while the pane is in copy-mode / view-mode. */
  private async paneInMode(sessionKey: string): Promise<boolean> {
    try {
      const { stdout } = await this.tmux(
        ["display-message", "-p", "-t", sessionKey, "#{pane_in_mode}"],
        QUERY_TIMEOUT_MS,
      );
      return stdout.trim() === "1";
    } catch {
      return false;
    }
  }

  private async capturePane(sessionKey: string): Promise<string> {
    try {
      const { stdout } = await this.tmux(
        ["capture-pane", "-p", "-t", sessionKey],
        QUERY_TIMEOUT_MS,
      );
      return stdout;
    } catch {
      return "";
    }
  }

  private async logSendKeys(sessionKey: string, entry: Record<string, unknown>): Promise<void> {
    try {
      const dir = join(controlDir(), "logs");
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), sessionKey, ...entry });
      await appendFile(join(dir, `sendkeys-${sessionKey}.log`), `${line}\n`, "utf-8");
    } catch {
      // Never let the audit log break the operation it is auditing.
    }
  }

  private tmux(args: string[], timeout: number) {
    return execFileAsync(this.tmuxBin, args, { ...EXEC_DEFAULTS, timeout });
  }

  private async readSessionPid(sessionKey: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        ["display-message", "-p", "-t", sessionKey, "#{pane_pid}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS },
      );
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

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlDir, makeLogger } from "@claude-bridge/shared";
import {
  type HostWindowRecord,
  type SessionHostDriver,
  type SessionHostRecord,
  type SessionHostSpawnOptions,
  parseHostTarget,
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

/**
 * Build the pane's environment on the command line, from nothing.
 *
 * The whitelist in `env-whitelist.ts` was composed and then handed to
 * `execFile` as the environment of the **tmux client**. A new pane does not
 * inherit that. tmux's server is a long-lived process, and a session it
 * creates gets the SERVER's global environment plus the handful of variables
 * named in `update-environment` (DISPLAY, SSH_*, XAUTHORITY by default).
 * Nothing the client was given reaches the pane.
 *
 * So the whitelist filtered something tmux never consulted. Measured
 * 2026-08-04 on tmux 3.4: a session created with `env -i` — an entirely empty
 * client environment — produced a pane holding `ANTHROPIC_API_KEY` and eight
 * `CLAUDE_*` variables, taken from the server. That is the 22 July billing
 * incident as a permanent condition rather than an accident, and it is why
 * five peers were found carrying the key.
 *
 * `env -i` makes the pane's environment explicit and independent of tmux's
 * semantics: nothing is inherited, every variable is one we chose. Cleaning
 * the server's global environment (`tmux set-environment -gu`) fixes today's
 * server but not the next one started from a contaminated shell, so it is an
 * operational step, never the mechanism.
 *
 * `execFile` runs without a shell, so values need no quoting.
 */
export function envPrefix(env: Record<string, string>): string[] {
  // Absolute path, not a bare `env`. tmux resolves the command against the
  // SERVER's PATH, and the PATH we chose is inside this command's arguments —
  // too late to help resolve the binary that applies them. `/usr/bin/env` is
  // the one location POSIX effectively guarantees (every shebang line in the
  // world depends on it); fall back to a PATH lookup only if it is missing.
  const envBin = existsSync("/usr/bin/env") ? "/usr/bin/env" : "env";
  return [envBin, "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
}
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
    const t = parseHostTarget(sessionKey);
    // `has-session -t hmh:3` answers for the SESSION hmh, so a window target
    // has to be checked by listing the session's windows instead — otherwise a
    // vanished window reports itself alive as long as its session survives.
    if (t.kind === "window") {
      const windows = await this.listWindows();
      return windows.some((w) => w.target === t.windowId);
    }
    try {
      await execFileAsync(this.tmuxBin, ["has-session", "-t", t.session], {
        ...EXEC_DEFAULTS,
        timeout: QUERY_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Session-only probe. `hasSession` resolves window ids; this asks about a session. */
  private async rawHasSession(session: string): Promise<boolean> {
    try {
      await execFileAsync(this.tmuxBin, ["has-session", "-t", `${session}:`], {
        ...EXEC_DEFAULTS,
        timeout: QUERY_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async listWindows(): Promise<HostWindowRecord[]> {
    try {
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        [
          "list-panes",
          "-a",
          "-F",
          "#{window_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_pid}",
        ],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS },
      );
      const out: HostWindowRecord[] = [];
      const seen = new Set<string>();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [windowId, session, idxStr, windowName, pidStr] = trimmed.split("\t");
        if (!windowId || !session || idxStr === undefined) continue;
        const window = Number.parseInt(idxStr, 10);
        if (Number.isNaN(window)) continue;
        // The ADDRESS is the window id; `session:index` is only a label.
        const target = windowId;
        // A window can hold several panes; the peer is one process, so report
        // the window once, keyed on its first pane.
        if (seen.has(target)) continue;
        seen.add(target);
        const pid = pidStr ? Number.parseInt(pidStr, 10) : Number.NaN;
        out.push({
          target,
          label: `${session}:${window}`,
          session,
          window,
          windowName: windowName ?? "",
          pid: Number.isNaN(pid) ? null : pid,
        });
      }
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("no server running")) return [];
      throw e;
    }
  }

  /**
   * Sessions that also hold this window, other than its own.
   *
   * tmux can link one window into several sessions. `kill-window` removes it
   * from all of them at once, so a linked window must be UNLINKED from the
   * caller's session instead — killing it would take a peer out of somebody
   * else's session too. v0.10.1 measured that `kill-session` has no such
   * hazard and dropped the guard; `kill-window` is now reachable, so it is back.
   */
  private async linkedElsewhere(target: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        ["display-message", "-p", "-t", target, "#{window_linked_sessions_list}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS },
      );
      const { stdout: ownOut } = await execFileAsync(
        this.tmuxBin,
        ["display-message", "-p", "-t", target, "#{session_name}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS },
      );
      const own = ownOut.trim();
      return stdout
        .trim()
        .split(/[\s,]+/)
        .filter((n) => n.length > 0 && n !== own);
    } catch {
      return [];
    }
  }

  async spawn(opts: SessionHostSpawnOptions): Promise<SessionHostRecord> {
    // Canonicalize the session key so tmux never sees `:` / `.` / spaces —
    // v0.10.0-rc.2 fix for the silent-rewrite bug caught by the test scenario.
    // A peer that belongs inside an existing session is created as a WINDOW
    // there, not as a session of its own (fix, 2026-08-04 pilot).
    const asWindow = opts.inSession !== undefined;
    const parentSession = opts.inSession ? sanitizeSessionKey(opts.inSession) : null;
    const canonicalKey = asWindow ? opts.sessionKey : sanitizeSessionKey(opts.sessionKey);
    const args = asWindow
      ? [
          "new-window",
          "-d",
          "-P",
          // Print the new window's id so the caller can address it. A window
          // index would be wrong: `renumber-windows` shifts those on every kill.
          "-F",
          "#{window_id}",
          "-t",
          `${parentSession}:`,
          "-c",
          opts.cwd,
          "--",
          ...envPrefix(opts.env),
          opts.command,
          ...opts.args,
        ]
      : [
          "new-session",
          "-d",
          "-s",
          canonicalKey,
          "-c",
          opts.cwd,
          "--",
          ...envPrefix(opts.env),
          opts.command,
          ...opts.args,
        ];
    // The home session may be gone.
    //
    // A peer that was the ONLY window of its session takes the session with it
    // when it stops — so by relaunch time `new-window -t <session>:` fails with
    // "can't find session" and the peer is simply dead, with nothing to
    // recover from. Every peer created by `peer_spawn` is a single-window
    // session, so this is the common case, not the exotic one
    // (plt-designer, pre-rollout probe, 2026-08-04).
    //
    // Recreating the session under the same name puts the peer back where it
    // belongs. Falling back to a session named after the PEER would be the
    // escape this release already fixed twice.
    let effectiveArgs = args;
    let recreatedHome = false;
    if (asWindow && parentSession !== null && !(await this.rawHasSession(parentSession))) {
      log.info("tmux_home_session_recreated", { session: parentSession });
      effectiveArgs = [
        "new-session",
        "-d",
        // Print the window id here too: the record's address must stay a window
        // id whether the session was already there or had to be remade.
        "-P",
        "-F",
        "#{window_id}",
        "-s",
        parentSession,
        "-c",
        opts.cwd,
        "--",
        ...envPrefix(opts.env),
        opts.command,
        ...opts.args,
      ];
      recreatedHome = true;
    }

    const { env } = opts;
    let createdWindowId: string | null = null;
    try {
      const { stdout } = await execFileAsync(this.tmuxBin, effectiveArgs, {
        ...EXEC_DEFAULTS,
        // Kept for the tmux CLIENT process itself. It does NOT reach the pane —
        // see envPrefix() for why the pane's environment is built on the
        // command line instead.
        env,
        timeout: MUTATE_TIMEOUT_MS,
      });
      // Both paths print the new window's id now.
      if (asWindow) createdWindowId = stdout.trim() || null;
      void recreatedHome;
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
    // `alive` is MEASURED, not asserted (fix, 2026-08-04).
    //
    // This used to return `alive: true` as a literal, right after a `tmux
    // new-session` that had not thrown. That is not the same thing. tmux
    // exits 0 as soon as the session is created; if the command inside dies
    // immediately — wrong cwd, bad arguments, missing binary — tmux tears
    // the session straight back down and nobody hears about it.
    //
    // Downstream everything believed the literal: `peer_spawn` set
    // `status: "live"`, wrote a `peer_started` audit event and answered
    // `outcome: ok`, with `pid: null` as the only trace. `peer_restart`
    // inherited all of it. Reported live on 2026-08-04: tool said started,
    // tmux session did not exist, no process was running, and the daemon
    // state carried a "live" peer with a null pid that `team_layout` would
    // then refuse to resurrect.
    //
    // A pane pid is the cheapest honest evidence that something is actually
    // running in there.
    // The new window's id IS its address, so the record must carry that rather
    // than the key the caller asked for.
    const effectiveKey = createdWindowId ?? canonicalKey;
    const pid = await this.readSessionPid(effectiveKey);
    if (pid === null) {
      log.error("tmux_spawn_no_pane_pid", {
        sessionKey: opts.sessionKey,
        canonicalKey: effectiveKey,
        hint: "new-session returned 0 but no pane pid — the command most likely exited immediately",
      });
    }
    return { sessionKey: effectiveKey, alive: pid !== null, pid };
  }

  async kill(sessionKey: string, opts: { force?: boolean } = {}): Promise<void> {
    const t = parseHostTarget(sessionKey);
    const canonical = t.kind === "window" ? t.windowId : t.session;
    // Idempotent — the caller may not know whether the session is still
    // there (v0.10.0-rc.2 fix for T2 „stopping without host" reconcile).
    if (!(await this.hasSession(canonical))) return;

    // A window target must NEVER reach kill-session. `kill-session -t hmh:3`
    // kills the session `hmh` — on this fleet that is seven peers instead of
    // one, and nothing in the result would say so (fix, 2026-08-04).
    const verb = t.kind === "window" ? "kill-window" : "kill-session";

    if (t.kind === "window") {
      const linked = await this.linkedElsewhere(t.windowId);
      if (linked.length > 0) {
        // Unlink rather than kill: the window belongs to other sessions too and
        // kill-window would remove it from all of them.
        log.warn("tmux_window_linked_unlinking", { target: t.windowId, linkedSessions: linked });
        await execFileAsync(this.tmuxBin, ["unlink-window", "-t", t.windowId], {
          ...EXEC_DEFAULTS,
          timeout: MUTATE_TIMEOUT_MS,
        });
        return;
      }
    }

    try {
      await execFileAsync(this.tmuxBin, [verb, "-t", canonical], {
        ...EXEC_DEFAULTS,
        timeout: MUTATE_TIMEOUT_MS,
      });
    } catch (e) {
      if (!(await this.hasSession(canonical))) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("can't find session") || msg.includes("can't find window")) return;
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
        `send-keys to '${canonical}' could not be verified after ${attempts - 1} attempts — text never appeared in the pane${lastError ? ` (tmux: ${lastError.split("\n")[0]})` : ""}`,
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

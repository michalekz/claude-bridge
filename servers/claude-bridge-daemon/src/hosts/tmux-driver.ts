import { type ChildProcess, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlDir, makeLogger } from "@claude-bridge/shared";
import { writeEvent } from "../events.ts";
import { pollUntil } from "../poll.ts";
import {
  type CanonicalTarget,
  type HostWindowRecord,
  type PaneProbe,
  type SessionHostDriver,
  type SessionHostRecord,
  type SessionHostSpawnOptions,
  canonicalHostTarget,
  formatHostTarget,
  parseHostTarget,
  sanitizeSessionKey,
  trustCanonicalTarget,
} from "./driver.ts";

/**
 * Pause between pid probes. Not derived from a measurement — it is a gap
 * against transient `execFile` failures, chosen small enough that three
 * attempts stay inside a spawn's patience. Written down because a bare 200 in
 * a consolidated file reads as though somebody measured it.
 */
const PROBE_RETRY_PAUSE_MS = 200;
import {
  CLEAR_STROKE_BATCH,
  type DecodedCapture,
  type DeliveryWhere,
  type InputLineProbe,
  KILL_RING_HINT,
  MAX_CLEAR_STROKES,
  type PayloadRoute,
  decodeCapture,
  displacedDraftNotice,
  inputLineHolds,
  payloadRoute,
  readInputLine,
  refusePayload,
} from "./input-line.ts";

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
 * Variables tmux sets for a pane itself. Passing them in would hand the new
 * pane the PREVIOUS pane's identity — `kb-ops` came up in `%1011` announcing
 * itself as `%71` (2026-08-04). Stripped here as well as at harvest time,
 * because this is the one place every spawn path goes through.
 */
const TMUX_OWNED_VARS = ["TMUX", "TMUX_PANE"];

/**
 * The three variables the PANE knows and the daemon cannot.
 *
 * Read inside the pane rather than passed in, because neither source the
 * daemon has is correct:
 *
 *   - `TMUX_PANE` does not exist until the pane does, and a value harvested
 *     from the previous pane points at something already destroyed — `kb-ops`
 *     carried `%71` while living in `%1011` (2026-08-04).
 *   - `TERM` is absent from the daemon entirely: it runs under systemd with no
 *     terminal, so there was never anything to pass on.
 *
 * `sh -c` still has what tmux set, so it restates the values on the `env -i`
 * command line before `env -i` wipes them.
 */
const PANE_SELF_DESCRIBING = [
  // Empty only if tmux failed to set it; the built-in default beats nothing.
  'TERM="${TERM:-screen-256color}"',
  'TMUX="$TMUX"',
  'TMUX_PANE="$TMUX_PANE"',
];

/** Single-quote for `sh -c`, escaping embedded quotes the POSIX way. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the pane's command line, with its environment stated from nothing.
 *
 * **Why `env -i`.** The whitelist in `env-whitelist.ts` was composed and then
 * handed to `execFile` as the environment of the **tmux client**. A new pane
 * does not inherit that. tmux's server is long-lived, and a session it creates
 * gets the SERVER's global environment plus the handful of variables named in
 * `update-environment`. Nothing the client was given reaches the pane, so the
 * whitelist was filtering something tmux never consulted. Measured 2026-08-04
 * on tmux 3.4: a session created with an entirely empty client environment
 * still produced a pane holding `ANTHROPIC_API_KEY` and eight `CLAUDE_*`
 * variables from the server. That is the 22 July billing incident as a
 * permanent condition, and why five peers were found carrying the key.
 * Cleaning the server's environment fixes today's server but not the next one
 * started from a contaminated shell — an operational step, never the mechanism.
 *
 * **Why a shell.** `env -i` is thorough: it also discards what tmux set for
 * the pane. Measured 2026-08-05, the same pane both ways —
 *
 *   with `env -i`   PATH, HOME and nothing else
 *   without         TERM=tmux-256color, TMUX=…, TMUX_PANE=%1029
 *
 * — so peers came up monochrome, and a `tmux` command run inside a peer could
 * not find its own server. `sh -c` runs with tmux's environment intact, names
 * the three pane-scoped values, and `exec`s, leaving no shell behind so
 * `pane_pid` still points at the peer.
 *
 * Values are single-quoted because a shell is now involved; `execFile` itself
 * still runs without one.
 */
export function paneCommand(
  env: Record<string, string>,
  command: string,
  args: readonly string[],
): string[] {
  // Absolute path, not a bare `env`. tmux resolves the command against the
  // SERVER's PATH, and the PATH we chose is inside this command's arguments —
  // too late to help resolve the binary that applies them. `/usr/bin/env` is
  // the one location POSIX effectively guarantees (every shebang line in the
  // world depends on it); fall back to a PATH lookup only if it is missing.
  const envBin = existsSync("/usr/bin/env") ? "/usr/bin/env" : "env";
  const assignments = Object.entries(env)
    // The pane describes these three itself, below — a value from the caller
    // would be a stale copy of another pane's identity.
    .filter(([k]) => !TMUX_OWNED_VARS.includes(k) && k !== "TERM")
    .map(([k, v]) => `${k}=${shQuote(v)}`);
  const script = [
    "exec",
    envBin,
    "-i",
    ...assignments,
    ...PANE_SELF_DESCRIBING,
    shQuote(command),
    ...args.map(shQuote),
  ].join(" ");
  return ["/bin/sh", "-c", script];
}
/** Read-only queries — must answer immediately or not at all. */
const QUERY_TIMEOUT_MS = 5_000;
/** Session create/destroy — may legitimately take longer than a query. */
const MUTATE_TIMEOUT_MS = 10_000;
/** Key injection — a pane that cannot accept keys in 5 s will not accept them. */
const SEND_KEYS_TIMEOUT_MS = 5_000;

/**
 * Scrollback for panes this daemon creates. 2 000, not the user's 100 000:
 * capture-pane reads ≤ ~50 rows for dialogs and the durable record is the
 * peer's own JSONL. Measured 2026-08-14: the production tmux server held
 * ~500 MiB of scrollback (~3,5 kB RSS per 100-char row), 29 % of it one pane.
 *
 * The limit is read when a PANE IS CREATED (measured twice: neither `-g` nor a
 * per-window `set -w` reaches an existing pane), so it must land on the session
 * BEFORE `new-window`. Existing panes keep their history until respawn — the
 * owner was told to expect no immediate drop.
 */
const FLEET_HISTORY_LIMIT = 2_000;

/** The tmux version every behavioural measurement in docs/cs was taken on. */
const MEASURED_TMUX_VERSION = "tmux 3.4";
/**
 * Settle time between injecting text and reading the pane back.
 *
 * SPACING, not a poll (R5, v0.11.20). Nothing is being waited FOR — the pane
 * has to finish redrawing before a capture means anything, and a capture taken
 * too early reads the previous frame and calls the send lost. Not derived from
 * a measurement; 250 ms is a redraw's worth of time on this host and has held
 * since v0.11.6. Written down so a later reader does not mistake it for one.
 */
const DEFAULT_SEND_VERIFY_DELAY_MS = 250;

/** How long a `⚠` notice stays on the target's status line, in ms. */
const HUMAN_NOTICE_MS = 8_000;

/** Outcome of the hygiene phase that runs before any payload is typed. */
export interface ClearOutcome {
  /** `displaced` means a human's unsent text was taken out of the way. */
  kind: "was-empty" | "displaced" | "stuck" | "not-an-input-box";
  /** Best-effort text of what was displaced — audit evidence, not a restore. */
  draft: string;
  strokes: number;
  /** Whether Claude Code offered `Ctrl+Y`, i.e. confirmed it holds the text. */
  restorable: boolean;
  /** Dimmed characters seen in the box — the client's suggestion, not a draft. */
  ghostChars: number;
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
  /** Buffer names must not collide between concurrent sends. */
  private pasteSeq = 0;

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
    if (t.kind === "pane") {
      // A pane id is not a session, so `has-session` would answer about a
      // different object entirely. Ask the panes.
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        ["list-panes", "-a", "-F", "#{pane_id}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS },
      ).catch(() => ({ stdout: "" }));
      return stdout.split("\n").some((line) => line.trim() === t.paneId);
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
          "#{window_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}",
        ],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS },
      );
      const out: HostWindowRecord[] = [];
      const seen = new Set<string>();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [windowId, session, idxStr, windowName, pidStr, deadStr, exitStr] =
          trimmed.split("\t");
        if (!windowId || !session || idxStr === undefined) continue;
        const window = Number.parseInt(idxStr, 10);
        if (Number.isNaN(window)) continue;
        // The ADDRESS is the window id; `session:index` is only a label.
        // Trusted, not sanitised: tmux minted it, so tmux defines its form.
        const target = trustCanonicalTarget(windowId);
        // A window can hold several panes; the peer is one process, so report
        // the window once, keyed on its first pane.
        if (seen.has(target)) continue;
        seen.add(target);
        const pid = pidStr ? Number.parseInt(pidStr, 10) : Number.NaN;
        const exitStatus = exitStr ? Number.parseInt(exitStr, 10) : Number.NaN;
        out.push({
          target,
          label: `${session}:${window}`,
          session,
          window,
          windowName: windowName ?? "",
          // Still the corpse's pid when `dead` is set — see HostWindowRecord.
          pid: Number.isNaN(pid) ? null : pid,
          dead: deadStr === "1",
          exitStatus: Number.isNaN(exitStatus) ? null : exitStatus,
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
    // `canonicalHostTarget`, not the bare sanitizer: a caller may hand us a
    // window id, and `@42` must survive intact (R3, v0.11.21).
    const canonicalKey = canonicalHostTarget(opts.sessionKey);
    const args = asWindow
      ? [
          "new-window",
          "-d",
          ...(opts.windowName ? ["-n", sanitizeSessionKey(opts.windowName)] : []),
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
          ...paneCommand(opts.env, opts.command, opts.args),
        ]
      : [
          "new-session",
          "-d",
          ...(opts.windowName ? ["-n", sanitizeSessionKey(opts.windowName)] : []),
          "-s",
          canonicalKey,
          "-c",
          opts.cwd,
          "--",
          ...paneCommand(opts.env, opts.command, opts.args),
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
        ...(opts.windowName ? ["-n", sanitizeSessionKey(opts.windowName)] : []),
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
        ...paneCommand(opts.env, opts.command, opts.args),
      ];
      recreatedHome = true;
    }

    // History limit BEFORE the pane exists — it is read at pane creation
    // (see FLEET_HISTORY_LIMIT). On the recreate path the session is not there
    // yet; the post-creation set below covers its future panes, and the first
    // pane of a fresh session keeps the global limit until its first respawn.
    // That gap is documented, not hidden.
    if (asWindow && parentSession !== null && !recreatedHome) {
      await this.tmux(
        ["set-option", "-t", parentSession, "history-limit", String(FLEET_HISTORY_LIMIT)],
        QUERY_TIMEOUT_MS,
      ).catch(() => undefined);
    }

    const { env } = opts;
    let createdWindowId: CanonicalTarget | null = null;
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
      if (asWindow) createdWindowId = stdout.trim() ? trustCanonicalTarget(stdout.trim()) : null;
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

    // Keep the window when the command exits (v0.11.8).
    //
    // Without this tmux destroys the pane the moment the process ends, and the
    // pane is where the process said why it was ending. That is how the spawn
    // failure of 2026-08-07 stayed unexplained: by the time anyone looked,
    // there was nothing to look at.
    //
    // Set PER WINDOW, on windows this daemon created, and never globally — a
    // global default would leave corpses all over a human's tmux server, and
    // the ones outside the daemon's registry are the ones nobody would clear.
    //
    // ⚠ It cannot catch everything, and the gap is worth stating: a command
    // that dies BEFORE this call lands — a missing binary exits in
    // microseconds — still takes its pane with it. That case has not regressed;
    // it reports `no-such-target` exactly as before. What is now caught is the
    // command that runs, fails, and says something first.
    await this.tmux(
      ["set-window-option", "-t", effectiveKey, "remain-on-exit", "on"],
      QUERY_TIMEOUT_MS,
    ).catch((e) => {
      // Never fail a spawn over this: a peer that started is more valuable than
      // the ability to autopsy it later.
      log.warn("tmux_remain_on_exit_not_set", {
        sessionKey: effectiveKey,
        err: e instanceof Error ? e.message.split("\n")[0] : String(e),
      });
    });

    // Put the window back where the peer used to sit (#103).
    //
    // See `windowIndex` in the options for the measurement: with
    // `renumber-windows on` a create can only append, so the position has to be
    // restored by a MOVE. `-b` inserts before whoever now holds that index —
    // the peer's own successor — which is exactly the vacated place.
    //
    // Best effort by design. A restart that ends with the peer alive at the
    // wrong index is a cosmetic defect; one that fails because a move failed is
    // a real outage. So the failure is logged and swallowed, and the daemon
    // keeps reporting drift through `team_reconcile` as it did before.
    if (asWindow && opts.windowIndex !== undefined && parentSession !== null) {
      const moved = await this.tmux(
        ["move-window", "-b", "-s", effectiveKey, "-t", `${parentSession}:${opts.windowIndex}`],
        QUERY_TIMEOUT_MS,
      ).then(
        () => true,
        () => false,
      );
      if (!moved) {
        log.warn("tmux_window_index_not_restored", {
          sessionKey: effectiveKey,
          wantedIndex: opts.windowIndex,
          note: "peer is alive at the end of the session instead of its old position; team_reconcile still reports the drift",
        });
      }
    }

    const probe = await this.probePanePid(effectiveKey);
    if (probe.kind === "no-such-target") {
      log.error("tmux_spawn_target_gone", {
        sessionKey: opts.sessionKey,
        canonicalKey: effectiveKey,
        raw: probe.raw,
        note: "tmux says the target does not exist — the command exited immediately",
      });
    } else if (probe.kind === "unavailable") {
      // NOT the same as "it died", and the caller must not treat it as such.
      log.error("tmux_spawn_pid_unavailable", {
        sessionKey: opts.sessionKey,
        canonicalKey: effectiveKey,
        raw: probe.raw,
        attempts: probe.attempts,
        note: "could not determine whether anything is running — the session is left standing for inspection",
      });
    }
    return {
      sessionKey: effectiveKey,
      alive: probe.kind === "pid",
      pid: probe.kind === "pid" ? probe.pid : null,
      probe,
    };
  }

  async kill(sessionKey: string, opts: { force?: boolean } = {}): Promise<void> {
    const t = parseHostTarget(sessionKey);
    const canonical = formatHostTarget(t);

    // ARCHIVE BEFORE YOU DESTROY — enforced here, in the throat (v0.11.13).
    //
    // The rule was written into `peer_spawn` in v0.11.7 and only there, which
    // made it a rule each caller had to remember: `peer_stop` and
    // `team_reconcile` also tear panes down and did not. A rule kept by memory
    // holds until the next caller, and there is always a next caller.
    //
    // Only DEAD panes are archived, and that condition is what keeps this
    // cheap: a live peer being stopped on purpose leaves its evidence in its
    // transcript, not on a screen. A pane that already died is the only place
    // its last words exist.
    //
    // `force` does NOT skip this. Force skips WAITING, never EVIDENCE — an
    // archive is not a courtesy to the process, it is the record of what
    // happened, and the whole reason the failure of 2026-08-07 could never be
    // explained was that a teardown took it away.
    const before = await this.probePanePid(canonical, 1);
    if (before.kind === "dead") {
      const saved = await this.archivePane(
        canonical,
        `pane held exit status ${before.exitStatus ?? "unknown"} before teardown`,
      );
      if (saved === null) {
        log.error("tmux_kill_refused_no_archive", {
          sessionKey: canonical,
          exitStatus: before.exitStatus,
        });
        throw new Error(
          `Refusing to destroy '${canonical}': its process had already exited (status ${before.exitStatus ?? "unknown"}) and the pane could NOT be archived, so tearing it down would take the only record of why with it. Read it with \`tmux capture-pane -p -S -2000 -t ${canonical}\` and remove it by hand.`,
        );
      }
      log.info("tmux_kill_archived_first", {
        sessionKey: canonical,
        archivePath: saved,
        exitStatus: before.exitStatus,
      });
    }
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
        ["list-sessions", "-F", "#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS },
      );
      const records: SessionHostRecord[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [name, pidStr, deadStr, exitStr] = trimmed.split("\t");
        if (!name) continue;
        const parsedPid = pidStr ? Number.parseInt(pidStr, 10) : Number.NaN;
        const pid = Number.isNaN(parsedPid) ? null : parsedPid;
        // `alive: true` used to be unconditional: the session was listed, so it
        // was assumed to hold a running process. With `remain-on-exit` a listed
        // session can hold nothing but a dead pane still quoting its pid.
        const dead = deadStr === "1";
        const exitStatus = exitStr ? Number.parseInt(exitStr, 10) : Number.NaN;
        records.push({
          // What tmux calls it IS its address — see `trustCanonicalTarget`.
          sessionKey: trustCanonicalTarget(name),
          alive: !dead,
          pid,
          ...(dead && pid !== null
            ? {
                probe: {
                  kind: "dead" as const,
                  pid,
                  exitStatus: Number.isNaN(exitStatus) ? null : exitStatus,
                  raw: trimmed,
                },
              }
            : {}),
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
   *   1. Refuse payloads that cannot be delivered honestly — see `refusePayload`.
   *      Checked first, so a rejected payload leaves the pane untouched.
   *   2. If the pane is in copy-mode it swallows input — cancel out of it first.
   *   3. CLEAR THE INPUT LINE, and prove it is clear (v0.11.6). See below.
   *   4. Send the TEXT alone and confirm it is visible in the pane. This is the
   *      real check: it proves the keystrokes reached the application while the
   *      line is still uncommitted, so a failure costs nothing.
   *   5. Only then send Enter.
   *
   * ON STEP 3 — why the control plane empties a box it did not fill.
   *
   * These panes belong to people. Someone types half a question, walks away,
   * and the daemon arrives to inject `/compact`. Without step 3 the payload is
   * appended to their sentence and Enter submits the pair: the human loses the
   * thought, and the peer receives a command with a stranger's words glued to
   * the front. Zdeněk's instruction (2026-08-07): clear first, then send —
   * and put it in the tool, not in the callers, because a rule that each caller
   * must remember is a rule that holds until the next caller.
   *
   * What makes it safe to do is Claude Code's own kill ring: `Ctrl+Y` restores
   * a `C-u` exactly, survives an intervening payload, an Enter, and a completed
   * agent turn, and composes across dozens of strokes. The author's objection —
   * that this destroys human work — was measured and is wrong. What remains
   * true is that the human does not KNOW, which is what the two notices in
   * `announceDisplacement` are for.
   *
   * Every attempt is appended to `control/logs/sendkeys-<sessionKey>.log`.
   * Throws when the text cannot be confirmed, so callers surface a hard failure
   * instead of assuming delivery.
   */
  async sendKeys(sessionKey: string, keys: string): Promise<void> {
    const refusal = refusePayload(keys);
    if (refusal) {
      // Before any tmux call: a refused payload must not disturb the pane.
      log.error("tmux_send_keys_refused", { sessionKey, reason: refusal.reason });
      throw new Error(`send-keys to '${sessionKey}' refused — ${refusal.message}`);
    }
    // `parseHostTarget`, not `sanitizeSessionKey`. A window id IS canonical, and
    // `@` is in `UNSAFE_TARGET_CHARS` — sanitizing turned `@1011` into `_1011`
    // and tmux answered "can't find pane _1011". Every adopted peer is keyed by
    // window id, so `peer_compact` could not reach any of the twenty-three
    // (plt-designer, live compact orchestration 2026-08-05). This was the last
    // method still sanitizing a target instead of parsing it.
    const canonical = formatHostTarget(parseHostTarget(sessionKey));
    /**
     * ONE snapshot before touching the pane (revision F0.5, 2026-08-15).
     *
     * Reads everything the state table names in one display-message — one
     * server round trip, so the fields describe one instant. Only two
     * predicates REFUSE (target gone, pane dead: both are lifecycle's problem,
     * and typing into a corpse's shell was this driver's blind spot until now).
     * The rest — sync, input-off, extra panes, zoom — have ZERO recorded
     * occurrences in this fleet's history, so they are DETECTED AND LOGGED,
     * never remedied: a remedy nobody has ever seen fire is not a safeguard,
     * it is a habit (kb-ops, F0.5). The log entry is the trigger that would
     * justify writing one.
     */
    const snap = await this.paneSnapshot(canonical);
    if (!snap.found) {
      log.error("tmux_send_keys_target_gone", { sessionKey: canonical });
      throw new Error(
        `send-keys to '${canonical}' refused — the target answers as missing (display-message exits 0 with empty output for a gone target; measured 2026-08-08). If the peer's window was moved, its pane id survives: tmux list-panes -a -F '#{pane_id} #{window_id} #{pane_current_command}'`,
      );
    }
    if (snap.dead) {
      log.error("tmux_send_keys_pane_dead", { sessionKey: canonical, panePid: snap.panePid });
      throw new Error(
        `send-keys to '${canonical}' refused — the pane's process is DEAD (remain-on-exit corpse). Keys typed here reach nobody. This peer belongs to lifecycle (restart), not to delivery.`,
      );
    }
    if (!snap.clean) {
      // Measured, not treated. If one of these ever fires in production, the
      // event below is the evidence that pays for writing the remedy.
      log.warn("pane_state_dirty", { sessionKey: canonical, ...snap });
    }
    if (snap.inMode) {
      // `copy-mode -q`, NOT `send-keys -X cancel`: `-X cancel` fails with
      // "not in a mode" in clock/choose modes and the pane stays deaf, while
      // `copy-mode -q` ends every mode and works even with input off — both
      // measured on 3.4 (F0.5 expert review; the only live bug it found).
      await this.tmux(["copy-mode", "-q", "-t", canonical], SEND_KEYS_TIMEOUT_MS).catch(
        () => undefined,
      );
    }
    const inMode = snap.inMode;

    const cleared = await this.clearInputLine(canonical);
    if (cleared.kind === "stuck") {
      // Never type onto a human's text. A draft we cannot clear is a draft we
      // would corrupt, and the payload has somewhere else to be delivered from.
      await this.logSendKeys(canonical, {
        keys,
        verdict: "refused-input-not-clear",
        strokes: cleared.strokes,
        draftChars: cleared.draft.length,
      });
      log.error("tmux_send_keys_input_stuck", { sessionKey: canonical, strokes: cleared.strokes });
      throw new Error(
        `send-keys to '${canonical}' refused — the input line still holds ${cleared.draft.length} characters after ${cleared.strokes} clear strokes, and typing onto a person's unsent text is not an option. Look at the pane: tmux capture-pane -p -t ${canonical}`,
      );
    }
    if (cleared.kind === "displaced") await this.announceDisplacement(canonical, keys, cleared);

    let delivered = false;
    let attempts = 0;
    let capturedTail = "";
    let ghostChars = 0;
    let lastError: string | null = null;
    let where: DeliveryWhere = "absent";
    let boxAfterAttempt: InputLineProbe["kind"] = "empty";
    // A newline is not a formatting detail, it is the choice of route. See
    // `payloadRoute` for the measurement that makes typing one impossible.
    const route: PayloadRoute = payloadRoute(keys);
    // One retry: the common failure is a pane that was still settling, and a
    // second attempt costs a few hundred milliseconds.
    for (attempts = 1; attempts <= 2 && !delivered; attempts++) {
      try {
        if (route === "pasted") {
          await this.pasteIntoPane(canonical, keys);
        } else {
          // `-l` sends the string literally and `--` ends option parsing. Without
          // them tmux reads a payload that happens to spell a key name ("Enter",
          // "Tab", "Space") as that KEY, and a payload starting with "-" as its
          // own flag. No caller trips this today; the point is that none can.
          await this.tmux(["send-keys", "-t", canonical, "-l", "--", keys], SEND_KEYS_TIMEOUT_MS);
        }
      } catch (e) {
        // A vanished pane makes tmux itself fail. Record it and keep going to
        // the logging path — an unlogged failure is the half of the
        // 2026-08-02 incident that made it undiagnosable.
        lastError = e instanceof Error ? e.message : String(e);
        continue;
      }
      await new Promise((r) => setTimeout(r, this.sendVerifyDelayMs));
      const capture = await this.capturePane(canonical);
      capturedTail = capture.plain;
      ghostChars = capture.ghostChars;
      // v0.11.25: the payload must be in the INPUT LINE, not merely on screen.
      // See `inputLineHolds` for what the old whole-pane check was actually
      // answering, and why the palette is not part of the test.
      //
      // v0.11.38: on the GHOST-FREE view. A prompt suggestion can neither prove
      // a delivery nor block one — it is not our payload, and a box holding
      // only a suggestion is a box that took nothing, which is exactly the
      // state the retry below was written for. The log keeps the unfiltered
      // pane plus `ghostChars`, so a reader can see why the two differ.
      const probe = inputLineHolds(capture.withoutGhosts, keys);
      delivered = probe.delivered;
      where = probe.where;
      boxAfterAttempt = probe.inputLine.kind;
      /**
       * RETRY ONLY INTO AN EMPTY BOX.
       *
       * The retry was written for a pane that had not settled, where the
       * second attempt lands on nothing. Once the box holds SOMETHING that
       * fails to verify, sending again cannot improve it and can make it
       * strictly worse — a second paste stacks a second placeholder, and the
       * line count then disagrees with the payload by construction, turning a
       * recoverable "did not arrive" into an unrecoverable "arrived twice".
       *
       * So the retry is now conditional on the evidence rather than on the
       * attempt number. A box that is empty says nothing landed; anything else
       * is a state to report, not to overwrite.
       */
      if (!delivered && probe.inputLine.kind !== "empty") break;
    }

    await this.logSendKeys(canonical, {
      keys,
      paneInMode: inMode,
      attempts: attempts - 1,
      verdict: delivered ? "delivered" : "not-verified",
      // WHERE the text was, not just whether it was somewhere. `elsewhere-on-pane`
      // is the verdict the pre-v0.11.25 check would have called a success, and
      // `pasted-placeholder` is a weaker proof than `input-line` — the log has
      // to let a reader tell all three apart.
      deliveryWhere: where,
      route,
      boxAfterAttempt,
      inputLine: cleared.kind,
      clearStrokes: cleared.strokes,
      // Non-blank characters that were on the pane but drawn dim, i.e. the
      // client's own suggestion text. Recorded even when zero: it is what makes
      // "the box looked full and we called it empty" legible instead of odd.
      //
      // TWO FIELDS, NEVER A SUM. The hygiene phase and the delivery check look
      // at the same box at two different moments, and a suggestion is usually
      // present at both — adding them reports 48 characters of ghost where 24
      // were ever drawn. Two numbers over one phenomenon get a NAME each.
      ghostCharsBeforeClear: cleared.ghostChars,
      ghostCharsAtVerify: ghostChars,
      ...(cleared.kind === "displaced"
        ? { displacedDraft: cleared.draft, restorable: cleared.restorable }
        : {}),
      ...(lastError ? { error: lastError } : {}),
      capturedTail: capturedTail.slice(-240),
    });

    if (!delivered) {
      log.error("tmux_send_keys_unverified", {
        sessionKey: canonical,
        attempts: attempts - 1,
        deliveryWhere: where,
        route,
        err: lastError,
      });
      const detail =
        where === "elsewhere-on-pane"
          ? "the text IS on the pane but NOT in the input line, so pressing Enter would submit something else"
          : where === "pasted-line-count-mismatch"
            ? "the input line holds a pasted-text placeholder whose line count does not match what was sent — something is in the box, but it is not this payload"
            : `text never reached the input line${lastError ? ` (tmux: ${lastError.split("\n")[0]})` : ""}`;
      throw new Error(
        `send-keys to '${canonical}' could not be verified after ${attempts - 1} attempts — ${detail}. Look at the pane: tmux capture-pane -p -t ${canonical}`,
      );
    }
    await this.tmux(["send-keys", "-t", canonical, "Enter"], SEND_KEYS_TIMEOUT_MS);
  }

  /**
   * Empty the input line, and prove it — the hygiene phase of `sendKeys`.
   *
   * `C-u` kills to the start of the DISPLAY row, so a wrapped draft needs one
   * stroke per row; they are sent in batches to keep the round trips down
   * (measured: three in one call kill three rows). A stroke against an already
   * empty box is a no-op that leaves the kill ring intact, so over-sending
   * inside a batch costs nothing.
   *
   * Termination is exact rather than heuristic: the box's content always begins
   * on the marker line and shrinks from the bottom, so the marker line is empty
   * if and only if the whole box is.
   *
   * A pane with no marker at all is not a Claude Code input box — a shell, a
   * pager, a pane still starting. One `C-u` is still sent, because clearing the
   * line is right there too and it is what the instruction asks for, but no
   * verdict is claimed about what was there.
   */
  private async clearInputLine(target: string): Promise<ClearOutcome> {
    // GHOST-FREE, and this is the whole point of v0.11.38: what the client
    // SUGGESTS in an empty box is not text anyone typed, and `C-u` cannot
    // clear it. Read as a draft it spends every stroke and then refuses the
    // send to protect a sentence nobody wrote — measured on this peer,
    // 2026-08-28, 47 characters, `peer_compact` failed in its send stage.
    const first = await this.capturePane(target);
    const before = readInputLine(first.withoutGhosts);
    let ghostChars = first.ghostChars;
    if (before.kind === "no-marker") {
      await this.tmux(["send-keys", "-t", target, "C-u"], SEND_KEYS_TIMEOUT_MS).catch(
        () => undefined,
      );
      return { kind: "not-an-input-box", draft: "", strokes: 1, restorable: false, ghostChars };
    }
    if (before.kind === "empty") {
      return { kind: "was-empty", draft: "", strokes: 0, restorable: false, ghostChars };
    }

    let strokes = 0;
    let probe: InputLineProbe = before;
    let captured = "";
    while (strokes < MAX_CLEAR_STROKES) {
      const batch = Math.min(CLEAR_STROKE_BATCH, MAX_CLEAR_STROKES - strokes);
      await this.tmux(
        ["send-keys", "-t", target, ...Array.from({ length: batch }, () => "C-u")],
        SEND_KEYS_TIMEOUT_MS,
      ).catch(() => undefined);
      strokes += batch;
      await new Promise((r) => setTimeout(r, this.sendVerifyDelayMs));
      const capture = await this.capturePane(target);
      captured = capture.plain;
      ghostChars = capture.ghostChars;
      probe = readInputLine(capture.withoutGhosts);
      if (probe.kind !== "draft") break;
    }

    if (probe.kind === "draft") {
      return { kind: "stuck", draft: probe.text, strokes, restorable: false, ghostChars };
    }
    return {
      kind: "displaced",
      draft: before.text,
      strokes,
      // Claude Code says so itself, in the status row, right after a kill. Read
      // from the UNFILTERED pane: the hint is the client's own offer to undo,
      // not a suggestion, and losing it would understate what can be restored.
      restorable: captured.includes(KILL_RING_HINT),
      ghostChars,
    };
  }

  /**
   * Tell the human, and tell the record. Two channels, because neither is
   * enough on its own: the status-line notice reaches whoever is sitting there
   * now and vanishes; `events.jsonl` reaches whoever comes back in an hour and
   * finds their sentence gone.
   *
   * What must NOT happen is folding the notice into the payload. The payload is
   * addressed to the application in the pane — for `peer_compact` it is
   * `/compact`, which takes free text as its COMPACTION INSTRUCTIONS, so a
   * sentence meant for a person would silently steer what the peer keeps; for
   * `wake` it is a prompt for the agent. Payload belongs to the application,
   * notices belong to the human, history belongs to the log. Never mixed.
   */
  private async announceDisplacement(
    target: string,
    keys: string,
    cleared: ClearOutcome,
  ): Promise<void> {
    await this.tmux(
      ["display-message", "-d", String(HUMAN_NOTICE_MS), "-t", target, displacedDraftNotice()],
      SEND_KEYS_TIMEOUT_MS,
    ).catch(() => undefined);
    await writeEvent({
      event: "peer_input_displaced",
      level: "warn",
      details: {
        tmuxTarget: target,
        draft: cleared.draft,
        draftChars: cleared.draft.length,
        clearStrokes: cleared.strokes,
        restorableWithCtrlY: cleared.restorable,
        // Which injection displaced it — "who reached into whose window, when".
        payload: keys,
      },
    }).catch(() => undefined);
  }

  /**
   * Everything the pane-state table names, in ONE display-message.
   *
   * One server round trip = one instant; the fields cannot describe two
   * different moments (the server is single-threaded). Separator is a TAB —
   * 0x1f was tried first and display-message ESCAPES non-printables in its
   * output: the byte went out, the four characters "\037" came back, and every
   * field after the first was empty while field 0 kept passing (F0, 2026-08-14).
   *
   * `found:false` means the target answered as MISSING — display-message exits
   * 0 with empty stdout for a gone target (measured 2026-08-08, see
   * `probePanePid`). Absence must not be read as any particular state.
   */
  private async paneSnapshot(sessionKey: string): Promise<PaneStateSnapshot> {
    const SEP = "\t";
    const FMT = [
      "#{pane_dead}",
      "#{pane_pid}",
      "#{pane_current_command}",
      "#{window_id}",
      "#{pane_in_mode}",
      "#{pane_synchronized}",
      "#{pane_input_off}",
      "#{window_panes}",
      "#{window_zoomed_flag}",
      "#{pane_marked}",
      "#{alternate_on}",
    ].join(SEP);
    let raw = "";
    try {
      const { stdout } = await this.tmux(
        ["display-message", "-p", "-t", sessionKey, FMT],
        QUERY_TIMEOUT_MS,
      );
      raw = stdout.trimEnd();
    } catch {
      raw = "";
    }
    const f = raw.split(SEP);
    if (raw === "" || f.length < 11) return { ...EMPTY_PANE_SNAPSHOT };
    const snap: PaneStateSnapshot = {
      found: true,
      dead: f[0] === "1",
      panePid: Number(f[1] ?? "0") || null,
      currentCommand: f[2] ?? "",
      windowId: f[3] ?? "",
      inMode: f[4] === "1",
      synchronized: f[5] === "1",
      inputOff: f[6] === "1",
      windowPanes: Number(f[7] ?? "1") || 1,
      zoomed: f[8] === "1",
      marked: f[9] === "1",
      alternateOn: f[10] === "1",
      clean: true,
    };
    // "Clean" = nothing that has never been seen in production is present.
    // inMode is NOT part of cleanliness — humans scroll back legitimately and
    // the driver has always handled it; it is a workflow, not an anomaly.
    snap.clean =
      !snap.synchronized && !snap.inputOff && snap.windowPanes === 1 && !snap.zoomed && !snap.dead;
    return snap;
  }

  /**
   * Startup hygiene (F0.5): the two cheap checks that pay rent.
   *
   * 1. Version canary — every behavioural measurement this driver leans on
   *    (copy-mode -q semantics, display-message escaping, history-limit
   *    read-at-creation) was taken on ONE tmux version. A different version
   *    does not degrade anything by itself; it revokes the evidence, and that
   *    must be said out loud once per daemon lifetime, in the log.
   * 2. Orphan paste buffers — `pasteIntoPane` deletes its buffer in `finally`,
   *    and a daemon killed between load and delete (earlyoom, 2026-08-13)
   *    leaves a copy of a human-to-human message inside the tmux server
   *    indefinitely. Sweep buffers named by OTHER pids of this daemon.
   */
  async startupHygiene(): Promise<{
    tmuxVersion: string;
    versionMeasured: boolean;
    sweptBuffers: number;
  }> {
    let version = "";
    try {
      const { stdout } = await execFileAsync(this.tmuxBin, ["-V"], {
        ...EXEC_DEFAULTS,
        timeout: QUERY_TIMEOUT_MS,
      });
      version = stdout.trim();
    } catch {
      version = "unknown";
    }
    const versionMeasured = version === MEASURED_TMUX_VERSION;
    if (!versionMeasured) {
      log.warn("tmux_version_unmeasured", {
        found: version,
        measured: MEASURED_TMUX_VERSION,
        note: "behavioural measurements (copy-mode -q, display-message escaping, history-limit) were taken on the measured version and are unverified on this one",
      });
    }
    let swept = 0;
    try {
      const { stdout } = await this.tmux(
        ["list-buffers", "-F", "#{buffer_name}"],
        QUERY_TIMEOUT_MS,
      );
      for (const name of stdout.split("\n")) {
        const m = /^claude-bridge-(\d+)-\d+$/.exec(name.trim());
        if (!m || Number(m[1]) === process.pid) continue;
        await this.tmux(["delete-buffer", "-b", name.trim()], QUERY_TIMEOUT_MS).catch(
          () => undefined,
        );
        swept++;
      }
    } catch {
      // No server running is a normal cold start, not a hygiene failure.
    }
    if (swept > 0) log.warn("tmux_orphan_buffers_swept", { swept });
    return { tmuxVersion: version, versionMeasured, sweptBuffers: swept };
  }

  /**
   * The visible pane, in TWO views of the same instant.
   *
   * `-e` keeps the escape sequences, which is the only way to tell Claude
   * Code's greyed-out prompt suggestion from a person's unsent sentence — see
   * `decodeCapture`, where the measurements live. `plain` is byte-identical to
   * what `capture-pane -p` used to return, so the predicates that read it were
   * not disturbed by turning `-e` on.
   */
  private async capturePane(sessionKey: string): Promise<DecodedCapture> {
    try {
      const { stdout } = await this.tmux(
        ["capture-pane", "-e", "-p", "-t", sessionKey],
        QUERY_TIMEOUT_MS,
      );
      return decodeCapture(stdout);
    } catch {
      return { plain: "", withoutGhosts: "", ghostChars: 0 };
    }
  }

  /**
   * Copy what a pane is showing into `control/archive/` and return the path.
   *
   * The order this exists to enforce: ARCHIVE, THEN DESTROY — never the other
   * way, and never destroy without archiving. A tidy-up that deletes takes the
   * explanation with it, which is how the spawn failure of 2026-08-07 became
   * unreproducible: the handler killed the session holding the reason.
   *
   * Returns null if nothing could be captured. A failure to archive is a reason
   * to keep the pane, not a reason to press on.
   */
  async archivePane(sessionKey: string, reason: string): Promise<string | null> {
    const canonical = formatHostTarget(parseHostTarget(sessionKey));
    // WITH HISTORY, not just the visible screen. Measured 2026-08-08: a pane
    // whose command printed a message and exited showed an EMPTY screen —
    // `capture-pane -p` returned blank lines while the message sat in the
    // scrollback one line up. An archive of the visible screen would have
    // faithfully preserved nothing, which is worse than not archiving, because
    // it looks like evidence.
    const content = await this.capturePaneWithHistory(canonical);
    if (content.trim().length === 0) return null;
    try {
      const dir = join(controlDir(), "archive");
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = join(dir, `pane-${canonical}-${stamp}.log`);
      await appendFile(
        path,
        `# archived ${new Date().toISOString()} — target ${canonical} — ${reason}\n${content}`,
        "utf-8",
      );
      log.info("pane_archived", { sessionKey: canonical, path, reason });
      return path;
    } catch (e) {
      log.error("pane_archive_failed", {
        sessionKey: canonical,
        err: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * The pane plus its scrollback, bounded.
   *
   * `capturePane` deliberately stays visible-only — it answers "is the text I
   * just typed on the screen", and history would let a stale copy of the same
   * payload satisfy that check. Archiving wants the opposite: whatever came
   * before, because that is where a failure explains itself.
   *
   * 2000 lines is a compromise. Unbounded (`-S -`) is a peer's entire session
   * and can be enormous; the visible screen alone is routinely empty.
   */
  private async capturePaneWithHistory(sessionKey: string): Promise<string> {
    try {
      const { stdout } = await this.tmux(
        ["capture-pane", "-p", "-S", "-2000", "-t", sessionKey],
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

  /**
   * Run tmux with the payload on stdin instead of on the command line.
   *
   * `load-buffer -` exists precisely so a buffer can be filled without the
   * content becoming an argument. That matters twice over: arguments are
   * visible in `ps` to every user on the box, and these payloads are messages
   * between people. A temporary file would have the same problem with a longer
   * half-life.
   */
  private async tmuxWithStdin(args: string[], timeout: number, input: string): Promise<void> {
    const running = execFileAsync(this.tmuxBin, args, { ...EXEC_DEFAULTS, timeout });
    const child = (running as unknown as { child?: ChildProcess }).child;
    // v0.10.2 lesson, same shape as refresh-limits: if tmux dies before reading
    // its stdin, `end()` emits 'error' on the stream rather than throwing, and
    // unhandled that is a process-level crash — here, inside the daemon.
    child?.stdin?.on("error", () => undefined);
    child?.stdin?.end(input);
    await running;
  }

  /**
   * Put a multi-line payload in the box WITHOUT submitting it line by line.
   *
   * MEASURED 2026-08-09 on Claude Code 2.1.226. The same four-line payload:
   *
   * | route                                | peer's transcript                      |
   * |--------------------------------------|----------------------------------------|
   * | `paste-buffer` without `-p`          | three user messages, fourth line orphaned |
   * | `paste-buffer -p`                    | ONE user message, four lines           |
   *
   * `-p` is what makes the difference: it brackets the paste, so the client
   * reads the newlines as content rather than as Enter. Without it the payload
   * is submitted in pieces — the exact hazard that made multi-line payloads a
   * refusal until now.
   *
   * `-d` deletes the buffer once it has been pasted. The `finally` covers the
   * paths where the paste never ran, because a buffer left behind is a copy of
   * someone's message sitting in the tmux server.
   */
  private async pasteIntoPane(target: string, keys: string): Promise<void> {
    // Unique per send: two concurrent handlers must not share a buffer, and a
    // shared name would let one overwrite the other's payload between the load
    // and the paste.
    const buffer = `claude-bridge-${process.pid}-${++this.pasteSeq}`;
    try {
      await this.tmuxWithStdin(["load-buffer", "-b", buffer, "-"], SEND_KEYS_TIMEOUT_MS, keys);
      await this.tmux(
        ["paste-buffer", "-b", buffer, "-t", target, "-p", "-d"],
        SEND_KEYS_TIMEOUT_MS,
      );
    } finally {
      await this.tmux(["delete-buffer", "-b", buffer], SEND_KEYS_TIMEOUT_MS).catch(() => undefined);
    }
  }

  /**
   * tmux's own vocabulary for "that target is not there".
   *
   * Matched on the message rather than the exit code because tmux exits 1 for
   * everything — a missing session and a broken socket are indistinguishable
   * by status alone. Anything that does not match is treated as IGNORANCE, not
   * as absence, which is the safe direction: mistaking a dead pane for an
   * unreachable one costs a retry, mistaking an unreachable one for a dead
   * pane costs a live peer.
   */
  private static readonly NO_SUCH_TARGET = /can't find|no such|not found|no current/i;

  /**
   * Ask the pane what is running in it — and whether anything still is.
   *
   * Three measurements shape this, all taken 2026-08-08 and none of them
   * guessable from the tmux manual:
   *
   * 1. **A dead pane keeps reporting its corpse's pid.** With `remain-on-exit`
   *    a pane whose command exited 42 answered `pane_pid=3791183` while
   *    `/proc/3791183` was already gone. `pane_dead` and `pane_dead_status` are
   *    the honest fields, so all three are read in ONE query — asking
   *    separately would let the pane die between two answers.
   *
   * 2. **`display-message` does not fail on a missing target.** A missing
   *    session and a missing window id both return exit 0, empty stdout, empty
   *    stderr. The `NO_SUCH_TARGET` pattern below therefore almost never fires
   *    on this path: it was written expecting an error message that tmux does
   *    not send. Absence has to be read off the EMPTY ANSWER instead — a live
   *    pane always has a pid, so nothing to say means nothing is there.
   *
   * 3. Absence is still confirmed across retries rather than on the first
   *    empty answer, because a pane queried microseconds after `new-session`
   *    can be invisible for a moment. Death, by contrast, returns immediately:
   *    a pane does not come back to life.
   */
  /** Public second look — see `SessionHostDriver.probePane`. */
  async probePane(sessionKey: string): Promise<PaneProbe> {
    return this.probePanePid(formatHostTarget(parseHostTarget(sessionKey)));
  }

  private async probePanePid(sessionKey: string, attempts = 3): Promise<PaneProbe> {
    let last = "";
    let sawEmpty = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const { stdout } = await execFileAsync(
          this.tmuxBin,
          [
            "display-message",
            "-p",
            "-t",
            sessionKey,
            "#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}",
          ],
          { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS },
        );
        const raw = stdout.trim();
        if (raw.length === 0) {
          // Measurement 2: this is what "no such target" looks like here.
          sawEmpty = true;
          last = "tmux answered with nothing — the target does not exist";
        } else {
          const [pidStr, deadStr, statusStr] = raw.split("\t");
          const parsed = Number.parseInt(pidStr ?? "", 10);
          if (!Number.isNaN(parsed)) {
            if (deadStr === "1") {
              const status = Number.parseInt(statusStr ?? "", 10);
              return {
                kind: "dead",
                pid: parsed,
                exitStatus: Number.isNaN(status) ? null : status,
                raw,
              };
            }
            return { kind: "pid", pid: parsed, raw };
          }
          // Answered, but with something that is not a pid. Not absence either.
          last = `unparseable pane_pid: ${JSON.stringify(raw)}`;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const stderr = (e as { stderr?: string }).stderr ?? "";
        last = `${msg}${stderr ? ` | stderr: ${stderr.trim()}` : ""}`;
        // A target tmux says is absent will still be absent on the next try.
        if (TmuxDriver.NO_SUCH_TARGET.test(last)) return { kind: "no-such-target", raw: last };
      }
      // Only transient causes reach here, so a short pause is worth it. The
      // spawn path is the one that matters: it decides a new peer's fate on
      // this answer, and used to decide it on a single attempt.
      //
      // Left as a plain pause and NOT folded into `pollUntil` (R5, v0.11.20):
      // this loop is bounded by attempts against a flaky command, not by a
      // deadline against a world that is becoming true, and its exit conditions
      // live inside the try/catch above. Forcing it into a readiness poll would
      // buy one fewer `setTimeout` and cost the distinction between "tmux did
      // not answer" and "the pane is not there" — which is the distinction this
      // function exists for.
      if (attempt < attempts) await new Promise((r) => setTimeout(r, PROBE_RETRY_PAUSE_MS));
    }
    // Empty every time is absence, and absence is a fact. Anything else —
    // timeouts, unparseable output, a tmux that would not run — is ignorance,
    // and ignorance must not be reported as a fact: mistaking an unreachable
    // pane for a dead one costs a live peer.
    if (sawEmpty) return { kind: "no-such-target", raw: last };
    return { kind: "unavailable", raw: last, attempts };
  }

  private async readSessionPid(sessionKey: string): Promise<number | null> {
    const probe = await this.probePanePid(sessionKey);
    return probe.kind === "pid" ? probe.pid : null;
  }

  private async verifyKilled(sessionKey: string, budgetMs: number): Promise<boolean> {
    const outcome = await pollUntil<true>(
      async () => ((await this.hasSession(sessionKey)) ? null : true),
      { timeoutMs: budgetMs, pollMs: this.verifyIntervalMs },
    );
    // One last look after the budget: a session that goes in the final interval
    // is gone, and reporting it as still standing would send a caller chasing a
    // pane that is not there.
    return outcome.kind === "hit" || !(await this.hasSession(sessionKey));
  }
}

/** What one display-message reveals about a pane, in one instant. */
export type PaneStateSnapshot = {
  found: boolean;
  dead: boolean;
  panePid: number | null;
  currentCommand: string;
  windowId: string;
  inMode: boolean;
  synchronized: boolean;
  inputOff: boolean;
  windowPanes: number;
  zoomed: boolean;
  marked: boolean;
  alternateOn: boolean;
  clean: boolean;
};

const EMPTY_PANE_SNAPSHOT: PaneStateSnapshot = {
  found: false,
  dead: false,
  panePid: null,
  currentCommand: "",
  windowId: "",
  inMode: false,
  synchronized: false,
  inputOff: false,
  windowPanes: 1,
  zoomed: false,
  marked: false,
  alternateOn: false,
  clean: false,
};

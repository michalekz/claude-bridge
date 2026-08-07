/**
 * SessionHostDriver — abstraction over the operating-system mechanism
 * that keeps a Claude Code peer's terminal alive (§6/10 of the zadání).
 *
 * MVP driver = tmux (Linux, macOS, WSL2). Windows native (ConPTY /
 * `windows-native`) lands in F3. A `mock` driver backs the acceptance
 * tests and lets us verify daemon logic without a real tmux server.
 *
 * The lifecycle code inside handlers/ NEVER calls tmux (or any other
 * process host) directly — everything goes through this interface. That
 * makes adding a new driver a matter of one file, not a codebase-wide
 * grep.
 */

export interface SessionHostSpawnOptions {
  /** Human-facing key (e.g. `"hmh:alice"`) — driver uses it for lookup. */
  sessionKey: string;
  /**
   * Create the peer as a WINDOW inside this existing session instead of as a
   * session of its own.
   *
   * Adopted peers live in a window of a shared session — `hmh` holds seven.
   * Restarting one used to spawn a brand-new session named after the window,
   * so a peer quietly moved out of the team's session on its first restart
   * (plt-designer, v0.10.6 pilot). When set, the driver issues `new-window`
   * and returns the new window's id as the record's target.
   */
  inSession?: string;
  /**
   * Name for the tmux window. Without it tmux names the window after the
   * command, so every peer's window read `claude` and a human looking at the
   * session could not tell them apart (Zdeněk, 2026-08-04).
   */
  windowName?: string;
  cwd: string;
  command: string;
  args: string[];
  /** Fully-composed env — daemon has already whitelisted / stripped. */
  env: Record<string, string>;
}

/**
 * What asking the host "is anything running in there?" actually told us.
 *
 * Three answers, not two, and the third is the one that used to be missing:
 *
 *   pid             — something is running, here is its process id
 *   no-such-target  — the host says that session/pane does not exist. The
 *                     command really did exit; this is a FACT.
 *   unavailable     — we could not find out. The query timed out, the binary
 *                     failed to run, the output did not parse. This is
 *                     IGNORANCE, and it used to be reported as the fact above.
 *
 * Collapsing the last two into `null` meant a five-second timeout under load
 * and a genuinely dead process produced the same verdict — and `peer_spawn`
 * answered both by killing the session. So a transient hiccup destroyed a live
 * peer AND the evidence, which is why the failure of 2026-08-07 07:05:59 could
 * not be reproduced afterwards: the tool tidies away exactly what an
 * investigator needs.
 *
 * `raw` carries what the host actually said. A category tells you which box the
 * failure fell into; only the raw text tells you what happened.
 */
export type PaneProbe =
  | { kind: "pid"; pid: number; raw: string }
  | { kind: "no-such-target"; raw: string }
  | { kind: "unavailable"; raw: string; attempts: number };

export interface SessionHostRecord {
  sessionKey: string;
  alive: boolean;
  pid: number | null;
  /**
   * How `alive` was established. Optional so drivers that cannot probe (mock)
   * stay valid; callers that act destructively on `alive === false` MUST read
   * it and refuse to act on `unavailable`.
   */
  probe?: PaneProbe;
}

/**
 * What a target string points at.
 *
 * The daemon spawns one tmux SESSION per peer, so for everything it started
 * itself a target is a session name. Peers started by the team scripts live one
 * per tmux WINDOW inside a shared session — `hmh` holds seven of them — and
 * adoption has to be able to address those individually.
 *
 * The distinction is not cosmetic. `kill-session -t hmh:3` does not kill window
 * three; it kills the session `hmh`, and with it all seven peers. Which target
 * kind a key denotes therefore decides which tmux verb may touch it, and that
 * has to be explicit rather than inferred at the call site.
 *
 * A window is addressed by its tmux WINDOW ID (`@42`), never by
 * `session:index`. Measured 2026-08-04 on this host: `renumber-windows` is
 * `on`, so killing window 2 of {1,2,3} renumbers 3 down to 2 — an index is a
 * position, not an identity, and a stored `hmh:5` would quietly come to mean a
 * different peer. `#{window_id}` is assigned once, is unique per server, never
 * reused while the window lives, and tmux accepts it as a target directly.
 *
 * `@` is a safe discriminator: `sanitizeSessionKey` does not produce it and
 * tmux reserves it for exactly this.
 */
export type HostTarget =
  | { kind: "session"; session: string }
  | { kind: "window"; windowId: string };

const WINDOW_ID = /^@\d+$/;

export function parseHostTarget(key: string): HostTarget {
  if (WINDOW_ID.test(key)) return { kind: "window", windowId: key };
  return { kind: "session", session: sanitizeSessionKey(key) };
}

/** The canonical string form of a target — what goes into `PeerRecord.tmuxTarget`. */
export function formatHostTarget(t: HostTarget): string {
  return t.kind === "window" ? t.windowId : t.session;
}

/** A window record as adoption sees it — one entry per pane, not per session. */
export interface HostWindowRecord {
  /** tmux window id (`@42`) — the address. Stable across renumbering. */
  target: string;
  /** `session:index` — for humans reading a plan. NOT an address. */
  label: string;
  session: string;
  /** Current index. Shifts when a lower-numbered window is killed. */
  window: number;
  windowName: string;
  pid: number | null;
}

export interface SessionHostDriver {
  /** Static identifier — matches values in `state.peers[<id>].hostDriver`. */
  readonly name: "tmux" | "bg-pty" | "mock";

  /** Idempotent probe — never throws for "not found", returns false. */
  hasSession(sessionKey: string): Promise<boolean>;

  /** Spawn a fresh session/window running the given command. */
  spawn(opts: SessionHostSpawnOptions): Promise<SessionHostRecord>;

  /**
   * Terminate the entire supervised tree (bg-pty lesson — msg mrxe9t7d).
   * `force:true` skips graceful signals — kills immediately.
   */
  kill(sessionKey: string, opts?: { force?: boolean }): Promise<void>;

  /** All sessions this driver knows about. One entry per tmux SESSION. */
  listSessions(): Promise<SessionHostRecord[]>;

  /**
   * Every window, across every session — one entry per pane.
   *
   * `listSessions()` reports `#{pane_pid}` of a session, which is the active
   * pane of its active window: one pid per session however many windows it
   * holds. Adoption used that and consequently planned four peers on a fleet of
   * twenty-three, reporting `ambiguous: []` because each session had yielded
   * exactly one process. It was not choosing between candidates — it never saw
   * the other nineteen windows (fix, 2026-08-04).
   */
  listWindows?(): Promise<HostWindowRecord[]>;

  /**
   * Optional — used by the compact watchdog (F2). Absent implementations
   * can throw NotSupportedError; callers must guard.
   */
  sendKeys?(sessionKey: string, keys: string): Promise<void>;
}

export class NotSupportedByDriverError extends Error {
  constructor(driver: string, operation: string) {
    super(`Driver '${driver}' does not implement '${operation}' on this platform`);
    this.name = "NotSupportedByDriverError";
  }
}

/**
 * Bug found in the v0.10.0-rc test scenario (msg mrxk13qd): passing
 * `rc-test:alice` as a tmux session name creates a session that tmux
 * silently rewrote to `rc-test_alice`, while the daemon kept using the
 * original string as `-t` target — every follow-up operation failed
 * because `-t rc-test:alice` is parsed as `session:window` syntax by
 * tmux.
 *
 * Fix: sanitize BEFORE handing anything to tmux. The canonical form
 * uses only `[A-Za-z0-9_-]`; every other character (including `:` and
 * `.` — both meaningful in tmux target syntax) becomes `_`.
 *
 * `sessionKey` returned by `driver.spawn` is the canonical form and is
 * the one persisted to `state.peers[].tmuxTarget` — subsequent driver
 * operations always receive canonical input.
 */
const UNSAFE_TARGET_CHARS = /[^A-Za-z0-9_-]/g;

export function sanitizeSessionKey(rawName: string): string {
  const sanitized = rawName.replace(UNSAFE_TARGET_CHARS, "_");
  if (sanitized.length === 0) {
    throw new Error(`Cannot derive a tmux target from '${rawName}' — nothing safe remained`);
  }
  return sanitized;
}

/** True when the input is already in canonical form (no substitution needed). */
export function isCanonicalSessionKey(name: string): boolean {
  return name === sanitizeSessionKey(name);
}

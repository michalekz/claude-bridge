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
  /**
   * Put the new window back where the old one sat.
   *
   * WHY A MOVE AND NOT `new-window -t <session>:<index>` (measured 2026-08-15).
   * The fleet's tmux runs `renumber-windows on`, so killing a window
   * IMMEDIATELY renumbers every window after it. The freed index is therefore
   * not free — the peer's successor slid into it, and creating there fails
   * with "index in use". Measured on the real sequence:
   *
   *   start           1:designer 2:bridge-dev 3:process-dev 4:kb-dev 5:kb-ops
   *   kill 3          1:designer 2:bridge-dev 3:kb-dev 4:kb-ops     <- shifted
   *   new-window      … 5:process-dev                               <- lands last
   *
   * That is the whole of #103: a restart is a kill plus a create, and with
   * renumbering the create can only ever append. `move-window -b -t
   * <session>:<index>` inserts BEFORE whoever now holds the index, which is
   * exactly where the peer used to be. Verified restoring the original order
   * from the first, middle and last position.
   *
   * The index is measured just before the kill, not read from `desired` — a
   * stored number describes a layout that renumbering may have changed since.
   */
  windowIndex?: number;
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
  | { kind: "dead"; pid: number; exitStatus: number | null; raw: string }
  | { kind: "no-such-target"; raw: string }
  | { kind: "unavailable"; raw: string; attempts: number };

export interface SessionHostRecord {
  /**
   * The address the driver ACTUALLY used — canonical by construction, which is
   * why it carries the brand and the spawn option above does not. The option is
   * what a caller asked for; this is what exists.
   */
  sessionKey: CanonicalTarget;
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
 *
 * That rule now has a measurement behind it rather than an argument, which is
 * what lets it survive a refactor. Asked about a window index that does not
 * exist, tmux does not complain — it answers about a DIFFERENT window:
 *
 *     $ tmux display-message -p -t <session>:99 '#{pane_pid}'
 *     3791183          # exit 0, no stderr — the pid of window 1
 *
 * A stale `session:index` therefore does not fail; it silently reports someone
 * else's process as yours.
 */
export type HostTarget =
  | { kind: "session"; session: string }
  | { kind: "window"; windowId: string }
  | { kind: "pane"; paneId: string };

const WINDOW_ID = /^@\d+$/;
/**
 * A pane id is an address too — and the second half of the R3 bug.
 *
 * v0.11.21 fixed `@1011` being sanitised into `_1011`, which had made all
 * twenty-three peers unreachable to `peer_compact`. The identical hole stayed
 * open one sigil over: `%` is in `UNSAFE_TARGET_CHARS`, so `%1` became `_1` —
 * a plausible SESSION NAME. tmux then answers about whatever `_1` is, and the
 * failure is silent misdirection rather than an error.
 *
 * Found 2026-08-15 by a live test that addressed a pane directly, minutes
 * after it was written. Pane ids are also what the F0.5 review named as the
 * one identity that survives `move-window`/`join-pane` — so the lookup that
 * would tell a MOVED peer from a DEAD one has to be able to address one.
 */
const PANE_ID = /^%\d+$/;

export function parseHostTarget(key: string): HostTarget {
  if (WINDOW_ID.test(key)) return { kind: "window", windowId: key };
  if (PANE_ID.test(key)) return { kind: "pane", paneId: key };
  return { kind: "session", session: sanitizeSessionKey(key) };
}

/**
 * An address that has been through `parseHostTarget`. A plain string with a
 * brand, so it costs nothing at runtime and cannot be produced by accident.
 *
 * R3 (v0.11.21). The driver has canonicalised at every one of its public
 * entry points since v0.11.6, which is why the audit item "canonicalise
 * everywhere an address is an address" measured only 2 of 13 handler sites and
 * looked like debt: it was counting the wrong side of the boundary. A handler
 * PASSES an address; the driver RECEIVES it, and receiving is where the
 * normalising belongs.
 *
 * What the driver cannot protect is the address nobody passes to it — the six
 * places that compare a stored `tmuxTarget` against a host-reported one as
 * strings. Those maps are filled from `listSessions`/`listWindows`, so a record
 * holding a raw name finds no match, and `team_reconcile` reports a live peer
 * as a pane that no longer exists.
 *
 * A brand turns "remember to canonicalise before storing" into a compile error,
 * which is the only form of a rule that survives the next caller.
 */
/**
 * Co kill SKUTEČNĚ udělal.
 *
 * 🔴 Do 29. 8. vracel `void`, a tím byly TŘI různé konce k nerozeznání —
 * reprodukováno naživo na testovacích oknech téhož dne:
 *
 *   killed                proces peera umřel                     ✅ jediné „hotovo"
 *   target-missing        cíl neexistoval, nezabilo se NIC       (záznam byl zastaralý)
 *   unlinked-not-killed   okno patřilo i jiné session, ODLINKOVÁNO
 *                         a proces peera BĚŽÍ DÁL
 *
 * Prostřední i poslední případ se z volajícího místa tvářily jako úspěch, což
 * je přesně to, co 29. 8. nechalo starého plt-velitele běžet souběžně s novým:
 * dva procesy nad JEDNÍM transkriptem, obojí `--resume`, dvojí drain fronty.
 *
 * Vrací se to TYPEM, ne dalším logem: log jde přehlédnout, návratovou hodnotu
 * ne. `void` bylo to, co dovolilo „udělal jsem nic" splynout s „zabil jsem to".
 */
export type KillOutcome = "killed" | "target-missing" | "unlinked-not-killed";

export type CanonicalTarget = string & {
  readonly __canonicalHostTarget: unique symbol;
};

/** The canonical string form of a target — what goes into `PeerRecord.tmuxTarget`. */
export function formatHostTarget(t: HostTarget): CanonicalTarget {
  if (t.kind === "window") return t.windowId as CanonicalTarget;
  if (t.kind === "pane") return t.paneId as CanonicalTarget;
  return t.session as CanonicalTarget;
}

/** Parse and format in one step — the shape every caller actually wanted. */
export function canonicalHostTarget(key: string): CanonicalTarget {
  return formatHostTarget(parseHostTarget(key));
}

/**
 * Accept an address the HOST reported, without re-parsing it.
 *
 * The distinction this function exists to hold: `canonicalHostTarget` DERIVES
 * an address from a name we chose, and `trustCanonicalTarget` ACCEPTS one the
 * host already owns. Running the sanitizer over the second kind does not
 * normalise it — it renames it, into an address that may belong to something
 * else or to nothing.
 *
 * The trap is narrow and real. tmux rewrites `:` and `.` itself at creation, so
 * those never come back out; a SPACE does not, and `tmux new-session -s "my
 * session"` yields a session that answers to `my session` and not to
 * `my_session`. Every adopted peer's address arrives this way, so sanitising
 * host output would have broken exactly the peers the daemon did not start.
 *
 * Callers: anything reading a session name or window id out of tmux, and state
 * loaded from disk (written by a previous run from that same host output).
 */
export function trustCanonicalTarget(fromHost: string): CanonicalTarget {
  return fromHost as CanonicalTarget;
}

/** A window record as adoption sees it — one entry per pane, not per session. */
export interface HostWindowRecord {
  /**
   * tmux window id (`@42`) — the address. Stable across renumbering.
   *
   * Branded (R3, v0.11.21) so that anything indexing host state by this value
   * can only be looked up with an address of the same provenance. The map in
   * `team_reconcile` is exactly that lookup, and a raw name reaching it reads
   * as `host_missing` on a peer that is running.
   */
  target: CanonicalTarget;
  /** `session:index` — for humans reading a plan. NOT an address. */
  label: string;
  session: string;
  /** Current index. Shifts when a lower-numbered window is killed. */
  window: number;
  windowName: string;
  pid: number | null;
  /**
   * The pane's process has exited and tmux is holding the window open
   * (`remain-on-exit`). `pid` STILL CARRIES THE CORPSE'S ID — measured
   * 2026-08-08: a pane whose command exited 42 reported `pane_pid=3791183`
   * while `/proc/3791183` no longer existed.
   *
   * So anything deciding liveness from `pid` alone is wrong here, and the two
   * callers that do it — `team_adopt` matching processes to panes, and
   * `team_reconcile` comparing recorded pids to host pids — would respectively
   * adopt a corpse and report it healthy.
   */
  dead: boolean;
  /** The exited process's status, when tmux knows it. */
  exitStatus: number | null;
}

export interface SessionHostDriver {
  /** Static identifier — matches values in `state.peers[<id>].hostDriver`. */
  readonly name: "tmux" | "bg-pty" | "mock";

  /**
   * One-time checks at daemon start (F0.5): version canary, orphan-buffer
   * sweep. Optional — only hosts with a server-side state to hygiene need it.
   * Must never throw; a cold host (no server yet) is a normal answer.
   */
  startupHygiene?(): Promise<{
    tmuxVersion: string;
    versionMeasured: boolean;
    sweptBuffers: number;
  }>;

  /** Idempotent probe — never throws for "not found", returns false. */
  hasSession(sessionKey: string): Promise<boolean>;

  /** Spawn a fresh session/window running the given command. */
  spawn(opts: SessionHostSpawnOptions): Promise<SessionHostRecord>;

  /**
   * Terminate the entire supervised tree (bg-pty lesson — msg mrxe9t7d).
   * `force:true` skips graceful signals — kills immediately.
   */
  kill(sessionKey: string, opts?: { force?: boolean }): Promise<KillOutcome>;

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

  /**
   * Save what a pane is showing, and return where it was saved.
   *
   * Optional so a driver without a screen stays valid. Where it exists, the
   * rule for callers is absolute: **archive before you destroy, and if the
   * archive fails, do not destroy.** Cleanup that deletes first takes the
   * explanation with it — the spawn failure of 2026-08-07 was unreproducible
   * for exactly that reason.
   */
  archivePane?(sessionKey: string, reason: string): Promise<string | null>;

  /**
   * Ask again what is in a pane, after the fact.
   *
   * `spawn` probes once, the instant the host command returns — and a process
   * that is about to exit is still a live pid at that instant. Callers that need
   * to know whether a spawn LASTED use this for a second look. Optional so a
   * driver that cannot probe stays valid; callers must guard.
   */
  probePane?(sessionKey: string): Promise<PaneProbe>;
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

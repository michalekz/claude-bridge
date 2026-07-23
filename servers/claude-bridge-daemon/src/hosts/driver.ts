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
  cwd: string;
  command: string;
  args: string[];
  /** Fully-composed env — daemon has already whitelisted / stripped. */
  env: Record<string, string>;
}

export interface SessionHostRecord {
  sessionKey: string;
  alive: boolean;
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

  /** All sessions this driver knows about. */
  listSessions(): Promise<SessionHostRecord[]>;

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

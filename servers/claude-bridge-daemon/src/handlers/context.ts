import type { SessionHostDriver } from "../hosts/index.ts";
import type { ProcessInspector } from "../hosts/process-inspector.ts";
import type { StateDoc } from "../state.ts";

/**
 * Context passed to every handler. Kept small on purpose — handlers
 * should not reach into daemon-wide state through global side channels.
 *
 * `state` is the current state.json; mutations MUST go through
 * `applyStateChange` (below) so writes are always atomic + audit-logged.
 */
export interface HandlerContext {
  state: StateDoc;
  hostDriver: SessionHostDriver;
  daemonVersion: string;
  /**
   * Reads the live process table for `team_adopt`. Optional: production omits
   * it and the handler falls back to the `/proc` implementation, while tests
   * inject a fake table instead of needing real tmux and real peers.
   */
  processInspector?: ProcessInspector;
  /**
   * Root of the process filesystem. Optional: production uses `/proc`, tests
   * point it at a fixture directory so liveness can be faked without spawning.
   */
  procRoot?: string;
  /**
   * How long `peer_restart` waits before confirming the relaunched process is
   * still alive. Production uses 2.5 s — long enough for a failed resume to
   * exit. Tests set 0 so the suite does not pay it per case.
   */
  restartSettleMs?: number;
  /**
   * How long `peer_spawn` looks again before calling a spawn a success.
   * Tests set 0 to skip it; the default is half a second (N9, 2026-08-08).
   */
  spawnConfirmMs?: number;
  /**
   * Ceiling on the post-spawn identity measurement (v0.11.16, defect N4).
   * Production uses 5 s — 5x the 960 ms measured for the session file to
   * appear. Tests set a small value so the suite does not pay it per case.
   */
  identityTimeoutMs?: number;
  /**
   * How long step g) settles before injecting the wake keys (v0.11.18).
   *
   * Production uses 8 s — the window in which a booting Claude Code silently
   * drops keys. Tests set 0, because there is no real pane to lose them in.
   *
   * ⚠ This is a TEST knob, not a force knob. `force` does not skip this wait:
   * the delay is what makes the injection land, and after a forced restart that
   * injection is the peer's only warning that its anchor may be half-written.
   */
  wakeDelayMs?: number;
}

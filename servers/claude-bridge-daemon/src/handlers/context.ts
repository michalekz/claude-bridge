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
}

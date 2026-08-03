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
}

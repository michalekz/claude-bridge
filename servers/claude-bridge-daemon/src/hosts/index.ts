export {
  NotSupportedByDriverError,
  type SessionHostDriver,
  type SessionHostRecord,
  type SessionHostSpawnOptions,
} from "./driver.ts";
export { TmuxDriver, type TmuxDriverOptions } from "./tmux-driver.ts";
export { MockDriver, type MockDriverOptions } from "./mock-driver.ts";

import type { SessionHostDriver } from "./driver.ts";
import { TmuxDriver } from "./tmux-driver.ts";

/**
 * Resolve the default host driver for this platform. macOS + Linux MVP
 * ships with tmux; Windows native ConPTY / bg-pty drivers land in F3.
 *
 * When `CLAUDE_BRIDGE_DAEMON_HOST=mock`, callers can inject their own
 * MockDriver — the daemon never reaches here.
 */
export function defaultHostDriver(): SessionHostDriver {
  if (process.platform === "win32") {
    throw new Error("Windows native host driver ships in v0.10.0 F3+. Use WSL2 (tmux) for now.");
  }
  return new TmuxDriver();
}

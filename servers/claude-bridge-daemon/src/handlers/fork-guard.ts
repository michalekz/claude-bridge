import type { SessionHostDriver } from "../hosts/index.ts";
import type { StateDoc } from "../state.ts";

/**
 * fork-guard — refuse spawning / resuming a peer whose sessionId is
 * already live somewhere (§5.1 zadání, evidence: 3 duplicate JSONL
 * transcripts for the designer session on 2026-07-23).
 *
 * Signals checked, in order (any positive = live):
 *   1. `state.peers[sessionId].status === "live"` — daemon's own record
 *   2. host driver `hasSession(sessionKey)` — tmux says the window still
 *      exists (catches supervisor respawn immediately)
 *
 * PID / `/proc` scan is deferred to beta hardening — the two signals
 * above catch every failure mode the alpha post-mortem produced.
 */

export interface ForkGuardHit {
  reason: "state_live" | "host_alive";
  details: Record<string, unknown>;
}

export interface ForkGuardOptions {
  /** Registry key of the peer about to be spawned — renamed in R3 (v0.11.21). */
  handle: string;
  sessionKey: string;
}

export async function forkGuard(
  state: StateDoc,
  driver: SessionHostDriver,
  opts: ForkGuardOptions,
): Promise<ForkGuardHit | null> {
  const record = state.peers[opts.handle];
  // `restarting` blocks too (v0.11.18): a peer between "get ready" and its stop
  // is still running, and a spawn onto that handle would be a fork with the
  // paperwork in order. `peer_restart` does not block itself on this — by the
  // time it spawns, its own stop has moved the record to `stopped`, which is the
  // honest reading: nothing is running.
  if (
    record &&
    (record.observed.status === "live" ||
      record.observed.status === "starting" ||
      record.observed.status === "restarting")
  ) {
    return {
      reason: "state_live",
      details: {
        handle: opts.handle,
        recordedStatus: record.observed.status,
        tmuxTarget: record.observed.tmuxTarget,
      },
    };
  }
  if (await driver.hasSession(opts.sessionKey)) {
    return {
      reason: "host_alive",
      details: {
        sessionKey: opts.sessionKey,
        hostDriver: driver.name,
      },
    };
  }
  return null;
}

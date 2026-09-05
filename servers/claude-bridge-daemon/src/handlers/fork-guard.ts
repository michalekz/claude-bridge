import type { SessionHostDriver } from "../hosts/index.ts";
import type { StateDoc } from "../state.ts";

/**
 * fork-guard — refuse to start a SECOND process for a peer that already runs
 * (§5.1 zadání, evidence: 3 duplicate JSONL transcripts for the designer
 * session on 2026-07-23).
 *
 * 🔴 THE GUARD ASKED THE WRONG QUESTION UNTIL 2026-09-05.
 *
 * Both of its signals were about the REGISTRY KEY and the HOST KEY, so it
 * answered "is this handle busy?" — while its name, its docstring and the
 * incident it was written for are all about "is this SESSION already running?".
 * Those two are the same question only when the key happens to name the peer.
 *
 * Measured on the live fleet the morning it was found:
 *
 *     state.peers      25 of 26 keyed by sessionId (adopted), 1 by name (spawn)
 *     teams/mic.json   peers named "mic-velitel", "mic-marketing", …
 *     tmux             5 sessions — ai, etl, mic, oxy, plt — peers are WINDOWS
 *                      inside them; NO session is named after a peer
 *
 * So for `team_layout apply:true` on team `mic`, for each of the nine adopted,
 * running peers:
 *
 *     signal 1  state.peers["mic-velitel"]      → undefined   (key is a UUID)
 *     signal 2  hasSession("mic-velitel")       → false       (it is a window)
 *     ⇒ both pass, nine spawns proceed against nine live peers
 *
 * That is the exact fork this module exists to prevent, and it was reachable
 * through the daemon's own declarative tool. The question left open on 09-04
 * — "nine refusals or nine duplicates, I cannot tell you which" — is answered:
 * nine duplicates.
 *
 * Signals now, in order (any positive = live, first hit wins):
 *   1. `state.peers[handle]` is live/starting/restarting — a repeat spawn
 *      under the same key
 *   2. a live record whose `observed.name` equals the display name — the same
 *      peer under a DIFFERENT key, which is the case above
 *   3. a live record whose measured `observed.sessionId` equals the transcript
 *      we are about to resume — the literal fork: two processes, one transcript
 *   4. host driver `hasSession(sessionKey)` — tmux still holds the window
 *
 * 📌 EVERY SIGNAL ADDED HERE IS AN EXTRA REFUSAL. This change cannot make the
 * guard permissive; it can only make it refuse more. So the risk it carries is
 * a false refusal — which is loud, immediate and recoverable — and never a
 * fork, which is silent and is not. That asymmetry is why the new signals go in
 * before the readers are rewired: a guard is the one place where being wrong in
 * the cautious direction is cheap.
 *
 * A stopped record never blocks: `peer_restart` and `team_layout`'s resume path
 * both stop first, so the record reads `stopped` by the time they spawn. That
 * is the honest reading — nothing is running.
 */

export interface ForkGuardHit {
  reason: "state_live" | "name_live" | "identity_live" | "host_alive";
  details: Record<string, unknown>;
}

export interface ForkGuardOptions {
  /** Registry key of the peer about to be spawned — renamed in R3 (v0.11.21). */
  handle: string;
  sessionKey: string;
  /**
   * The name the peer will introduce itself as. Usually equal to `sessionKey`,
   * but they are different things: one addresses a window, the other names a
   * peer, and signal 2 is about the peer.
   */
  displayName?: string;
  /** The transcript this spawn would resume, when it resumes one. */
  resumeSessionId?: string | null;
}

/** live / starting / restarting — anything that is or is about to be a process. */
function isRunning(status: string): boolean {
  return status === "live" || status === "starting" || status === "restarting";
}

export async function forkGuard(
  state: StateDoc,
  driver: SessionHostDriver,
  opts: ForkGuardOptions,
): Promise<ForkGuardHit | null> {
  const record = state.peers[opts.handle];
  if (record && isRunning(record.observed.status)) {
    return {
      reason: "state_live",
      details: {
        handle: opts.handle,
        recordedStatus: record.observed.status,
        tmuxTarget: record.observed.tmuxTarget,
      },
    };
  }

  // The same peer under a different key. `find` is safe here in a way it is not
  // in `resolvePeerRef`: this is a guard, so the FIRST live peer wearing this
  // name is already reason enough to refuse — a second one would not change the
  // answer, only the wording.
  const name = opts.displayName ?? opts.sessionKey;
  const byName = Object.values(state.peers).find(
    (r) => r.observed.name === name && isRunning(r.observed.status),
  );
  if (byName) {
    return {
      reason: "name_live",
      details: {
        handle: opts.handle,
        displayName: name,
        liveHandle: byName.handle,
        recordedStatus: byName.observed.status,
        tmuxTarget: byName.observed.tmuxTarget,
      },
    };
  }

  // Two processes on one transcript — the 2026-07-23 incident itself. Only a
  // MEASURED identity counts: a remembered one may name a session that has
  // since been replaced, and refusing on it would block a legitimate resume.
  if (opts.resumeSessionId) {
    const byIdentity = Object.values(state.peers).find(
      (r) =>
        r.observed.sessionId === opts.resumeSessionId &&
        r.observed.identity === "measured" &&
        isRunning(r.observed.status),
    );
    if (byIdentity) {
      return {
        reason: "identity_live",
        details: {
          handle: opts.handle,
          resumeSessionId: opts.resumeSessionId,
          liveHandle: byIdentity.handle,
          recordedStatus: byIdentity.observed.status,
          tmuxTarget: byIdentity.observed.tmuxTarget,
        },
      };
    }
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

import { requestFromPeer, restartAcks } from "./ack-protocol.ts";

/**
 * The courtesy half of RESTARTING a peer: ask it to tidy up, wait, then stop it.
 *
 * The wording is where this differs from a stop, and the difference is not
 * cosmetic. A peer told to stop is leaving. A peer told to restart IS COMING
 * BACK, with its transcript, in a minute — so it should not spend that minute
 * writing a farewell anchor. It should put its work down where it will find it
 * again.
 *
 * Told the wrong thing, a peer does the wrong preparation. That is the entire
 * reason this is a separate message and not `requestStop` with another reason
 * string.
 *
 * The mechanism underneath is `ack-protocol.ts`, shared with `peer_compact` and
 * `peer_stop`. Third user, no third copy — the copy is how the first one
 * drifted (`team_stop`, five schema mismatches, never delivered once).
 */

export { restartAcks };

import { DEFAULT_PARK_WORK_TIMEOUT_MS } from "./ack-protocol.ts";

/**
 * How long a peer gets between "get ready" and the stop.
 *
 * Jedno sdílené číslo pro všechny tři cesty — viz `DEFAULT_PARK_WORK_TIMEOUT_MS`
 * v `ack-protocol.ts`, kde jsou i měření. Do 31. 8. tu stálo 120 s s vlastním
 * komentářem „NOT MEASURED… the one measurement nearby says 122 s": číslo
 * o dvě vteřiny MENŠÍ než jediný známý případ té práce. Sobotní vlna na něm
 * shodila tři restarty.
 */
export const DEFAULT_RESTART_READY_TIMEOUT_MS = DEFAULT_PARK_WORK_TIMEOUT_MS;
export const DEFAULT_RESTART_READY_POLL_MS = 500;

/**
 * ⚠ REMOVED in the same release that added it (v0.11.18), by measurement.
 *
 * The design gave the stop that follows a ready-ack a short window of its own,
 * on the reasoning that a peer which has just said it is ready only has to
 * confirm. Measured on a live peer: the ready-ack took 30 s because it is a
 * full agent turn, and the stop-request needed another one. Fifteen seconds was
 * not a low number, it was the wrong question — so `peer_restart` now asks
 * ONCE and carries the measurement forward. See the `skipCourtesy` comment
 * there.
 *
 * Kept as a note rather than deleted silently: the estimate was labelled, the
 * acceptance run existed to test it, and it failed. That is the process working.
 */

export function restartThreadId(sessionId: string, now: number = Date.now()): string {
  return `restart:${sessionId}:${now.toString(36)}`;
}

/**
 * Ask a peer to get ready to be restarted.
 *
 * Two things this message must get across, and both are easy to lose:
 *   - you are coming back, so park rather than conclude;
 *   - not acking is safe — nothing is killed, the restart simply does not
 *     happen. A peer that believes it will be killed anyway has every reason to
 *     ack early, and an early ack is the one failure this whole protocol cannot
 *     detect.
 */
export async function requestRestartReady(
  peerId: string,
  threadId: string,
  reason: string | null,
): Promise<string> {
  return requestFromPeer(
    peerId,
    threadId,
    [
      "Restart requested by the control plane. You are COMING BACK — your session is",
      "resumed with its transcript, so park your work where you will find it again",
      "rather than winding it down.",
      "",
      "Finish or park the current turn, flush your anchor and memory, then write",
      "~/.claude-bridge/control/restart-ack/<sessionId>.json containing:",
      "",
      `    {"threadId": "${threadId}"}`,
      "",
      "Nothing is stopped until that file appears. If you do NOT ack, nothing is",
      "stopped either: the restart is reported as failed and you keep running,",
      "untouched. So take the time you need — do not ack before your work is durable.",
      "",
      "The `threadId` matters: an ack that answers a DIFFERENT request is refused.",
      "An empty `touch` still works — it is accepted on freshness alone.",
      reason ? `\nReason given: ${reason}` : "",
    ]
      .join("\n")
      .trimEnd(),
  );
}

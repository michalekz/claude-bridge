import { DEFAULT_PARK_WORK_TIMEOUT_MS, requestFromPeer, stopAcks } from "./ack-protocol.ts";

/**
 * The courtesy half of stopping a peer: ask, wait, then kill.
 *
 * A peer holds things a `kill` destroys — an anchor it has not written, a
 * memory it has not flushed, a half-finished turn. The stop request is the
 * chance to put them down safely. That is all this module is: the wording of
 * the request and the two numbers around it. The mechanism underneath is
 * `ack-protocol.ts`, shared with `peer_compact`.
 *
 * It has never run. `team_stop` has carried a private implementation of this
 * protocol since v0.10.1 whose request envelope disagrees with the message
 * schema in five places, so the message was written, indexed by nothing, and
 * read by no one. Measured 2026-08-08:
 *
 *     from → object, want string     kind → "stop-request", not in the enum
 *     to   → object, want string     sentAt → missing (it wrote `ts`)
 *     content → object, want string
 *
 * and on the live host: no `stop-ack/` directory, zero `peer_stop_requested`
 * events, ever. The defect is latent rather than observed — nobody ran the
 * graceful branch — but its effect would have been that every peer times out
 * and `stoppedCleanly:false` reads as "the peer did not answer" when the truth
 * is "the peer was never asked".
 */

/**
 * How long a peer gets between "please stop" and the kill.
 *
 * 120 s, inherited from `team_stop`, and the reasoning is the compact one: the
 * peer is not pressing a button. It parks its work, writes an anchor, flushes
 * memory. The measured anchor time on a live peer is 122 s (2026-08-06), which
 * is why compact waits 300 s — a stop asks for less, but not for seconds.
 *
 * A timeout shorter than the work does not protect anything. It just reports a
 * failure for something that was going fine.
 */
// Sdílené číslo — viz `DEFAULT_PARK_WORK_TIMEOUT_MS` v `ack-protocol.ts`.
// Je to táž práce (zaparkovat tah, dopsat kotvu) a tři kopie se rozešly:
// `peer_compact` měl 300 s od 28. 8., tohle zůstalo na 120 s do 31. 8.
export const DEFAULT_STOP_ACK_TIMEOUT_MS = DEFAULT_PARK_WORK_TIMEOUT_MS;
export const DEFAULT_STOP_ACK_POLL_MS = 500;

export { stopAcks };

export function stopThreadId(sessionId: string, now: number = Date.now()): string {
  return `stop:${sessionId}:${now.toString(36)}`;
}

/**
 * Ask a peer to stand down.
 *
 * The wording matters more than it looks: this message is the only warning a
 * peer gets, and what it does in the next two minutes is decided entirely by
 * what this text tells it to do.
 */
export async function requestStop(
  peerId: string,
  threadId: string,
  reason: string | null,
): Promise<string> {
  return requestFromPeer(
    peerId,
    threadId,
    [
      "Stop requested by the control plane. Park or finish what you are doing, flush your",
      "anchor and memory, then write ~/.claude-bridge/control/stop-ack/<sessionId>.json containing:",
      "",
      `    {"threadId": "${threadId}"}`,
      "",
      "The daemon ends your session only after that file appears. Until then nothing is",
      "killed — so take the time you need, and do not ack before your work is durable.",
      "",
      "If you do NOT ack, the daemon does not kill you either: the stop is reported as",
      "failed and left for a human. A forced stop is a separate, explicit decision.",
      "",
      "The `threadId` matters: an ack that answers a DIFFERENT request is refused.",
      "An empty `touch` still works — it is accepted on freshness alone.",
      reason ? `\nReason given: ${reason}` : "",
    ]
      .join("\n")
      .trimEnd(),
  );
}

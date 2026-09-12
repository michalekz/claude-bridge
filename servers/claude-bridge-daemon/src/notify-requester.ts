import { existsSync } from "node:fs";
import { join } from "node:path";
import { bridgeRoot } from "@claude-bridge/shared";
import { requestFromPeer } from "./handlers/ack-protocol.ts";
import type { RequestEnvelope, ResultEnvelope } from "./rpc.ts";

/**
 * Tell the caller when the answer is NOT the thing they asked for (v0.11.57).
 *
 * Measured by plt-velitel on 2026-09-12, and his own correction is the point:
 * his compact order `mty2z353-cb66` did NOT get lost. It ran, it finished, and
 * `events.jsonl` holds the whole chain — `request_received` →
 * `peer_compact_anchor_requested` → `peer_compact_skipped_busy` →
 * `request_completed`, 100 seconds end to end. What got lost was the answer
 * reaching HIM. He ordered a compact, heard nothing more, and found out only
 * by measuring the target's context hours later. In his words: "the result
 * does not come back to the orderer — whoever does not read events.jsonl or
 * measure the target knows nothing".
 *
 * Fire-and-forget is the daemon's default and `control_result` exists for
 * collecting a verdict — but both require the caller to ask again, and a
 * caller who believes the thing happened has no reason to.
 *
 * WHICH RESULTS ARE WORTH A MESSAGE, and why not all of them: a plain success
 * needs no notice (the caller either waited for it or can see its effect — a
 * restarted peer says hello). What needs one is the class where SILENCE READS
 * AS SUCCESS: the operation declined to happen. A peer that was busy, a
 * context below the threshold, an ack that never came, an outright error.
 * Sending those and only those keeps the notice meaning "look at this".
 */

/** Outcomes that mean "the thing you ordered did not happen". */
const DECLINED_OUTCOMES: ReadonlySet<string> = new Set([
  "skipped_busy",
  "skipped_below_threshold",
  "preempted-unresolved",
  "queued-unresolved",
  "silent",
]);

function declinedOutcomeOf(result: ResultEnvelope): string | null {
  if (result.outcome === "error") return result.error?.code ?? "error";
  const data = result.data as { outcome?: unknown } | undefined;
  const outcome = typeof data?.outcome === "string" ? data.outcome : null;
  return outcome !== null && DECLINED_OUTCOMES.has(outcome) ? outcome : null;
}

/** The human-readable half of the verdict, if the handler wrote one. */
function noteOf(result: ResultEnvelope): string | null {
  if (result.outcome === "error") return result.error?.message ?? null;
  const data = result.data as { note?: unknown } | undefined;
  return typeof data?.note === "string" ? data.note : null;
}

/**
 * Does this caller have an inbox? Operators calling from the CLI do not, and
 * a `cli:test` id must not grow a message directory as a side effect.
 */
function hasInbox(sessionId: string): boolean {
  return existsSync(join(bridgeRoot(), "status", `${sessionId}.json`));
}

export async function notifyRequesterIfDeclined(
  req: RequestEnvelope,
  result: ResultEnvelope,
): Promise<string | null> {
  const declined = declinedOutcomeOf(result);
  if (declined === null) return null;
  const caller = req.requestedBy.sessionId;
  if (!caller || !hasInbox(caller)) return null;
  const note = noteOf(result);
  const peer =
    typeof (req.args as { peer?: unknown } | undefined)?.peer === "string"
      ? (req.args as { peer: string }).peer
      : null;
  return requestFromPeer(
    caller,
    `result:${req.id}`,
    [
      `Your \`${req.tool}\`${peer !== null ? ` on '${peer}'` : ""} finished, and it did NOT do what you asked: ${declined}.`,
      "",
      note ?? "(the handler gave no further note)",
      "",
      `Request id ${req.id} — \`control_result\` has the full verdict, and \`events.jsonl\` has the chain.`,
      "You are told because a declined operation is the case where silence reads as success.",
      "Successful ones are not announced: a restarted peer says hello by itself.",
    ].join("\n"),
  );
}

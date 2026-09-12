import { type AgentBusy, busyOf, probeAgents } from "../hosts/agents-json.ts";
import { pollUntil } from "../poll.ts";

/**
 * The turn-end gate (v0.11.51): after a peer ACKS a stop or restart, wait for
 * its session to go idle before anything is killed.
 *
 * Why the ack alone is not enough — the 2026-09-12 "mystery ack". An ack is
 * written by a tool call, which means INSIDE a turn. `peer_restart` accepted
 * oxy-marketing's ack at 07:39:55.952 and killed the session at ~07:39:56 —
 * mid-turn, before Claude Code persisted the assistant message carrying the
 * very tool_use that wrote the ack. The transcript was left with a synthetic
 * "No response requested." closure and no tool call, and the peer concluded,
 * honestly and wrongly, that it had never acked. The kill the ack authorized
 * destroyed the record of the ack. It took a byte-level fingerprint of the
 * ack file (the peer's own printf idiom: 69 bytes, no trailing newline) to
 * establish who wrote it.
 *
 * `peer_compact` has carried this lesson since v0.11.26/33 for its INJECT
 * ("writing the ack is itself a turn"). This module is the same wait applied
 * to the KILL, shared by `peer_restart` and `peer_stop`.
 *
 * POLICY — deliberately weaker than compact's `blocksInject`:
 *
 *   busy   → wait, up to `timeoutMs`. Still busy after that: the caller must
 *            NOT kill — a demonstrably running turn would lose its tail.
 *   idle   → proceed.
 *   absent / probe-failed → proceed. Refusing here would make a peer the
 *            probe cannot see (adopted without a measured session id, or the
 *            broken-PATH probe of the 2026-08-10 P0) permanently
 *            un-stoppable — and a kill on an unknown state is exactly what
 *            every kill was before this gate existed. The gate is an added
 *            courtesy on top of the ack, not the primary safety: the ack
 *            already says the peer's WORK is durable; this protects the TURN
 *            that said so.
 */
export const DEFAULT_TURN_END_TIMEOUT_MS = 90_000;
/** `claude agents --json` costs ~600 ms; a shorter gap only queues probes. */
export const DEFAULT_TURN_END_POLL_MS = 1_000;
/** Give up on OUR broken tooling, not on a slow peer — see peer-compact.ts. */
const PROBE_RETRY_ATTEMPTS = 3;

export interface TurnEndOutcome {
  /** Last observed state. `busy` here means the budget ran out on a live turn. */
  state: AgentBusy;
  /** True when the FIRST probe said busy — i.e. the gate actually waited. */
  waited: boolean;
  /** MEASURED, never the budget — poll.ts's one invariant. */
  waitedMs: number;
  probeFailures: number;
}

export async function waitForTurnEnd(
  // Optional like `PeerRecord.desired.command` — `probeAgents` defaults to
  // the ambient `claude`, and a failed probe proceeds (see POLICY above).
  claudeBin: string | undefined,
  sessionId: string | undefined,
  timeoutMs: number = DEFAULT_TURN_END_TIMEOUT_MS,
  pollMs: number = DEFAULT_TURN_END_POLL_MS,
): Promise<TurnEndOutcome> {
  const startedAt = Date.now();
  let probe = await probeAgents(claudeBin);
  let state = busyOf(probe, sessionId);
  let probeFailures = probe.ok ? 0 : 1;
  const waited = state === "busy";
  if (waited && timeoutMs > 0) {
    await pollUntil<AgentBusy>(
      async () => {
        probe = await probeAgents(claudeBin);
        state = busyOf(probe, sessionId);
        probeFailures = probe.ok ? 0 : probeFailures + 1;
        return state === "busy" ? null : state;
      },
      {
        timeoutMs,
        pollMs,
        abort: () =>
          probeFailures >= PROBE_RETRY_ATTEMPTS
            ? { aborted: true, reason: "probe_failed_repeatedly" }
            : { aborted: false },
      },
    );
  }
  return { state, waited, waitedMs: Date.now() - startedAt, probeFailures };
}

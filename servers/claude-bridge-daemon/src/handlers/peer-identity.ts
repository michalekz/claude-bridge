import { existsSync } from "node:fs";
import { join } from "node:path";
import { readAgents } from "../hosts/agents-json.ts";
import { type ProcessInspector, defaultProcessInspector } from "../hosts/process-inspector.ts";
import { pollUntil } from "../poll.ts";

/**
 * Who is actually running in that pane.
 *
 * THE DISTINCTION THIS MODULE EXISTS FOR — two different things wore one name
 * until v0.11.16, and that is the whole of defect N4:
 *
 *   HANDLE    chosen by a person or a team spec, BEFORE the peer exists.
 *             `state.peers` is keyed by it. A declarative layout cannot work
 *             without one: it has to name a peer that has not been started yet.
 *             Legitimate. Not a measurement.
 *
 *   IDENTITY  the Claude Code session UUID. Only the peer can mint it, and only
 *             after it boots. A measurement, and nothing else may produce it.
 *
 * `peer_spawn` took the handle as an argument and treated it as the identity.
 * Meanwhile the process inside the pane minted its own, which the daemon never
 * learned. Measured on the live fleet 2026-08-08: 25 of 26 registry keys were
 * genuine session UUIDs, and the one that was not belonged to the only peer
 * created by spawn rather than adoption. Adoption reads identity off reality,
 * so it cannot get this wrong.
 *
 * Both sides were "right" and nothing could reconcile them, because the key had
 * never been a measurement — it was a wish.
 *
 * So: the handle stays the key, and stops pretending. The identity is measured
 * HERE, by the same code and from the same file adoption already uses.
 */

/**
 * The address the BRIDGE knows this peer by (v0.11.18, found by acceptance).
 *
 * The daemon keys its registry by handle. The bridge — inboxes, acks, replies —
 * keys everything by the peer's own session id, because that is the only name a
 * peer knows itself by. For 24 of the 25 records on the fleet those are the same
 * string, so nothing ever noticed.
 *
 * For a handle-keyed peer they are not, and the consequence is silent: the
 * daemon writes its stop / compact / restart request into
 * `inbox/<handle>/pending/`, a directory NOBODY DRAINS, and then waits out the
 * full window for an ack from a peer that was never asked. Measured on
 * `tst-r18`, 2026-08-08: request in `inbox/tst-r18/pending/` (1 file), peer
 * draining `inbox/bbcaed51-…/pending/` (0 files), peer reporting "my inbox is
 * empty" while the daemon reported a timeout.
 *
 * The same defect family as N4 one storey up, and the same shape as the three
 * hand-built envelopes: written, addressed wrong, dropped without a word. It
 * would have hit `peer_compact` and `peer_stop` too — this is not new to the
 * restart, it is newly REACHABLE, because `team_layout` names peers by handle.
 *
 * So: the key addresses the RECORD, this addresses the PEER. Never mix them.
 */
export function bridgeIdOf(record: {
  handle: string;
  observed: { sessionId?: string | null };
}): string {
  // Reads as its own explanation since R3 (v0.11.21): the measured session id
  // if we have one, otherwise the handle — which is the right fallback only
  // because for a peer the daemon did not spawn, the two are the same string.
  return record.observed.sessionId ?? record.handle;
}

/**
 * How the peer's own MCP server learns its identity — so it is authoritative.
 *
 * `agents-json` was added in v0.11.26 and is the client's own registry rather
 * than a file we found on disk. It is recorded as a distinct source because the
 * three do not fail together: the session file can be slow while the registry
 * already knows, and the registry can be missing a peer another launcher
 * started while the file is right there. A measurement that hides which one
 * answered cannot be argued with when it turns out wrong.
 */
export interface IdentityMeasurement {
  sessionId: string;
  source: "sessions-json" | "resume-arg" | "agents-json";
  pid: number;
  measuredAt: string;
}

export type IdentityUnknownReason =
  /** Nothing is running behind the pane pid — there is nobody to ask. */
  | "pane-pid-gone"
  /** Claude processes exist, but none of them lives under our pane. */
  | "no-claude-under-pane"
  /** Ours is running and has not written its session file yet. */
  | "no-session-id"
  /**
   * The peer is not a Claude process, so there is no session id to measure.
   * Not a gap in our knowledge — a category that does not apply.
   */
  | "not-a-claude-peer";

export type IdentityOutcome =
  | { kind: "measured"; measurement: IdentityMeasurement; waitedMs: number; attempts: number }
  /** The process is running. We just do not know who it is yet. NOT a failure. */
  | { kind: "unknown"; reason: IdentityUnknownReason; waitedMs: number; attempts: number };

/**
 * Five seconds, and the number is derived rather than chosen.
 *
 * `~/.claude/sessions/<pid>.json` was measured appearing **960 ms** after spawn
 * on this host (experiment A, 2026-08-08). The cap is 5× that, which leaves
 * room for a loaded host without turning a spawn into a wait.
 *
 * It is a CEILING on a readiness poll, not a sleep. The v0.11.11 lesson: a
 * timer that is needlessly long is the same defect as one that is too short,
 * only it disguises itself as caution.
 */
export const IDENTITY_MEASURE_TIMEOUT_MS = 5_000;
export const IDENTITY_POLL_MS = 150;

export interface MeasureOptions {
  timeoutMs?: number;
  pollMs?: number;
  inspector?: ProcessInspector;
  /** Where to check that the pane process exists. Tests point it at a fixture. */
  procRoot?: string;
  /**
   * The client's own session registry, for the case where the file is late.
   * Injected so tests never shell out; defaults to `readAgents`.
   */
  readAgents?: () => Promise<readonly { sessionId: string; pid?: number }[]>;
}

/**
 * Is there a process at all behind this pid?
 *
 * The precondition, and it earns its place twice over.
 *
 * Correctness: waiting for the identity of a process that does not exist is
 * waiting for nothing. The poll would run out its whole ceiling and report
 * `unknown` — which is true, but arrived at by spending five seconds proving
 * something a single `stat` answers.
 *
 * Cost: without it, EVERY spawn pays the full ceiling whenever the peer is not
 * discoverable. Measured when this was missing: the daemon test suite went from
 * 42 s to 262 s and 42 cases timed out, because each mock spawn reports a pid
 * that never existed and the measurement dutifully waited for it.
 */
function pidExists(pid: number, procRoot: string): boolean {
  return existsSync(join(procRoot, String(pid)));
}

/**
 * Find the Claude process living under `panePid` and read its session id.
 *
 * The pane's own pid is a shell — the daemon starts peers through `/bin/sh -c`
 * with an environment prefix — so the peer is a DESCENDANT, not the pane
 * process itself. `ancestorsOf` walks up from each candidate; if our pane pid is
 * anywhere in that chain, that process is ours.
 */
async function probeOnce(
  panePid: number,
  inspector: ProcessInspector,
  askAgents?: () => Promise<readonly { sessionId: string; pid?: number }[]>,
): Promise<IdentityMeasurement | { kind: "no-claude-under-pane" | "no-session-id" }> {
  const claudes = await inspector.listClaudePeers().catch(() => []);
  let sawOurs = false;
  const ours: number[] = [];
  for (const proc of claudes) {
    if (proc.pid !== panePid) {
      const chain = [proc.ppid, ...(await inspector.ancestorsOf(proc.pid).catch(() => []))];
      if (!chain.includes(panePid)) continue;
    }
    sawOurs = true;
    ours.push(proc.pid);
    if (proc.sessionId && proc.sessionIdSource !== "none") {
      return {
        sessionId: proc.sessionId,
        source: proc.sessionIdSource,
        pid: proc.pid,
        measuredAt: new Date().toISOString(),
      };
    }
  }
  /**
   * OUR PROCESS IS THERE AND HAS NOT WRITTEN ITS SESSION FILE (v0.11.26).
   *
   * This is `no-session-id`, and it is the branch `restart_identity_unknown`
   * comes out of. The client's own registry does not depend on that file, so
   * ask it — but only HERE, once the /proc walk has already told us which pids
   * are ours. Asking first would cost ~600 ms on every probe of a peer whose
   * file was already on disk.
   */
  if (sawOurs && askAgents) {
    const agents = await askAgents().catch(() => []);
    for (const pid of ours) {
      const hit = agents.find((a) => a.pid === pid);
      if (hit) {
        return {
          sessionId: hit.sessionId,
          source: "agents-json",
          pid,
          measuredAt: new Date().toISOString(),
        };
      }
    }
  }
  // The two are different situations and the caller reports them differently:
  // nothing of ours is running yet, versus it is running and has not written
  // its session file. Collapsing them would hide a boot failure inside a
  // timeout.
  return { kind: sawOurs ? "no-session-id" : "no-claude-under-pane" };
}

/**
 * Poll until the peer says who it is, or the ceiling is reached.
 *
 * Returning `unknown` is a legitimate answer, not an error: the process is
 * running either way, and a spawn that reported failure because a file was slow
 * would be exactly the class of lie this campaign has spent two days closing —
 * only inverted.
 */
export async function measureIdentity(
  panePid: number,
  opts: MeasureOptions = {},
): Promise<IdentityOutcome> {
  const inspector = opts.inspector ?? defaultProcessInspector();
  const timeoutMs = opts.timeoutMs ?? IDENTITY_MEASURE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? IDENTITY_POLL_MS;
  const procRoot = opts.procRoot ?? "/proc";

  if (!pidExists(panePid, procRoot)) {
    return { kind: "unknown", reason: "pane-pid-gone", waitedMs: 0, attempts: 0 };
  }

  /**
   * ASKED AT MOST ONCE PER MEASUREMENT.
   *
   * The poll runs every 150 ms and this call costs about 600 ms, so an
   * unmemoised version would spend the entire 5 s ceiling queueing copies of
   * itself and answer later than the file it was meant to beat. One call, and
   * only from the branch where the file is missing.
   */
  const fetchAgents = opts.readAgents ?? readAgents;
  let agentsOnce: Promise<readonly { sessionId: string; pid?: number }[]> | null = null;
  const askAgents = () => {
    agentsOnce ??= fetchAgents();
    return agentsOnce;
  };

  // Why the last reason is carried out of the loop: the poll only knows "not
  // yet", and the two ways of not knowing — nothing of ours is running, versus
  // it is running and has not written its file — need different answers from
  // the caller. Collapsing them would hide a boot failure inside a timeout.
  let lastReason: IdentityUnknownReason = "no-claude-under-pane";
  const outcome = await pollUntil<IdentityMeasurement>(
    async () => {
      const probe = await probeOnce(panePid, inspector, askAgents);
      if ("sessionId" in probe) return probe;
      lastReason = probe.kind;
      return null;
    },
    {
      timeoutMs,
      pollMs,
      // Stop the moment the pane process goes: whatever we were waiting for is
      // not coming, and continuing would report a timeout for a death.
      abort: () =>
        pidExists(panePid, procRoot)
          ? { aborted: false }
          : { aborted: true, reason: "pane-pid-gone" },
    },
  );

  if (outcome.kind === "hit") {
    // The MEASURED elapsed time, never the budget.
    return {
      kind: "measured",
      measurement: outcome.value,
      waitedMs: outcome.waitedMs,
      attempts: outcome.attempts,
    };
  }
  return {
    kind: "unknown",
    reason: outcome.kind === "aborted" ? "pane-pid-gone" : lastReason,
    waitedMs: outcome.waitedMs,
    attempts: outcome.attempts,
  };
}

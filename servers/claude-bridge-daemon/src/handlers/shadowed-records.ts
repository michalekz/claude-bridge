import { type ProcessInspector, defaultProcessInspector } from "../hosts/process-inspector.ts";
import type { PeerRecord } from "../state.ts";

/**
 * Does this record point at the session that is actually WORKING? (v0.11.54)
 *
 * Reported from the mic fleet on 2026-09-12, and the shape is worth stating
 * plainly because every layer above it behaved correctly: `marketing` ran in
 * TWO sessions there. The daemon's record named the tmux one, which had not
 * processed anything since 10 September; the live one was a background spare
 * outside the control plane. A rolling restart therefore restarted a session
 * nobody was using, MISSED the one that was, and reported the team complete.
 * Nothing failed. The number in the report was about a different peer than the
 * one the operator had in mind.
 *
 * `team_reconcile` has seen this since v0.11.48 — its second source flags a
 * live registered session that CLAIMS a held record's name (the Ⓥ finding).
 * What was missing is that the RESTART path never asked. A drift report nobody
 * consults before acting is a report that arrives after the decision.
 *
 * The test is deliberately narrow, because a wrong positive here refuses a
 * legitimate restart: another session, alive per CC's own registry, carrying
 * the SAME NAME as the record, under a DIFFERENT session id. A peer's own
 * session is excluded by that id comparison. Session kind is NOT filtered —
 * the whole point of the mic case is that a background session was the one
 * doing the work, and "it is only a subagent" is exactly the assumption that
 * let it hide.
 */
export interface ShadowedRecord {
  handle: string;
  /** The name both sessions answer to. */
  name: string;
  /** What the record says this peer is. */
  recordedSessionId: string | null;
  /** The other session claiming that name — the one a restart would miss. */
  shadowSessionId: string;
  shadowPid: number;
  shadowKind: string | null;
}

export async function findShadowedRecords(
  records: readonly PeerRecord[],
  inspector: ProcessInspector = defaultProcessInspector(),
): Promise<ShadowedRecord[]> {
  if (!inspector.listRegisteredSessions) return [];
  let registered: Awaited<ReturnType<NonNullable<ProcessInspector["listRegisteredSessions"]>>>;
  try {
    registered = await inspector.listRegisteredSessions();
  } catch {
    // A source we cannot read says nothing. Refusing a restart because the
    // registry was unreadable would break the lifecycle over a missing file.
    return [];
  }
  const out: ShadowedRecord[] = [];
  for (const rec of records) {
    const name = rec.observed.name;
    if (!name) continue;
    const recorded = rec.observed.sessionId ?? null;
    for (const sess of registered) {
      if (sess.name !== name) continue;
      if (recorded !== null && sess.sessionId === recorded) continue;
      // A record with no measured identity cannot be compared — and a restart
      // of one is already refused earlier for a different reason.
      if (recorded === null) continue;
      out.push({
        handle: rec.handle,
        name,
        recordedSessionId: recorded,
        shadowSessionId: sess.sessionId,
        shadowPid: sess.pid,
        shadowKind: sess.kind,
      });
    }
  }
  return out;
}

/** One line an operator can act on, per shadowed record. */
export function describeShadow(s: ShadowedRecord): string {
  return `'${s.handle}': the record names session ${s.recordedSessionId}, but pid ${s.shadowPid} is ALSO live under the name '${s.name}' as session ${s.shadowSessionId}${
    s.shadowKind !== null ? ` (kind ${s.shadowKind})` : ""
  } — restarting the record would leave that one untouched and report success`;
}

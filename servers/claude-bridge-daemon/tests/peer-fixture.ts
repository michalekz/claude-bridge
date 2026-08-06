import type { PeerDesired, PeerObserved, PeerRecord } from "../src/state.ts";

/**
 * Build a peer record for a test.
 *
 * Before v0.11.0 every test spelled out a full flat record, so the twenty-odd
 * fixtures in this suite were twenty-odd copies of the schema. Splitting the
 * record into `desired`/`observed` meant editing all of them, which is the
 * signal that the duplication was already costing something — it just had not
 * been charged yet.
 *
 * The helper takes the two halves separately rather than a flat bag it sorts
 * out itself. A fixture that could write `{ team, pid }` and let the helper
 * decide where each lands would hide the very distinction these tests exist to
 * protect, and the next person adding a field would never have to think about
 * which side it belongs on.
 */
export function makePeer(
  sessionId: string,
  desired: Partial<PeerDesired> = {},
  observed: Partial<PeerObserved> = {},
): PeerRecord {
  const now = new Date().toISOString();
  return {
    sessionId,
    desired: { ...desired },
    observed: {
      name: sessionId,
      hostDriver: "mock",
      tmuxTarget: null,
      pid: null,
      status: "live",
      model: null,
      startedAt: now,
      lastUpdatedAt: now,
      ...observed,
    },
  };
}

import type { PeerRecord } from "../state.ts";

/**
 * Resolve a peer reference (session id or display name) against daemon state.
 *
 * Every lifecycle handler used to do this inline as
 * `Object.values(peers).find((r) => r.name === key)`, and `find` returns the
 * FIRST match. Names are not unique: on 2026-08-05 the live fleet held two
 * peers called `admin` (jira @1071, micronic @1083) and two called `velitel`
 * (jira @1076, micronic @1085), because adoption before v0.10.15 took the name
 * from the tmux window rather than from the peer's own registration.
 *
 * So `peer_restart peer:"velitel"` stopped and respawned whichever record
 * happened to be enumerated first — a destructive action on a silently wrong
 * target, with no way for the caller to notice. `team_restart` also orders
 * "velitel last" by matching on the name, so a duplicate skews the ordering
 * the whole rollout depends on.
 *
 * `team_adopt` already refuses to guess in exactly this situation, and says
 * why: two candidates under one pane "is the duplicate-identity failure mode
 * and guessing would launder it". This brings the rest of the daemon in line —
 * one policy, one place.
 *
 * Session ids stay unambiguous by construction, so an exact id hit short-
 * circuits before names are considered at all.
 */
export type PeerRefResolution =
  | { kind: "found"; sessionId: string; record: PeerRecord }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: PeerRefCandidate[] };

export interface PeerRefCandidate {
  sessionId: string;
  name: string;
  tmuxTarget: string | null;
  status: string;
}

/**
 * The short form of a name, relative to its team — `plt-architekt` in team
 * `plt` is `architekt`.
 *
 * Returns null when the name does not carry the team prefix. That is not an
 * error: a fleet we do not run is under no obligation to follow the
 * convention, and there a peer simply has no short form and must be addressed
 * in full. Same as a host with no domain suffix to strip.
 */
export function shortFormOf(record: PeerRecord): string | null {
  const team = record.desired.team;
  if (!team) return null;
  const prefix = `${team}-`;
  if (!record.observed.name.startsWith(prefix)) return null;
  const short = record.observed.name.slice(prefix.length);
  return short.length > 0 ? short : null;
}

/**
 * Resolve a peer reference, in the order a resolver walks a hostname.
 *
 *   1. session id           — unique by construction, always wins
 *   2. full name            — `mic-velitel`, unambiguous anywhere
 *   3. short form, own team — `velitel` asked by a peer in `mic` means
 *                             `mic-velitel`; this is the search domain
 *   4. short form, globally unique — convenience: `tester` from anywhere
 *   5. short form, several matches — refuse, and name the full forms
 *
 * `callerTeam` is what makes step 3 work. Handlers have it: the request
 * envelope carries `requestedBy.sessionId`, and that peer's record has the
 * team. Omitting it only costs the search domain — everything else still
 * resolves.
 */
export function resolvePeerRef(
  peers: Record<string, PeerRecord>,
  ref: string,
  callerTeam?: string | null,
): PeerRefResolution {
  const byId = peers[ref];
  if (byId) return { kind: "found", sessionId: ref, record: byId };

  const exact = Object.entries(peers).filter(([, rec]) => rec.observed.name === ref);
  if (exact.length === 1) {
    const [sessionId, record] = exact[0] as [string, PeerRecord];
    return { kind: "found", sessionId, record };
  }
  // A duplicated FULL name means the fleet has two peers claiming one
  // identity. Nothing can disambiguate that but the session id.
  if (exact.length > 1) return ambiguous(exact);

  const short = Object.entries(peers).filter(([, rec]) => shortFormOf(rec) === ref);
  if (short.length === 0) return { kind: "not_found" };
  if (short.length === 1) {
    const [sessionId, record] = short[0] as [string, PeerRecord];
    return { kind: "found", sessionId, record };
  }

  if (callerTeam) {
    const own = short.filter(([, rec]) => rec.desired.team === callerTeam);
    if (own.length === 1) {
      const [sessionId, record] = own[0] as [string, PeerRecord];
      return { kind: "found", sessionId, record };
    }
  }
  return ambiguous(short);
}

function ambiguous(matches: Array<[string, PeerRecord]>): PeerRefResolution {
  return {
    kind: "ambiguous",
    candidates: matches.map(([sessionId, rec]) => ({
      sessionId,
      name: rec.observed.name,
      tmuxTarget: rec.observed.tmuxTarget,
      status: rec.observed.status,
    })),
  };
}

/**
 * Message for the `ambiguous_peer` error.
 *
 * Offers the full NAMES, not the session ids — `mic-velitel` is something an
 * operator can read, retype and recognise, and it is the answer the naming
 * convention exists to give. Ids appear only when two peers share a full name,
 * where nothing else can separate them.
 */
export function ambiguousPeerMessage(ref: string, candidates: PeerRefCandidate[]): string {
  const distinctNames = new Set(candidates.map((c) => c.name));
  const list =
    distinctNames.size === candidates.length
      ? candidates.map((c) => c.name).join(", ")
      : candidates.map((c) => `${c.name} [${c.sessionId}]`).join(", ");
  return `'${ref}' matches ${candidates.length} peers — refusing to guess which one. Use the full name: ${list}`;
}

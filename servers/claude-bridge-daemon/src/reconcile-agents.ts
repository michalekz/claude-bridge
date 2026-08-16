/**
 * What exists, versus what we manage.
 *
 * WHY THIS FILE EXISTS — two incidents, five weeks apart, same shape.
 *
 * 2026-08-11: a background session Claude Code resurrected from a job it had
 * left for dead force-stopped the LIVE designer, believing it still held that
 * role. The control plane had no idea the resurrected session existed.
 *
 * 2026-08-16: a background job finished its work in 63 seconds and stayed in
 * the client's registry under the name `mic-velitel` — beside the real,
 * running `mic-velitel`. `peer_stop` on it answered `peer_not_found`, because
 * from the registry's point of view it genuinely did not exist. It was found
 * because a HUMAN noticed two identical names in a list. Eight such
 * resurrections are recorded in `~/.claude/daemon.log`; this is the only one
 * anybody saw.
 *
 * The daemon already reads `claude agents --json` (the busy probe, v0.11.26).
 * It has never compared that list with its own registry — so "a session exists
 * that we do not manage" was not a state the control plane could be in, it was
 * a thing a person happened to spot.
 *
 * THE JOIN KEY IS A UNION, and that is a scar (2026-08-11). Matching on the
 * handle alone reports every window-keyed peer as unmanaged; matching on
 * `observed.sessionId` alone reports every peer that has not been measured yet.
 * Both produce false alarms, in opposite directions, and I produced both within
 * an hour. A record answers to EITHER of its names.
 */
import type { AgentRecord } from "./hosts/agents-json.ts";
import type { StateDoc } from "./state.ts";

export type AgentReconciliation = {
  /** In the registry AND in the client's list — the normal state. */
  managed: string[];
  /**
   * The client sees it, the registry does not. The 2026-08-11 killer and the
   * 2026-08-16 duplicate were both here.
   */
  unmanaged: UnmanagedAgent[];
  /**
   * The registry has it, the client's list does not. NOT a fault by itself:
   * the client registry is scoped to `CLAUDE_CONFIG_DIR`, so a peer launched
   * under a different config is invisible to it while being perfectly alive
   * (measured 2026-08-09). Reported, never acted on.
   */
  unlisted: string[];
  /**
   * A name held by more than one live session. The state that turns a wrong
   * guess into a wrong action: address a peer by name and the answer depends
   * on which record answers first.
   */
  nameCollisions: NameCollision[];
};

export type UnmanagedAgent = {
  sessionId: string;
  name: string | null;
  cwd: string | null;
  /** `background` vs `interactive` — see `kindNote` for why it is not a verdict. */
  kind: string | null;
  /**
   * Does a REGISTERED peer already answer to this name? Then this session is
   * not merely unmanaged, it is a second claimant to somebody's role — the
   * 2026-08-11 shape, before the damage.
   */
  shadowsManagedName: boolean;
};

export type NameCollision = {
  name: string;
  sessionIds: string[];
};

/**
 * Both of a record's names. A peer may be keyed by handle (adopted, window id)
 * or carry a measured session id, and the two are frequently different strings
 * for the same peer (R3, v0.11.21).
 */
function namesOf(handle: string, sessionId: string | null | undefined): string[] {
  return sessionId && sessionId !== handle ? [handle, sessionId] : [handle];
}

/**
 * Compare the client's live session list against the registry.
 *
 * Pure — takes both sides as data so the tests can stage a resurrection
 * without one. No side effects, no probing: the caller owns the probe and
 * therefore owns the decision about what a failed probe means.
 */
export function reconcileAgents(
  state: StateDoc,
  agents: readonly AgentRecord[],
): AgentReconciliation {
  const known = new Set<string>();
  const managedNames = new Map<string, string>();
  for (const [handle, rec] of Object.entries(state.peers) as [
    string,
    StateDoc["peers"][string],
  ][]) {
    for (const n of namesOf(handle, rec.observed.sessionId)) known.add(n);
    const display = rec.observed.name ?? rec.desired.label;
    if (display) managedNames.set(display, handle);
  }

  const managed: string[] = [];
  const unmanaged: UnmanagedAgent[] = [];
  // One session id can appear TWICE in the client's list — measured 2026-08-16:
  // `mic-velitel` was listed once as `interactive` and once as `background`,
  // same session id, different cwd. Counting entries would double it.
  const seen = new Set<string>();

  for (const a of agents) {
    if (seen.has(a.sessionId)) continue;
    seen.add(a.sessionId);
    if (known.has(a.sessionId)) {
      managed.push(a.sessionId);
      continue;
    }
    const name = a.name ?? null;
    unmanaged.push({
      sessionId: a.sessionId,
      name,
      cwd: a.cwd ?? null,
      kind: a.kind ?? null,
      shadowsManagedName: name !== null && managedNames.has(name),
    });
  }

  const listed = new Set(agents.map((a) => a.sessionId));
  const unlisted = Object.entries(state.peers)
    .filter(
      ([handle, rec]) =>
        !namesOf(handle, (rec as StateDoc["peers"][string]).observed.sessionId).some((n) =>
          listed.has(n),
        ),
    )
    .map(([handle]) => handle);

  // Collisions across EVERYTHING the client can see, managed or not — a name
  // held by a managed peer and a stray session is the dangerous case, and it
  // would be invisible if only unmanaged sessions were compared with each other.
  const byName = new Map<string, Set<string>>();
  for (const a of agents) {
    if (!a.name) continue;
    const set = byName.get(a.name) ?? new Set<string>();
    set.add(a.sessionId);
    byName.set(a.name, set);
  }
  const nameCollisions: NameCollision[] = [];
  for (const [name, ids] of byName) {
    if (ids.size > 1) nameCollisions.push({ name, sessionIds: [...ids].sort() });
  }

  return {
    managed,
    unmanaged,
    unlisted,
    nameCollisions: nameCollisions.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Why `kind` must not decide anything on its own.
 *
 * `background` is not a synonym for stray: `mic-velitel` appears as a
 * background entry in the same list while being a fully managed peer (measured
 * 2026-08-11 and again 2026-08-16). The only reliable mark of "ours" is
 * membership in the registry — which is exactly what this module computes.
 */
export const KIND_IS_NOT_A_VERDICT =
  "kind:background is not evidence of a stray session; registry membership is the only reliable mark";

/** Worth telling a human about, as opposed to worth recording. */
export function needsAttention(r: AgentReconciliation): boolean {
  return r.nameCollisions.length > 0 || r.unmanaged.some((u) => u.shadowsManagedName);
}

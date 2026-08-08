/**
 * Who goes last, and on whose authority.
 *
 * A coordinator is stopped and restarted AFTER the peers it coordinates —
 * otherwise a team spends the roll without the one peer that could explain what
 * is happening to it. Both `team_stop` and `team_restart` document that rule.
 *
 * Until v0.11.13 they each implemented it, differently, and one of them did not
 * work at all:
 *
 *     team-restart.ts   (r.observed.name ?? "").includes("velitel")   ← a guess
 *     team-stop.ts      p.role === "velitel"                          ← a field
 *                                                                       the
 *                                                                       registry
 *                                                                       did not
 *                                                                       have
 *
 * `PeerRecord` carried no `role`, and `team_stop` took one as an optional
 * argument, so unless a caller happened to pass it the filter matched nothing
 * and the order came out unchanged. One documented rule, two definitions, and
 * the one that read a field was silently dead.
 *
 * So: ONE function, and it says which source decided.
 *
 *   declared — `desired.role`, stated by a human through `control_config`
 *   name     — the fallback, matched on the name, for peers nobody has declared
 *   none     — not a coordinator by either route
 *
 * Reporting the source matters as much as the ordering. Matching on a name is a
 * guess that will eventually be wrong — `mic-velitel-zastupce` contains the
 * word and is not the coordinator — and an operator reading a plan needs to see
 * whether the tool KNEW or INFERRED before trusting the order it proposes.
 */

/** What the ordering needs from a peer, whatever shape the caller holds it in. */
export interface RoleReadable {
  role?: string | null | undefined;
  name?: string | null | undefined;
}

export type RoleSource = "declared" | "name" | "none";

export const COORDINATOR_ROLE = "velitel";

export interface RoleVerdict {
  name: string | null;
  isCoordinator: boolean;
  source: RoleSource;
}

/**
 * Is this peer the coordinator, and how do we know?
 *
 * A declaration always wins, including a declaration of something else: a peer
 * declared `role: "tester"` is NOT a coordinator even if its name says velitel,
 * because someone stated otherwise on purpose.
 */
export function readRole(peer: RoleReadable): RoleVerdict {
  const name = peer.name ?? null;
  const declared = peer.role;
  if (typeof declared === "string" && declared.length > 0) {
    return { name, isCoordinator: declared === COORDINATOR_ROLE, source: "declared" };
  }
  if (name?.includes(COORDINATOR_ROLE)) {
    return { name, isCoordinator: true, source: "name" };
  }
  return { name, isCoordinator: false, source: "none" };
}

export interface OrderResult<T> {
  ordered: T[];
  /** One entry per coordinator found, with the authority behind it. */
  coordinators: RoleVerdict[];
  /** True when any coordinator was found by guessing rather than declaration. */
  inferred: boolean;
}

/**
 * Coordinators last, everything else in the order it came.
 *
 * Stable on purpose: the caller's order is the operator's order, and this
 * function's only job is to move the coordinator to the end.
 */
export function orderCoordinatorLast<T>(peers: T[], read: (p: T) => RoleReadable): OrderResult<T> {
  const verdicts = peers.map((p) => readRole(read(p)));
  const rest = peers.filter((_, i) => !verdicts[i]?.isCoordinator);
  const last = peers.filter((_, i) => verdicts[i]?.isCoordinator);
  const coordinators = verdicts.filter((v) => v.isCoordinator);
  return {
    ordered: [...rest, ...last],
    coordinators,
    inferred: coordinators.some((v) => v.source === "name"),
  };
}

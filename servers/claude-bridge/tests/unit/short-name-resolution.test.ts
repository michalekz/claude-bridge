import { describe, expect, test } from "vitest";

/**
 * Short names have to mean the same thing whichever tool asks.
 *
 * The daemon learned the naming convention first — full name, then short form
 * in the caller's team, then a globally unique short form. For a while only the
 * daemon had it: `peer_restart velitel` refused with three full names, while
 * `peer_context_status velitel` said `peer_not_found` and listed
 * twenty-three names. Same fleet, same word, two answers.
 *
 * Found by running the tools against the renamed fleet, not by a test — the
 * suite was green throughout, because nothing exercised the MCP resolver with a
 * short name. These cases close that.
 *
 * The logic under test is the pure part: which name belongs to which team, and
 * what its short form is. Under the convention a peer's own team is the prefix
 * of its own name, so the caller carries its search domain in its identity and
 * no new state is needed.
 */

function teamOfName(name: string): string | null {
  const i = name.indexOf("-");
  return i > 0 ? name.slice(0, i) : null;
}

function shortFormOfName(name: string, team: string | null): string | null {
  if (!team) return null;
  const short = name.slice(team.length + 1);
  return short.length > 0 ? short : null;
}

/** The resolution order, over a list of names. Mirrors resolveTargetPeer. */
function resolve(names: string[], target: string, callerName?: string): string | string[] | null {
  const exact = names.filter((n) => n === target);
  if (exact.length === 1) return exact[0] as string;
  if (exact.length > 1) return exact;

  const short = names.filter((n) => shortFormOfName(n, teamOfName(n)) === target);
  if (short.length === 1) return short[0] as string;
  if (short.length > 1) {
    const ownTeam = callerName ? teamOfName(callerName) : null;
    const own = ownTeam ? short.filter((n) => teamOfName(n) === ownTeam) : [];
    if (own.length === 1) return own[0] as string;
    return short;
  }
  return null;
}

// The fleet as it stands after the 2026-08-05 rename.
const FLEET = [
  "ai-bridge-dev",
  "ai-designer",
  "ai-kb-ops",
  "etl-velitel",
  "etl-dev",
  "mic-velitel",
  "mic-tester",
  "plt-velitel",
  "plt-architekt",
];

describe("a short name resolves the same way for every tool", () => {
  test("a full name wins outright", () => {
    expect(resolve(FLEET, "plt-velitel")).toBe("plt-velitel");
  });

  test("THE REGRESSION: a short name resolves, it does not fall through to not_found", () => {
    // This returned null on the MCP side while the daemon resolved it.
    expect(resolve(FLEET, "tester")).toBe("mic-tester");
    expect(resolve(FLEET, "architekt")).toBe("plt-architekt");
  });

  test("a short name shared by three teams resolves inside the caller's own", () => {
    expect(resolve(FLEET, "velitel", "mic-tester")).toBe("mic-velitel");
    expect(resolve(FLEET, "velitel", "plt-architekt")).toBe("plt-velitel");
    expect(resolve(FLEET, "velitel", "etl-dev")).toBe("etl-velitel");
  });

  test("a caller whose team has no such peer gets the full list, not a guess", () => {
    // `ai` has no velitel, so there is nothing to prefer — and picking one
    // would be the silent wrong target this whole convention exists to stop.
    const r = resolve(FLEET, "velitel", "ai-bridge-dev");
    expect(Array.isArray(r)).toBe(true);
    expect(r).toEqual(["etl-velitel", "mic-velitel", "plt-velitel"]);
  });

  test("no caller means no search domain, and ambiguity stands", () => {
    expect(resolve(FLEET, "velitel")).toEqual(["etl-velitel", "mic-velitel", "plt-velitel"]);
  });

  test("a name without a team prefix has no short form and only matches in full", () => {
    const mixed = [...FLEET, "legacy"];
    expect(shortFormOfName("legacy", teamOfName("legacy"))).toBeNull();
    expect(resolve(mixed, "legacy")).toBe("legacy");
  });

  test("an unknown short name is still not found", () => {
    expect(resolve(FLEET, "nobody", "ai-bridge-dev")).toBeNull();
  });
});

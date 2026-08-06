import { describe, expect, it } from "vitest";
import { ambiguousPeerMessage, resolvePeerRef, shortFormOf } from "../src/handlers/peer-ref.ts";
import type { PeerRecord } from "../src/state.ts";
import { makePeer } from "./peer-fixture.ts";

/**
 * Every lifecycle handler resolved a peer name with
 * `Object.values(peers).find((r) => r.name === key)`, and `find` returns the
 * FIRST match.
 *
 * Names are not unique. Measured on the live fleet 2026-08-05: two peers named
 * `admin` (jira `@1071`, micronic `@1083`) and two named `velitel` (jira
 * `@1076`, micronic `@1085`) — adoption before v0.10.15 took the name from the
 * tmux window instead of the peer's own registration, and the tmux window is
 * named per team, not globally.
 *
 * So `peer_restart peer:"velitel"` stopped and respawned whichever record was
 * enumerated first. A destructive action on a silently wrong target, with
 * nothing in the result to show it happened. `team_restart` compounds it: it
 * orders "velitel last" by matching the name, so a duplicate also skews the
 * ordering an entire rollout depends on.
 *
 * `team_adopt` already refused to guess in the same situation. These cases
 * hold the rest of the daemon to that policy.
 */

function peer(sessionId: string, name: string, tmuxTarget: string, team?: string): PeerRecord {
  return makePeer(
    sessionId,
    { ...(team ? { team } : {}) },
    {
      name,
      hostDriver: "tmux",
      tmuxTarget,
      startedAt: "2026-08-05T05:49:00.000Z",
      lastUpdatedAt: "2026-08-05T05:49:00.000Z",
    },
  );
}

// The fleet as it actually stood when this was found.
const FLEET: Record<string, PeerRecord> = {
  "7ec75e15-d168-494a-8f95-90602892f453": peer(
    "7ec75e15-d168-494a-8f95-90602892f453",
    "admin",
    "@1071",
  ),
  "0d05a607-07aa-42c1-b5f1-350c08c14adb": peer(
    "0d05a607-07aa-42c1-b5f1-350c08c14adb",
    "admin",
    "@1083",
  ),
  "d90a787e-32fa-44ef-a777-10114f0472c1": peer(
    "d90a787e-32fa-44ef-a777-10114f0472c1",
    "velitel",
    "@1076",
  ),
  "6508975c-82bc-48ac-ba43-f41145ad6ab3": peer(
    "6508975c-82bc-48ac-ba43-f41145ad6ab3",
    "velitel",
    "@1085",
  ),
  "70a00bc8-e68c-4ae2-9c8a-e1a87092454d": peer(
    "70a00bc8-e68c-4ae2-9c8a-e1a87092454d",
    "tester",
    "@1084",
  ),
};

describe("a duplicated peer name is refused, not guessed", () => {
  it("THE REGRESSION: 'velitel' matches two peers and resolves to neither", () => {
    const r = resolvePeerRef(FLEET, "velitel");
    // Before the fix this returned the jira peer and peer_restart killed it.
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map((c) => c.tmuxTarget).sort()).toEqual(["@1076", "@1085"]);
  });

  it("the error names the way out, not just the problem", () => {
    const r = resolvePeerRef(FLEET, "admin");
    if (r.kind !== "ambiguous") throw new Error("expected ambiguous");
    const msg = ambiguousPeerMessage("admin", r.candidates);
    // An operator has to be able to act on this without reading the source.
    expect(msg).toContain("matches 2 peers");
    // These two share their FULL name — this pre-convention fleet has no team
    // prefixes — so the only thing that separates them is the session id, and
    // the message has to fall back to it. Where names differ (the post-rename
    // fleet below) it offers `mic-velitel` instead, because that is what an
    // operator can read and retype. The window id is in neither: it identifies
    // a pane, and the tool takes a peer.
    expect(msg).toContain("7ec75e15-d168-494a-8f95-90602892f453");
    expect(msg).toContain("0d05a607-07aa-42c1-b5f1-350c08c14adb");
  });

  it("a session id stays unambiguous even when its name is duplicated", () => {
    // The escape hatch the error message points at has to actually work.
    const r = resolvePeerRef(FLEET, "6508975c-82bc-48ac-ba43-f41145ad6ab3");
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.record.observed.tmuxTarget).toBe("@1085");
  });

  it("a unique name still resolves", () => {
    const r = resolvePeerRef(FLEET, "tester");
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.sessionId).toBe("70a00bc8-e68c-4ae2-9c8a-e1a87092454d");
  });

  it("an unknown reference is not_found, not ambiguous", () => {
    // The two failures must stay distinguishable — they need different fixes.
    expect(resolvePeerRef(FLEET, "mic-tester").kind).toBe("not_found");
    expect(resolvePeerRef({}, "anything").kind).toBe("not_found");
  });

  it("an id that is also somebody's name resolves as the id", () => {
    // Contrived, but the precedence must be stated rather than incidental:
    // ids are unique by construction, names are not.
    const odd: Record<string, PeerRecord> = {
      "shared-key": peer("shared-key", "other", "@1"),
      "some-uuid": peer("some-uuid", "shared-key", "@2"),
    };
    const r = resolvePeerRef(odd, "shared-key");
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.record.observed.tmuxTarget).toBe("@1");
  });
});

/**
 * Zdeněk's naming model, ratified 2026-08-05: short names inside a team, fully
 * qualified names globally, and a collision forces the qualified form.
 * Internet domains, applied to a fleet.
 *
 * The fleet below is the post-rename state — `plt` for the business-systems
 * team (JIRA/OXYS/Mantis), `ai` for the agent platform, and `velitel`
 * unified across all three teams, which is precisely the case the convention
 * exists to handle.
 */
const NAMED: Record<string, PeerRecord> = {
  "id-mic-velitel": peer("id-mic-velitel", "mic-velitel", "@1085", "mic"),
  "id-plt-velitel": peer("id-plt-velitel", "plt-velitel", "@1076", "plt"),
  "id-etl-velitel": peer("id-etl-velitel", "etl-velitel", "@1068", "etl"),
  "id-mic-tester": peer("id-mic-tester", "mic-tester", "@1084", "mic"),
  "id-ai-designer": peer("id-ai-designer", "ai-designer", "@1150", "ai"),
  // A peer from a fleet that does not follow the convention: the name carries
  // no team prefix, so it has no short form at all.
  "id-foreign": peer("id-foreign", "legacy-box", "@9", "ai"),
};

describe("short names resolve like a hostname in a search domain", () => {
  it("a fully qualified name is unambiguous anywhere", () => {
    const r = resolvePeerRef(NAMED, "plt-velitel");
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.record.observed.tmuxTarget).toBe("@1076");
  });

  it("THE POINT: a short name resolves inside the caller's own team", () => {
    // `mic-tester` asking for `velitel` means its own, not one of the other two.
    const r = resolvePeerRef(NAMED, "velitel", "mic");
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.record.observed.name).toBe("mic-velitel");
  });

  it("the same short name from a different team resolves to that team's peer", () => {
    const r = resolvePeerRef(NAMED, "velitel", "etl");
    if (r.kind !== "found") throw new Error("expected found");
    expect(r.record.observed.name).toBe("etl-velitel");
  });

  it("a short name with no search domain and several matches is refused", () => {
    // Caller's team unknown (or a team with no `velitel` of its own).
    const r = resolvePeerRef(NAMED, "velitel");
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    const msg = ambiguousPeerMessage("velitel", r.candidates);
    // The way out is the qualified name — that is the whole convention.
    expect(msg).toContain("mic-velitel");
    expect(msg).toContain("plt-velitel");
    expect(msg).toContain("etl-velitel");
    // Session ids would be noise here; names distinguish these three fine.
    expect(msg).not.toContain("id-mic-velitel");
  });

  it("a globally unique short name works from anywhere, no domain needed", () => {
    const r = resolvePeerRef(NAMED, "tester", "ai");
    if (r.kind !== "found") throw new Error("expected found");
    expect(r.record.observed.name).toBe("mic-tester");
  });

  it("a name without its team prefix simply has no short form", () => {
    // Not an error — a fleet we do not run owes us no convention.
    expect(shortFormOf(NAMED["id-foreign"] as PeerRecord)).toBeNull();
    expect(shortFormOf(NAMED["id-mic-velitel"] as PeerRecord)).toBe("velitel");
    expect(resolvePeerRef(NAMED, "legacy-box").kind).toBe("found");
    expect(resolvePeerRef(NAMED, "box", "ai").kind).toBe("not_found");
  });

  it("a duplicated FULL name falls back to session ids in the message", () => {
    // Two peers claiming one identity: names cannot separate them, so the
    // error has to offer the only thing that can.
    const clash: Record<string, PeerRecord> = {
      a: peer("a", "mic-velitel", "@1", "mic"),
      b: peer("b", "mic-velitel", "@2", "mic"),
    };
    const r = resolvePeerRef(clash, "mic-velitel", "mic");
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(ambiguousPeerMessage("mic-velitel", r.candidates)).toContain("[a]");
  });
});

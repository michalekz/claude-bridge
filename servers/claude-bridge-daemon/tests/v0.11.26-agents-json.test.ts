/**
 * v0.11.26 — the third source, and the shape it actually has.
 *
 * The fixtures below are trimmed from a real `claude agents --json` on a
 * 25-entry fleet, 2026-08-09, Claude Code 2.1.226. They are kept verbatim in
 * shape because the shape is the finding: the array is NOT uniform, and the
 * non-uniformity is exactly where a careless parser turns a blocked agent into
 * an idle one.
 */
import { describe, expect, it } from "vitest";
import { busyOf, mayBeMidTurn, normaliseBusy, parseAgentsJson } from "../src/hosts/agents-json.ts";

/** Real payload, three entries, both shapes. */
const FLEET = JSON.stringify([
  {
    id: "6508975c",
    cwd: "/opt/micronic-web",
    kind: "background",
    startedAt: 1784839985334,
    sessionId: "6508975c-82bc-48ac-ba43-f41145ad6ab3",
    name: "mic-velitel",
    state: "blocked",
  },
  {
    pid: 2249670,
    cwd: "/opt/hmh/tmp/tst-c",
    kind: "interactive",
    startedAt: 1786087721227,
    sessionId: "e8197b26-f873-40fb-afec-4e370b5c0997",
    name: "tst-c-3e",
    status: "idle",
  },
  {
    pid: 1506457,
    cwd: "/opt/micronic",
    kind: "interactive",
    startedAt: 1786258721620,
    sessionId: "ac77296b-a37a-4970-b069-85862a410237",
    name: "mic-marketing",
    status: "busy",
  },
]);

describe("two shapes in one array", () => {
  it("a background entry has no status at all — and is not idle", () => {
    // THE FINDING. It reports `state: "blocked"` and carries no `status` key.
    // Reading `status` off every record yields undefined here, and undefined
    // read as idle is a blocked agent reported ready.
    const records = parseAgentsJson(FLEET);
    const background = records.find((r) => r.kind === "background");
    expect(background?.reported.status).toBeUndefined();
    expect(background?.reported.state).toBe("blocked");
    expect(background?.busy).toBe("unknown");
  });

  it("interactive entries carry pid and status", () => {
    const records = parseAgentsJson(FLEET);
    expect(records.map((r) => r.busy)).toEqual(["unknown", "idle", "busy"]);
    expect(records[1]?.pid).toBe(2249670);
    expect(records[0]?.pid).toBeUndefined();
  });
});

describe("unknown leans busy, never idle", () => {
  it("only the two words we measured mean anything", () => {
    expect(normaliseBusy({ status: "idle" })).toBe("idle");
    expect(normaliseBusy({ status: "busy" })).toBe("busy");
    expect(normaliseBusy({ status: "running" })).toBe("unknown");
    expect(normaliseBusy({ state: "blocked" })).toBe("unknown");
    expect(normaliseBusy({})).toBe("unknown");
  });

  it("a session the source never heard of is unknown, not idle", () => {
    // The list is per-client. A peer started by another launcher is simply
    // absent, and absence is ignorance — the same direction the driver takes
    // for a tmux error it cannot classify.
    const records = parseAgentsJson(FLEET);
    expect(busyOf(records, "no-such-session")).toBe("unknown");
    expect(busyOf(records, undefined)).toBe("unknown");
  });

  it("the asymmetry is the point", () => {
    // Mistaking busy for idle is how the P0 incident happened: the command was
    // queued and executed 5 min 52 s later, after an autocompact had emptied
    // the context. Mistaking idle for busy costs a retry.
    expect(mayBeMidTurn("idle")).toBe(false);
    expect(mayBeMidTurn("busy")).toBe(true);
    expect(mayBeMidTurn("unknown")).toBe(true);
  });
});

describe("an unreadable answer is no answer", () => {
  it("never throws, whatever it is handed", () => {
    expect(parseAgentsJson("")).toEqual([]);
    expect(parseAgentsJson("not json")).toEqual([]);
    expect(parseAgentsJson('{"agents":[]}')).toEqual([]);
    expect(parseAgentsJson('[null, 3, "x"]')).toEqual([]);
  });

  it("a record without a sessionId is dropped, not guessed at", () => {
    // It cannot be matched to a peer, and an unmatchable row in a lookup table
    // is a way to answer the wrong question with confidence.
    const records = parseAgentsJson(JSON.stringify([{ pid: 1, status: "idle" }]));
    expect(records).toEqual([]);
  });
});

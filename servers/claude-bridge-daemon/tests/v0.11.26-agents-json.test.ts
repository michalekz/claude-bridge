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
import {
  blocksInject,
  busyOf,
  mayBeMidTurn,
  normaliseBusy,
  parseAgentsJson,
  probeAgents,
} from "../src/hosts/agents-json.ts";

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
    //
    // v0.11.27: this used to assert `unknown`, which contradicted the name of
    // the test it lived in. `blocked` is not ignorance — it is the source
    // telling us the agent is NOT free — so it now normalises to `busy`, and
    // the assertion finally says what the title always claimed.
    const records = parseAgentsJson(FLEET);
    const background = records.find((r) => r.kind === "background");
    expect(background?.reported.status).toBeUndefined();
    expect(background?.reported.state).toBe("blocked");
    expect(background?.busy).toBe("busy");
  });

  it("interactive entries carry pid and status", () => {
    const records = parseAgentsJson(FLEET);
    expect(records.map((r) => r.busy)).toEqual(["busy", "idle", "busy"]);
    expect(records[1]?.pid).toBe(2249670);
    expect(records[0]?.pid).toBeUndefined();
  });
});

describe("unknown leans busy, never idle", () => {
  it("only the two words we measured mean anything", () => {
    expect(normaliseBusy({ status: "idle" })).toBe("idle");
    expect(normaliseBusy({ status: "busy" })).toBe("busy");
    expect(normaliseBusy({ status: "running" })).toBe("unknown");
    expect(normaliseBusy({})).toBe("unknown");
  });

  it("a state that says NOT IDLE is busy, not unknown", () => {
    // The background shape carries no `status` and says `state` instead. Both
    // measured values are positive statements that the agent is not free, and
    // folding them into `unknown` made one value carry a claim AND its denial
    // (etl-velitel, 2026-08-10). Every other `unknown` means we do not know;
    // this one meant we did.
    expect(normaliseBusy({ state: "blocked" })).toBe("busy");
    expect(normaliseBusy({ state: "working" })).toBe("busy");
  });

  it("a session missing from a GOOD list is absent, not a failed probe", () => {
    const probe = { ok: true, records: parseAgentsJson(FLEET) };
    expect(busyOf(probe, "no-such-session")).toBe("absent");
    expect(busyOf(probe, undefined)).toBe("unknown");
  });

  it("a probe that never ran outranks every other verdict", () => {
    // THE 2026-08-10 P0. A list we never received cannot be evidence that a
    // peer is missing from it — so the failure is checked first, before the
    // session id is even considered.
    const failed = { ok: false, records: [], err: "spawn claude ENOENT" };
    expect(busyOf(failed, "any-session")).toBe("probe-failed");
    expect(busyOf(failed, undefined)).toBe("probe-failed");
  });

  it("the asymmetry is the point", () => {
    // Mistaking busy for idle is how the P0 incident happened: the command was
    // queued and executed 5 min 52 s later, after an autocompact had emptied
    // the context. Mistaking idle for busy costs a retry.
    expect(mayBeMidTurn("idle")).toBe(false);
    expect(mayBeMidTurn("busy")).toBe(true);
    expect(mayBeMidTurn("unknown")).toBe(true);
  });

  it("the gate stops on busy and on a failed probe, and only on those", () => {
    // `absent` still passes — refusing on it would make every peer the source
    // cannot see permanently uncompactable, which is the deliberate deviation
    // and it stands. What changed is that "we never looked" no longer inherits
    // the pass written for "we looked and it is not there".
    expect(blocksInject("busy")).toBe(true);
    expect(blocksInject("probe-failed")).toBe(true);
    expect(blocksInject("idle")).toBe(false);
    expect(blocksInject("absent")).toBe(false);
    expect(blocksInject("unknown")).toBe(false);
  });
});

describe("the probe reports HOW it failed, not just that the list is empty", () => {
  it("a binary that does not exist is a failed probe, not an empty fleet", async () => {
    // THE TEST 94a DID NOT HAVE. Its acceptance ran against a stubbed binary —
    // a path where the defect cannot arise — so it passed while the real gate
    // was dead from the day it shipped. This one executes the real code path
    // with a name nothing can resolve, which is exactly what the daemon did
    // every time it ran `claude` under a PATH without nvm.
    const probe = await probeAgents("claude-binary-that-does-not-exist-anywhere");
    expect(probe.ok).toBe(false);
    expect(probe.records).toEqual([]);
    expect(probe.err).toBeTruthy();
    expect(busyOf(probe, "any-session")).toBe("probe-failed");
    expect(blocksInject(busyOf(probe, "any-session"))).toBe(true);
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

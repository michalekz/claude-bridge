import { mkdir } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePeer } from "./peer-fixture.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.22 — the pass R3 owed the surfaces the compiler cannot see.
 *
 * R3 (v0.11.21) cut `sessionId` into two words by MEANING and let the type
 * system enforce the cut. It enforced it everywhere it could reach: the record,
 * the wire schemas, the interfaces. Result payloads and event `details` are
 * `Record<string, unknown>`, so 46 of them went on emitting a handle under the
 * name `sessionId` and nothing complained.
 *
 * The acceptance run found it, from a live `peer_restart` reply reading
 * `{"sessionId": "tst-s1", ...}`. The test suite could not have: it asserts
 * VALUES, and a value is right whatever the key above it is called.
 *
 * So the fix is not the rename — it is this file. A rename is only as complete
 * as the type system's reach; the untyped surfaces need their own pass AND
 * their own test, or the next one goes the same way.
 *
 * THE RULE THESE TESTS ENCODE:
 *
 *   handle    addresses the RECORD — chosen before the peer exists, ours
 *   sessionId addresses the PEER   — minted by it, only after it boots
 *
 * A payload may carry both. It may never carry a handle under the second name.
 */

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
});

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-fields") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-08T19:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

/** The handle used throughout — deliberately NOT a UUID, so a leak is visible. */
const HANDLE = "fields-peer";

describe("a tool result names the handle `handle`, never `sessionId`", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-fields-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("peer_spawn", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.11.22-test");
    const driver = new mock.MockDriver({});

    const res = await handlers.dispatch(
      makeRequest("peer_spawn", {
        handle: HANDLE,
        displayName: HANDLE,
        cwd: "/tmp",
        command: "/bin/sh",
        args: ["-c", "sleep 5"],
        resume: false,
      }),
      { state: doc, hostDriver: driver, daemonVersion: "0.11.22-test" },
    );

    expect(res.outcome).toBe("ok");
    const data = res.data as Record<string, unknown>;
    expect(data["handle"]).toBe(HANDLE);
    // The assertion that matters, and the one the old suite had no reason to
    // make: not "the value is right" but "the WORD above it is right".
    expect(data).not.toHaveProperty("sessionId");
    // `measuredSessionId` keeps its longer name on purpose — it IS a session
    // id, and calling it `sessionId` would silently change what a caller
    // reading that key gets back.
    expect(data).toHaveProperty("measuredSessionId");

    await driver.kill(HANDLE).catch(() => undefined);
  });

  it("team_status, in both the compact and the verbose listing", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.11.22-test");
    doc.peers[HANDLE] = makePeer(HANDLE, {}, { name: HANDLE });
    const driver = new mock.MockDriver();

    for (const verbose of [false, true]) {
      const res = await handlers.dispatch(
        makeRequest("team_status", { verbose }, `req-status-${verbose}`),
        { state: doc, hostDriver: driver, daemonVersion: "0.11.22-test" },
      );
      expect(res.outcome).toBe("ok");
      const peers = (res.data as { peers: Array<Record<string, unknown>> }).peers;
      expect(peers[0]?.["handle"]).toBe(HANDLE);
      // Both shapes, because the compact one is a separate object literal and
      // that is exactly the kind of second copy a rename walks past.
      expect(peers[0]).not.toHaveProperty("sessionId");
    }
  });

  it("team_layout's plan, including the failure lists", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.11.22-test");
    const driver = new mock.MockDriver();

    const res = await handlers.dispatch(
      makeRequest("team_layout", {
        team: "fields",
        inline: {
          team: "fields",
          peers: [
            {
              handle: HANDLE,
              displayName: HANDLE,
              cwd: "/tmp",
              command: "/bin/sh",
              args: ["-c", "sleep 5"],
            },
          ],
        },
      }),
      { state: doc, hostDriver: driver, daemonVersion: "0.11.22-test" },
    );

    expect(res.outcome).toBe("ok");
    const data = res.data as { mode: string; diff: { plannedSpawn: unknown[] } };
    // `apply` defaults to false since v0.11.21 — a bare call is a preview.
    expect(data.mode).toBe("plan");
    expect(JSON.stringify(data.diff)).not.toContain("sessionId");
  });
});

describe("an audit event names the handle `handle` too", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-fields-ev-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("the audit trail is read by people, and it used the wrong word", async () => {
    const { handlers, state, mock } = await importAll();
    const shared = await import("@claude-bridge/shared");
    const doc = state.emptyState("0.11.22-test");
    const driver = new mock.MockDriver({});
    await mkdir(shared.controlDir(), { recursive: true });

    await handlers.dispatch(
      makeRequest("peer_spawn", {
        handle: HANDLE,
        displayName: HANDLE,
        cwd: "/tmp",
        command: "/bin/sh",
        args: ["-c", "sleep 5"],
        resume: false,
      }),
      { state: doc, hostDriver: driver, daemonVersion: "0.11.22-test" },
    );

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(shared.eventsFilePath(), "utf-8").catch(() => "");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; details?: Record<string, unknown> });
    const started = events.find((e) => e.event === "peer_started");
    expect(started).toBeDefined();
    expect(started?.details?.["handle"]).toBe(HANDLE);
    expect(started?.details).not.toHaveProperty("sessionId");

    // `by` is the CALLER, and a caller IS identified by a session id. This is
    // the distinction the sweep had to keep: not every `sessionId` was wrong,
    // only the ones holding a handle.
    const by = (started as unknown as { by?: Record<string, unknown> }).by;
    expect(by?.["sessionId"]).toBe("operator");

    await driver.kill(HANDLE).catch(() => undefined);
  });
});

/**
 * v0.11.24 — the enumeration, and why it is an enumeration.
 *
 * The v0.11.22 sweep missed `team_restart`, and the miss had a shape worth
 * naming: the file was renamed TWICE, by two different tools, and a new
 * instance of the defect appeared between them.
 *
 *   1. a mechanical pass rewrote `sessionId: <handle-expr>` -> `handle: …`
 *   2. THEN the interface field `RestartOutcome.sessionId` was renamed, and the
 *      compiler rewrote `r.sessionId` into `r.handle` — producing a fresh
 *      `sessionId: r.handle`, in a line the mechanical pass had already walked
 *      past.
 *
 * So: the mechanical pass belongs AFTER the type-driven one, never before. A
 * compiler that fixes references can manufacture exactly the pattern a regex
 * was hunting, and it does it behind the regex's back.
 *
 * The tests above cover the tools a caller reaches for first. This block covers
 * the TEAM tools, which is where the miss was — and it is deliberately a list,
 * because there is no way to ask the daemon "give me every tool that returns a
 * handle". If a new team tool is added and not listed here, nothing fails, so
 * the list carries its own reason and the failure message says what to do.
 */

const TEAM_TOOLS_RETURNING_HANDLES = [
  // Each entry: the tool, and args that reach a result WITHOUT touching a peer.
  //
  // NOTE the second `team_restart` entry. The first version of this block only
  // had the dry run — which passed against the very defect it was written for,
  // because `dryRun` returns the PLAN and the miss was in the FAILED list. A
  // test that exercises a path where the bug cannot appear is worse than no
  // test: it reports coverage it does not have. Caught by reverting the fix and
  // watching this file stay green.
  { tool: "team_restart", args: { team: "fields", dryRun: true } },
  { tool: "team_restart", args: { team: "fields", dryRun: false } },
  // `team_stop` reads a SPEC (file or inline), not the registry — so it gets
  // one. That difference is itself worth pinning: the two team tools disagree
  // about where a team comes from.
  {
    tool: "team_stop",
    args: {
      team: "fields",
      dryRun: true,
      inline: { team: "fields", peers: [{ handle: "fields-peer", displayName: "fields-peer" }] },
    },
  },
] as const;

describe("v0.11.24 — team tools name the handle `handle` too", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-fields-team-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  for (const { tool, args } of TEAM_TOOLS_RETURNING_HANDLES) {
    it(`${tool} — no \`sessionId\` anywhere in its result`, async () => {
      const { handlers, state, mock } = await importAll();
      const doc = state.emptyState("0.11.24-test");
      // A CLAUDE peer whose identity was never measured: restartable enough to
      // be attempted, and refused per-peer once it is — which is what puts an
      // entry in the `failed` list, where the v0.11.22 miss actually lived.
      doc.peers[HANDLE] = makePeer(
        HANDLE,
        { team: "fields", command: "/usr/bin/claude", cwd: "/tmp" },
        { name: HANDLE, identity: "unknown", sessionId: null },
      );
      const driver = new mock.MockDriver();

      const res = await handlers.dispatch(makeRequest(tool, args, `req-${tool}`), {
        state: doc,
        hostDriver: driver,
        daemonVersion: "0.11.24-test",
      });

      // A real run of a refusing peer answers `error` — the payload is what
      // this test is about, and it lives in `data` or in the error details.
      const body = JSON.stringify(res.data ?? res.error?.details ?? {});
      expect(body).toContain(HANDLE);
      // Whole-payload, not field-by-field: the v0.11.22 miss was in a nested
      // failure list nobody would have thought to name.
      //
      // If this fails on a tool you just added: the result carries a handle
      // under the word this project reserves for Claude session ids. Rename the
      // field to `handle` — and add the new tool to the list above, because
      // nothing else will notice it is missing.
      expect(body).not.toContain('"sessionId"');
    });
  }
});

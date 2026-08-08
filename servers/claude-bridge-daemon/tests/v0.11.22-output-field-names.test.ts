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

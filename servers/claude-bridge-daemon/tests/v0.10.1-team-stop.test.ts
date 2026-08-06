import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

async function importAll() {
  return {
    handlers: await import("../src/handlers/index.ts"),
    state: await import("../src/state.ts"),
    mock: await import("../src/hosts/mock-driver.ts"),
    shared: await import("@claude-bridge/shared"),
  };
}

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-1") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-02T15:30:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "team-stop-caller", name: "team-stop-caller" },
  };
}

describe("v0.10.1 team_stop", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-teamstop-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("dryRun returns ordered peer list without side-effects (velitel LAST via role field)", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();

    const inline = {
      team: "dryrun-team",
      peers: [
        { sessionId: "peer-velitel", displayName: "team:velitel", role: "velitel" },
        { sessionId: "peer-a", displayName: "team:alice" },
        { sessionId: "peer-b", displayName: "team:bob" },
      ],
    };

    const res = await handlers.dispatch(
      makeRequest("team_stop", { team: "dryrun-team", dryRun: true, inline }, "req-dryrun"),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect(res.outcome).toBe("ok");
    const data = res.data as {
      mode: string;
      order: Array<{ sessionId: string; role: string | null }>;
    };
    expect(data.mode).toBe("dryRun");
    // Velitel LAST (explicit role wins).
    expect(data.order.map((p) => p.sessionId)).toEqual(["peer-a", "peer-b", "peer-velitel"]);
    expect(Object.keys(doc.peers)).toHaveLength(0);
    driver.reset();
  });

  it("STOP REQUEST + pre-existing ack → peer_stopped_cleanly, state keeps peer as stopped", async () => {
    const { handlers, state, mock, shared } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();

    // Spawn a peer through the real handler so state + host are aligned.
    await handlers.dispatch(
      makeRequest(
        "peer_spawn",
        {
          sessionId: "ts-peer-1",
          displayName: "ts:one",
          cwd: "/tmp",
          command: "/bin/sleep",
          args: ["10"],
        },
        "req-spawn",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect(doc.peers["ts-peer-1"]?.observed.status).toBe("live");

    // Pre-write the ack file — simulates peer having flushed anchor + memory.
    const ackDir = join(shared.controlDir(), "stop-ack");
    await mkdir(ackDir, { recursive: true });
    await writeFile(
      join(ackDir, "ts-peer-1.json"),
      JSON.stringify({ ready: true, ts: "2026-08-02T15:30:01.000Z" }),
    );

    const inline = {
      team: "ts-team",
      peers: [{ sessionId: "ts-peer-1", displayName: "ts:one" }],
    };
    const res = await handlers.dispatch(
      makeRequest(
        "team_stop",
        {
          team: "ts-team",
          inline,
          anchorTimeoutMs: 1_500,
          ackPollMs: 100,
        },
        "req-stop",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect(res.outcome).toBe("ok");
    const data = res.data as {
      stoppedCleanly: string[];
      stoppedForced: string[];
      stoppedDead: string[];
      skipped: string[];
      failedKill: unknown[];
    };
    expect(data.stoppedCleanly).toEqual(["ts-peer-1"]);
    expect(data.stoppedForced).toEqual([]);
    expect(data.skipped).toEqual([]);
    expect(data.failedKill).toEqual([]);

    // Peer kept in state, status flipped, stoppedCleanly:true.
    const rec = doc.peers["ts-peer-1"];
    expect(rec).toBeDefined();
    expect(rec?.observed.status).toBe("stopped");
    expect(rec?.observed.stoppedCleanly).toBe(true);
    expect(rec?.observed.tmuxTarget).toBe("ts_one");
    // Host session must be gone.
    expect(await driver.hasSession("ts_one")).toBe(false);

    driver.reset();
  });

  it("no ack + force:false → skipped, peer stays live in state and on host", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();

    await handlers.dispatch(
      makeRequest(
        "peer_spawn",
        {
          sessionId: "ts-peer-2",
          displayName: "ts:two",
          cwd: "/tmp",
          command: "/bin/sleep",
          args: ["10"],
        },
        "req-spawn",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );

    const inline = {
      team: "ts-team",
      peers: [{ sessionId: "ts-peer-2", displayName: "ts:two" }],
    };
    const res = await handlers.dispatch(
      makeRequest(
        "team_stop",
        {
          team: "ts-team",
          inline,
          anchorTimeoutMs: 300,
          ackPollMs: 50,
          force: false,
        },
        "req-stop",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect(res.outcome).toBe("ok");
    const data = res.data as { stoppedCleanly: string[]; skipped: string[] };
    expect(data.stoppedCleanly).toEqual([]);
    expect(data.skipped).toEqual(["ts-peer-2"]);
    // Peer still alive on host + in state as "live" (untouched).
    expect(doc.peers["ts-peer-2"]?.observed.status).toBe("live");
    expect(await driver.hasSession("ts_two")).toBe(true);

    driver.reset();
  });

  it("dead peer (no host session) → stoppedDead, state kept with stoppedCleanly:null", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();

    // Hand-craft a state entry for a peer that has NO host session — simulates
    // a peer that died between the last daemon rehydrate and now.
    doc.peers["ts-peer-3"] = {
      sessionId: "ts-peer-3",
      desired: {
        accountProfile: null,
      },
      observed: {
        name: "ts:three",
        hostDriver: "mock",
        tmuxTarget: "ts_three",
        pid: 4242,
        status: "live",
        model: null,
        startedAt: "2026-08-02T15:00:00.000Z",
        lastUpdatedAt: "2026-08-02T15:00:00.000Z",
      },
    };

    const inline = {
      team: "ts-team",
      peers: [{ sessionId: "ts-peer-3", displayName: "ts:three" }],
    };
    const res = await handlers.dispatch(
      makeRequest(
        "team_stop",
        {
          team: "ts-team",
          inline,
          anchorTimeoutMs: 500,
          ackPollMs: 100,
        },
        "req-stop",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect(res.outcome).toBe("ok");
    const data = res.data as { stoppedDead: string[]; stoppedCleanly: string[] };
    expect(data.stoppedDead).toEqual(["ts-peer-3"]);
    expect(data.stoppedCleanly).toEqual([]);
    const rec = doc.peers["ts-peer-3"];
    expect(rec?.observed.status).toBe("stopped");
    expect(rec?.observed.stoppedCleanly).toBeNull();

    driver.reset();
  });
});

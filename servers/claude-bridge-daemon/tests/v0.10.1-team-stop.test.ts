import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHostTarget } from "../src/hosts/driver.ts";

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
        { handle: "peer-velitel", displayName: "team:velitel", role: "velitel" },
        { handle: "peer-a", displayName: "team:alice" },
        { handle: "peer-b", displayName: "team:bob" },
      ],
    };

    const res = await handlers.dispatch(
      makeRequest("team_stop", { team: "dryrun-team", dryRun: true, inline }, "req-dryrun"),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect(res.outcome).toBe("ok");
    const data = res.data as {
      mode: string;
      order: Array<{ handle: string; role: string | null }>;
    };
    expect(data.mode).toBe("dryRun");
    // Velitel LAST (explicit role wins).
    expect(data.order.map((p) => p.handle)).toEqual(["peer-a", "peer-b", "peer-velitel"]);
    expect(Object.keys(doc.peers)).toHaveLength(0);
    driver.reset();
  });

  it("STOP REQUEST → peer acks → peer_stopped_cleanly, state keeps peer as stopped", async () => {
    const { handlers, state, mock, shared } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();

    // Spawn a peer through the real handler so state + host are aligned.
    await handlers.dispatch(
      makeRequest(
        "peer_spawn",
        {
          handle: "ts-peer-1",
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

    // The peer acks AFTER the request reaches it — which is the only order the
    // protocol accepts since v0.11.15.
    //
    // This test used to pre-write the ack file, and it passed because
    // `team_stop` accepted any ack that existed. That is the v0.11.3 stale-ack
    // defect: an ack written before the request cannot be an answer to it, and
    // honouring one is how a compact ran over an anchor that belonged to an
    // earlier run. `team_stop` now sweeps before asking, so a pre-written ack is
    // correctly discarded — and the test has to behave like a peer instead.
    const ackDir = join(shared.controlDir(), "stop-ack");
    const acker = (async () => {
      await new Promise((r) => setTimeout(r, 250));
      await mkdir(ackDir, { recursive: true });
      await writeFile(join(ackDir, "ts-peer-1.json"), JSON.stringify({ ready: true }));
    })();

    const inline = {
      team: "ts-team",
      peers: [{ handle: "ts-peer-1", displayName: "ts:one" }],
    };
    const res = await handlers.dispatch(
      makeRequest(
        "team_stop",
        {
          team: "ts-team",
          inline,
          anchorTimeoutMs: 5_000,
          ackPollMs: 100,
        },
        "req-stop",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    await acker;
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
          handle: "ts-peer-2",
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
      peers: [{ handle: "ts-peer-2", displayName: "ts:two" }],
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
    // The peer is STILL RUNNING — that is the invariant, and it holds.
    expect(await driver.hasSession("ts_two")).toBe(true);
    // But the record no longer says `live` (v0.11.19).
    //
    // `team_stop` used to run its own copy of the ask/wait cycle and simply not
    // touch the record on a timeout, so a member that had been asked and had not
    // answered was indistinguishable from one nobody ever spoke to. Now the
    // shared primitive handles it, and it leaves the honest intermediate state:
    // `stopping` plus a resumable `stopRequest`. That is what makes the member
    // visible to `team_reconcile` as `stop_pending` — the hole v0.11.17 closed
    // for `peer_stop` closes here too, by sharing the code rather than by
    // remembering to copy the fix.
    expect(doc.peers["ts-peer-2"]?.observed.status).toBe("stopping");
    expect(doc.peers["ts-peer-2"]?.observed.stopRequest?.threadId).toMatch(/^stop:/);

    driver.reset();
  });

  it("dead peer (no host session) → stoppedDead, state kept with stoppedCleanly:null", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();

    // Hand-craft a state entry for a peer that has NO host session — simulates
    // a peer that died between the last daemon rehydrate and now.
    doc.peers["ts-peer-3"] = {
      handle: "ts-peer-3",
      desired: {
        accountProfile: null,
      },
      observed: {
        name: "ts:three",
        hostDriver: "mock",
        tmuxTarget: canonicalHostTarget("ts_three"),
        pid: 4242,
        status: "live",
        model: null,
        startedAt: "2026-08-02T15:00:00.000Z",
        lastUpdatedAt: "2026-08-02T15:00:00.000Z",
      },
    };

    const inline = {
      team: "ts-team",
      peers: [{ handle: "ts-peer-3", displayName: "ts:three" }],
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

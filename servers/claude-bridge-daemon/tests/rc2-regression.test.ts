import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
    driver: await import("../src/hosts/driver.ts"),
    shared: await import("@claude-bridge/shared"),
  };
}

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-1") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-07-23T13:45:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "rc2-caller", name: "rc2-caller" },
  };
}

describe("v0.10.0-rc.2 regression — T1 sessionKey + T2 stop reconcile", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-rc2-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  describe("T1: sessionKey with `:` / `.` is canonicalized end-to-end", () => {
    it("sanitizeSessionKey replaces unsafe chars with underscore", async () => {
      const { driver } = await importAll();
      expect(driver.sanitizeSessionKey("rc-test:alice")).toBe("rc-test_alice");
      expect(driver.sanitizeSessionKey("hmh.node.1")).toBe("hmh_node_1");
      expect(driver.sanitizeSessionKey("proj/team 2")).toBe("proj_team_2");
      expect(driver.sanitizeSessionKey("clean-name_1")).toBe("clean-name_1");
    });

    it("spawn stores CANONICAL tmuxTarget in state.peers, driver ops all succeed", async () => {
      const { handlers, state, mock } = await importAll();
      const doc = state.emptyState("0.10.0-rc.2");
      const driver = new mock.MockDriver();

      const spawnRes = await handlers.dispatch(
        makeRequest(
          "peer_spawn",
          {
            sessionId: "peer-x",
            displayName: "rc-test:alice", // <-- unsafe raw name
            cwd: "/tmp",
            command: "/bin/sleep",
            args: ["10"],
          },
          "req-spawn",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.2" },
      );
      expect(spawnRes.outcome).toBe("ok");
      const spawnData = spawnRes.data as { sessionKey: string };
      // Returned sessionKey is canonical.
      expect(spawnData.sessionKey).toBe("rc-test_alice");
      // state.peers.tmuxTarget stores the canonical form (not raw).
      expect(doc.peers["peer-x"]?.tmuxTarget).toBe("rc-test_alice");
      // Human-facing name field keeps the raw string.
      expect(doc.peers["peer-x"]?.name).toBe("rc-test:alice");

      // team_status uses tmuxTarget → hostAlive must be true (regression:
      // rc.1 reported hostAlive:false because it looked up raw name).
      const statusRes = await handlers.dispatch(
        makeRequest("team_status", { verbose: true }, "req-status"),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.2" },
      );
      const statusData = statusRes.data as {
        peers: Array<{ sessionId: string; hostAlive: boolean; tmuxTarget: string }>;
      };
      expect(statusData.peers[0]?.hostAlive).toBe(true);
      expect(statusData.peers[0]?.tmuxTarget).toBe("rc-test_alice");

      // peer_compact via send-keys — driver's canonical form is what
      // send-keys receives (rc.1 bug: raw "rc-test:alice" was fed to
      // tmux and parsed as session:window → failure).
      const sendKeysCalls: Array<{ key: string; keys: string }> = [];
      (driver as unknown as { sendKeys: (k: string, keys: string) => Promise<void> }).sendKeys =
        async (key, keys) => {
          sendKeysCalls.push({ key, keys });
        };
      const { shared } = await importAll();
      const ackDir = join(shared.controlDir(), "compact-ack");
      await mkdir(ackDir, { recursive: true });
      await writeFile(join(ackDir, "peer-x.json"), JSON.stringify({ ready: true }));

      const compactRes = await handlers.dispatch(
        makeRequest(
          "peer_compact",
          {
            peer: "peer-x",
            skipAnchorRequest: true,
            anchorTimeoutMs: 500,
            ackPollMs: 50,
          },
          "req-compact",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.2" },
      );
      expect(compactRes.outcome).toBe("ok");
      expect(sendKeysCalls).toEqual([{ key: "rc-test_alice", keys: "/compact" }]);

      // peer_stop should also find the session — driver op receives canonical.
      const stopRes = await handlers.dispatch(
        makeRequest("peer_stop", { peer: "peer-x" }, "req-stop"),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.2" },
      );
      expect(stopRes.outcome).toBe("ok");
      expect(doc.peers["peer-x"]).toBeUndefined();

      driver.reset();
    });
  });

  describe("T2: peer_stop is idempotent when host session already gone", () => {
    it("driver.kill returns success when session is not present (no throw)", async () => {
      const { mock } = await importAll();
      const driver = new mock.MockDriver();
      // No sessions registered — kill on a non-existent one is a no-op.
      await expect(driver.kill("ghost")).resolves.toBeUndefined();
    });

    it("peer_stop cleans state.peers even after host session vanished externally", async () => {
      const { handlers, state, mock } = await importAll();
      const doc = state.emptyState("0.10.0-rc.2");
      const driver = new mock.MockDriver();

      const spawnRes = await handlers.dispatch(
        makeRequest(
          "peer_spawn",
          {
            sessionId: "peer-y",
            displayName: "rc2-test-bob",
            cwd: "/tmp",
            command: "/bin/sleep",
            args: ["10"],
          },
          "req-spawn",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.2" },
      );
      expect(spawnRes.outcome).toBe("ok");
      expect(doc.peers["peer-y"]).toBeDefined();

      // Simulate the host session disappearing outside the daemon —
      // operator killed tmux from the shell, or a crash cleaned it up.
      // Reach into the mock driver directly.
      (driver as unknown as { sessions: Map<string, unknown> }).sessions.delete("rc2-test-bob");

      // peer_stop should now still succeed and remove the peer from state.
      // Regression target: rc.1 bug where this branch reported
      // `host_kill_failed` because kill was NOT idempotent, leaving
      // status="stopping" forever.
      const stopRes = await handlers.dispatch(
        makeRequest("peer_stop", { peer: "peer-y" }, "req-stop"),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.2" },
      );
      expect(stopRes.outcome).toBe("ok");
      expect(doc.peers["peer-y"]).toBeUndefined();

      driver.reset();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));
const spawnCallsHolder = vi.hoisted(() => ({
  current: [] as Array<{ env: Record<string, string>; args: string[] }>,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

// Ensure events.jsonl writes go to a scratch dir per test — vi.mock('node:os')
// already redirects homedir, and control-paths is derived from it.

async function importHandlers() {
  return await import("../src/handlers/index.ts");
}

async function importMock() {
  return await import("../src/hosts/mock-driver.ts");
}

async function importState() {
  return await import("../src/state.ts");
}

interface MockDriverInstance {
  spy: {
    lastSpawn: (typeof spawnCallsHolder.current)[number] | null;
  };
  driver: import("../src/hosts/mock-driver.ts").MockDriver;
}

async function newDriver(
  options: { respawnAfterKill?: boolean } = {},
): Promise<MockDriverInstance> {
  const { MockDriver } = await importMock();
  const respawnAfterKill = options.respawnAfterKill ?? false;
  const driver = new MockDriver(respawnAfterKill ? { hostRespawnHook: () => true } : {});
  const originalSpawn = driver.spawn.bind(driver);
  const spy: MockDriverInstance["spy"] = { lastSpawn: null };
  driver.spawn = async (opts) => {
    const rec = await originalSpawn(opts);
    spy.lastSpawn = { env: opts.env, args: opts.args };
    spawnCallsHolder.current.push(spy.lastSpawn);
    return rec;
  };
  return { driver, spy };
}

async function newState(
  daemonVersion = "0.10.0-beta.0",
): Promise<ReturnType<typeof import("../src/state.ts")["emptyState"]>> {
  const { emptyState } = await importState();
  return emptyState(daemonVersion);
}

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-1") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-07-23T12:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "test-caller", name: "test-caller" },
  };
}

describe("handlers", () => {
  beforeEach(() => {
    spawnCallsHolder.current = [];
    homeHolder.current = `/tmp/cbd-handlers-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  describe("acceptance: sanitized-env spawn (22.7. regression)", () => {
    it("strips ANTHROPIC_API_KEY + CLAUDE_CODE_SESSION_ID from the caller env before spawn", async () => {
      const { dispatch } = await importHandlers();
      const state = await newState();
      const { driver, spy } = await newDriver();
      const prev = {
        ANTHROPIC: process.env["ANTHROPIC_API_KEY"],
        CC: process.env["CLAUDE_CODE_SESSION_ID"],
      };
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-not-leak";
      process.env["CLAUDE_CODE_SESSION_ID"] = "leaked-session";
      try {
        const res = await dispatch(
          makeRequest("peer_spawn", {
            sessionId: "peer-a",
            displayName: "test:alice",
            cwd: "/tmp",
            command: "/bin/sleep",
            args: [],
            resume: false,
          }),
          { state, hostDriver: driver, daemonVersion: "0.10.0-beta.0" },
        );
        expect(res.outcome).toBe("ok");
        expect(spy.lastSpawn).not.toBeNull();
        expect(spy.lastSpawn?.env["ANTHROPIC_API_KEY"]).toBeUndefined();
        expect(spy.lastSpawn?.env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
        expect(spy.lastSpawn?.env["PATH"]).toBeDefined();
      } finally {
        if (prev.ANTHROPIC === undefined) {
          // biome-ignore lint/performance/noDelete: env var cleanup requires actual removal (assignment to undefined coerces to string)
          delete process.env["ANTHROPIC_API_KEY"];
        } else {
          process.env["ANTHROPIC_API_KEY"] = prev.ANTHROPIC;
        }
        if (prev.CC === undefined) {
          // biome-ignore lint/performance/noDelete: env var cleanup requires actual removal (assignment to undefined coerces to string)
          delete process.env["CLAUDE_CODE_SESSION_ID"];
        } else {
          process.env["CLAUDE_CODE_SESSION_ID"] = prev.CC;
        }
      }
    });
  });

  describe("acceptance: fork-guard", () => {
    it("refuses to spawn when the sessionId is already live in state", async () => {
      const { dispatch } = await importHandlers();
      const state = await newState();
      const { driver } = await newDriver();
      state.peers["peer-a"] = {
        sessionId: "peer-a",
        name: "test:alice",
        hostDriver: "mock",
        tmuxTarget: "test:alice",
        pid: 12345,
        status: "live",
        model: null,
        accountProfile: null,
        startedAt: "2026-07-23T12:00:00.000Z",
        lastUpdatedAt: "2026-07-23T12:00:00.000Z",
      };
      const res = await dispatch(
        makeRequest("peer_spawn", {
          sessionId: "peer-a",
          displayName: "test:alice",
          cwd: "/tmp",
          command: "/bin/sleep",
          args: ["10"],
        }),
        { state, hostDriver: driver, daemonVersion: "0.10.0-beta.0" },
      );
      expect(res.outcome).toBe("error");
      expect(res.error?.code).toBe("session_already_live");
    });

    it("refuses when the host driver still holds the session even if state is empty", async () => {
      const { dispatch } = await importHandlers();
      const state = await newState();
      const { driver } = await newDriver();
      // Simulate an orphaned session in the driver (post-daemon-crash + host survived).
      await driver.spawn({
        sessionKey: "test:alice",
        cwd: "/tmp",
        command: "/bin/sleep",
        args: [],
        env: {},
      });
      const res = await dispatch(
        makeRequest("peer_spawn", {
          sessionId: "peer-a",
          displayName: "test:alice",
          cwd: "/tmp",
          command: "/bin/sleep",
          args: ["10"],
        }),
        { state, hostDriver: driver, daemonVersion: "0.10.0-beta.0" },
      );
      expect(res.outcome).toBe("error");
      expect(res.error?.code).toBe("session_already_live");
    });
  });

  describe("acceptance: bg-pty respawn coverage (mrxe9t7d)", () => {
    it("surfaces supervisor_respawn when the host reports the session is back after kill", async () => {
      const { dispatch } = await importHandlers();
      const state = await newState();
      // Driver that respawns the session after every kill.
      const { MockDriver } = await importMock();
      const driver = new MockDriver({ hostRespawnHook: () => true });
      await dispatch(
        makeRequest("peer_spawn", {
          sessionId: "peer-a",
          displayName: "test:alice",
          cwd: "/tmp",
          command: "/bin/sleep",
          args: ["10"],
        }),
        { state, hostDriver: driver, daemonVersion: "0.10.0-beta.0" },
      );
      // Now stop it — MockDriver's hostRespawnHook re-inserts the session.
      const originalKill = driver.kill.bind(driver);
      driver.kill = async (key: string) => {
        await originalKill(key);
        throw new Error(`Session '${key}' respawned within budgetms after kill`);
      };
      const stopRes = await dispatch(makeRequest("peer_stop", { peer: "peer-a" }, "req-stop"), {
        state,
        hostDriver: driver,
        daemonVersion: "0.10.0-beta.0",
      });
      expect(stopRes.outcome).toBe("error");
      expect(stopRes.error?.code).toBe("supervisor_respawn");
    });
  });

  describe("happy path: spawn → team_status → stop", () => {
    it("spawns a peer, lists it in team_status, then stops cleanly", async () => {
      const { dispatch } = await importHandlers();
      const state = await newState();
      const { driver } = await newDriver();

      const spawnRes = await dispatch(
        makeRequest(
          "peer_spawn",
          {
            sessionId: "peer-b",
            displayName: "test:bob",
            cwd: "/tmp",
            command: "/bin/sleep",
            args: ["10"],
          },
          "req-spawn",
        ),
        { state, hostDriver: driver, daemonVersion: "0.10.0-beta.0" },
      );
      expect(spawnRes.outcome).toBe("ok");
      expect(state.peers["peer-b"]?.status).toBe("live");

      const statusRes = await dispatch(
        makeRequest("team_status", { verbose: true }, "req-status"),
        { state, hostDriver: driver, daemonVersion: "0.10.0-beta.0" },
      );
      expect(statusRes.outcome).toBe("ok");
      const statusData = statusRes.data as {
        peerCount: number;
        peers: Array<{ sessionId: string; hostAlive: boolean }>;
      };
      expect(statusData.peerCount).toBe(1);
      expect(statusData.peers[0]?.sessionId).toBe("peer-b");
      expect(statusData.peers[0]?.hostAlive).toBe(true);

      const stopRes = await dispatch(makeRequest("peer_stop", { peer: "peer-b" }, "req-stop"), {
        state,
        hostDriver: driver,
        daemonVersion: "0.10.0-beta.0",
      });
      expect(stopRes.outcome).toBe("ok");
      expect(state.peers["peer-b"]).toBeUndefined();
    });
  });

  describe("concurrent requests", () => {
    it("processes sequential duplicate peer_spawn calls in submission order", async () => {
      const { dispatch } = await importHandlers();
      const state = await newState();
      const { driver } = await newDriver();

      // Daemon queue is sequential (await inside for-loop). Simulate: first
      // spawn completes fully → state.peers gets the record → second sees
      // fork-guard hit.
      const first = await dispatch(
        makeRequest(
          "peer_spawn",
          {
            sessionId: "peer-c",
            displayName: "test:carol",
            cwd: "/tmp",
            command: "/bin/sleep",
            args: ["10"],
          },
          "req-first",
        ),
        { state, hostDriver: driver, daemonVersion: "0.10.0-beta.0" },
      );
      const second = await dispatch(
        makeRequest(
          "peer_spawn",
          {
            sessionId: "peer-c",
            displayName: "test:carol",
            cwd: "/tmp",
            command: "/bin/sleep",
            args: ["10"],
          },
          "req-second",
        ),
        { state, hostDriver: driver, daemonVersion: "0.10.0-beta.0" },
      );
      expect(first.outcome).toBe("ok");
      expect(second.outcome).toBe("error");
      expect(second.error?.code).toBe("session_already_live");
      driver.reset();
    });
  });
});

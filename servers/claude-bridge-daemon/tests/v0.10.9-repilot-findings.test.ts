import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * Findings D, G, H and I from plt-designer's re-pilot of v0.10.7.
 *
 * D is the sharpest lesson of the four: the fix was written, reviewed and
 * shipped, and it never ran — the lookup that finds a peer's home session sat
 * AFTER the stop that destroys it. Correct code in the wrong place is
 * indistinguishable from no code, and only a live pilot could tell.
 */

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
  restart: await import("../src/handlers/peer-restart.ts"),
});

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-r") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-04T20:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

describe("D — a restart asks for the peer's home BEFORE destroying it", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-home-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE REGRESSION: inSession is resolved from the live window, not the corpse", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.9-test");
    doc.peers["p"] = {
      sessionId: "p",
      name: "w1",
      hostDriver: "mock",
      tmuxTarget: "@652",
      pid: 500,
      status: "live",
      team: "obetni",
      adopted: true,
      command: "/bin/sh",
      spawnArgs: ["-c", "sleep 30"],
      cwd: "/tmp",
      model: null,
      accountProfile: null,
      startedAt: "2026-08-04T10:00:00.000Z",
      lastUpdatedAt: "2026-08-04T10:00:00.000Z",
    };

    const driver = new mock.MockDriver();
    // The window exists until the stop removes it — exactly like tmux.
    let windowGone = false;
    // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the optional method
    (driver as any).listWindows = async () =>
      windowGone
        ? []
        : [
            {
              target: "@652",
              label: "obetni:1",
              session: "obetni",
              window: 1,
              windowName: "w1",
              pid: 500,
            },
          ];
    const originalKill = driver.kill.bind(driver);
    driver.kill = async (k: string) => {
      windowGone = true;
      return originalKill(k);
    };
    const seen: Array<string | undefined> = [];
    const originalSpawn = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      seen.push(opts.inSession);
      return originalSpawn(opts);
    };

    await handlers.dispatch(makeRequest("peer_restart", { peer: "p" }), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.10.9-test",
      restartSettleMs: 0,
    });

    // Before the fix the lookup ran after the kill, found nothing, and every
    // adopted peer was relaunched as a session of its own.
    expect(seen[0]).toBe("obetni");
    driver.reset();
  });
});

describe("H — a restart keeps the peer's provenance", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-prov-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE REGRESSION: team and adopted survive the relaunch", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.9-test");
    doc.peers["p"] = {
      sessionId: "p",
      name: "w1",
      hostDriver: "mock",
      tmuxTarget: "w1",
      pid: 500,
      status: "live",
      team: "obetni",
      adopted: true,
      command: "/bin/sh",
      spawnArgs: ["-c", "sleep 30"],
      cwd: "/tmp",
      model: null,
      accountProfile: null,
      startedAt: "2026-08-04T10:00:00.000Z",
      lastUpdatedAt: "2026-08-04T10:00:00.000Z",
    };
    const driver = new mock.MockDriver();

    const res = await handlers.dispatch(makeRequest("peer_restart", { peer: "p" }), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.10.9-test",
      restartSettleMs: 0,
    });
    expect(res.outcome).toBe("ok");

    // peer_spawn writes a fresh record. Without carrying these forward, a fleet
    // roll would have stripped the team stamp off every peer it touched and
    // left team-scoped operations with nothing to match on.
    expect(doc.peers["p"]?.team).toBe("obetni");
    expect(doc.peers["p"]?.adopted).toBe(true);
    driver.reset();
  });
});

describe("G — a peer that dies right after starting is not a success", () => {
  let procRoot: string;
  let home: string;

  beforeEach(async () => {
    procRoot = await mkdtemp(join(tmpdir(), "cb-live-proc-"));
    home = await mkdtemp(join(tmpdir(), "cb-live-home-"));
    await mkdir(join(home, ".claude", "sessions"), { recursive: true });
  });

  afterEach(async () => {
    await rm(procRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const UUID = "b7d740db-0000-4000-8000-000000000000";

  it("THE REGRESSION: an exited pid fails, where silence used to pass", async () => {
    const { restart } = await importAll();
    // Nothing at /proc/4242 — the relaunch died within the settle window, tmux
    // removed the window, and no session file was ever written. The identity
    // check reported "no mismatch" and the tool answered `restarted: ok`.
    const r = await restart.confirmStillRunning(4242, { mismatch: false, actual: null }, UUID, {
      settleMs: 0,
      procRoot,
      command: "/nvm/bin/claude",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exited");
  });

  it("a live claude that registered no session also fails", async () => {
    const { restart } = await importAll();
    await mkdir(join(procRoot, "4242"), { recursive: true });
    const r = await restart.confirmStillRunning(4242, { mismatch: false, actual: null }, UUID, {
      settleMs: 0,
      procRoot,
      command: "/nvm/bin/claude",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("registered no session");
  });

  it("a live claude that DID register passes", async () => {
    const { restart } = await importAll();
    await mkdir(join(procRoot, "4242"), { recursive: true });
    const r = await restart.confirmStillRunning(4242, { mismatch: false, actual: UUID }, UUID, {
      settleMs: 0,
      procRoot,
      command: "/nvm/bin/claude",
    });
    expect(r.ok).toBe(true);
  });

  it("a non-claude command is not required to register — only claude writes one", async () => {
    const { restart } = await importAll();
    await mkdir(join(procRoot, "4242"), { recursive: true });
    const r = await restart.confirmStillRunning(4242, { mismatch: false, actual: null }, UUID, {
      settleMs: 0,
      procRoot,
      command: "/bin/sh",
    });
    expect(r.ok).toBe(true);
  });

  it("no pid at all is a failure, not a shrug", async () => {
    const { restart } = await importAll();
    const r = await restart.confirmStillRunning(null, { mismatch: false, actual: null }, UUID, {
      settleMs: 0,
      procRoot,
    });
    expect(r.ok).toBe(false);
  });

  it("THE WIRING: peer_restart returns an error when the peer dies, not ok", async () => {
    const { handlers, state, mock } = await importAll();
    homeHolder.current = `/tmp/cbd-died-${process.hrtime.bigint()}`;
    const doc = state.emptyState("0.10.9-test");
    doc.peers["p"] = {
      sessionId: "p",
      name: "dies",
      hostDriver: "mock",
      tmuxTarget: "dies",
      pid: 500,
      status: "live",
      // Exits the instant it starts — the shape of a failed resume.
      command: "/bin/sh",
      spawnArgs: ["-c", "exit 0"],
      cwd: "/tmp",
      model: null,
      accountProfile: null,
      startedAt: "2026-08-04T10:00:00.000Z",
      lastUpdatedAt: "2026-08-04T10:00:00.000Z",
    };
    const driver = new mock.MockDriver();

    const res = await handlers.dispatch(makeRequest("peer_restart", { peer: "p" }, "req-died"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.10.9-test",
      // Long enough for the process to be gone, short enough for a test.
      restartSettleMs: 300,
    });

    // The whole point: a corpse is not a restart. Testing confirmStillRunning
    // alone would not catch a handler that ignores its answer.
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("restart_died_after_spawn");
    driver.reset();
  });
});

describe("I — team_status sees window-keyed peers", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-hostalive-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE REGRESSION: an adopted peer in a window reads hostAlive true", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.9-test");
    doc.peers["p"] = {
      sessionId: "p",
      name: "w2",
      hostDriver: "mock",
      tmuxTarget: "@650",
      pid: 501,
      status: "live",
      team: "obetni",
      adopted: true,
      model: null,
      accountProfile: null,
      startedAt: "2026-08-04T10:00:00.000Z",
      lastUpdatedAt: "2026-08-04T10:00:00.000Z",
    };
    const driver = new mock.MockDriver();
    driver.listSessions = async () => [];
    // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the optional method
    (driver as any).listWindows = async () => [
      {
        target: "@650",
        label: "obetni:2",
        session: "obetni",
        window: 2,
        windowName: "w2",
        pid: 501,
      },
    ];

    const res = await handlers.dispatch(makeRequest("team_status", { verbose: true }), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.10.9-test",
    });

    // listSessions reports SESSIONS only, so every adopted peer read false
    // while its window and its process were both plainly there.
    const peers = (res.data as { peers: Array<{ hostAlive: boolean; hostPid: number | null }> })
      .peers;
    expect(peers[0]?.hostAlive).toBe(true);
    expect(peers[0]?.hostPid).toBe(501);
  });
});

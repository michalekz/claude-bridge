import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.7 — a pane whose process has exited still answers for it.
 *
 * With `remain-on-exit` tmux keeps the window and keeps quoting the exited
 * process's pid. Measured 2026-08-08: a pane whose command exited 42 reported
 * `pane_pid=3791183` while `/proc/3791183` was already gone.
 *
 * Three consumers read that pid and would each be wrong in their own way:
 * `team_adopt` would enrol the corpse as a peer, `team_reconcile` would report
 * it healthy, and `peer_spawn` would call the spawn a success.
 *
 * The second measurement is the one that changes how absence is detected:
 * `display-message` DOES NOT FAIL on a missing target. A missing session and a
 * missing window id both return exit 0, empty stdout, empty stderr. The old
 * probe looked for "can't find" in an error message tmux never sends, so its
 * `no-such-target` branch — the one that reports a FACT — was unreachable, and
 * everything fell through to `unavailable`. That was safe but dishonest: the
 * type promised three answers and the path could produce two.
 */

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const TMUX = hasTmux();

describe.skipIf(!TMUX)("probing a pane against a real tmux server", () => {
  const sessions: string[] = [];
  let tempHome: string;

  function newSessionKey(label: string): string {
    const key = `cbtest-dead-${label}-${process.pid}-${sessions.length}`;
    sessions.push(key);
    return key;
  }

  /** A session holding one window whose command has exited, kept by tmux. */
  function spawnCorpse(key: string, exitCode: number): void {
    execFileSync("tmux", ["new-session", "-d", "-s", key, "--", "/bin/sh", "-c", "sleep 300"]);
    execFileSync("tmux", ["set-window-option", "-t", key, "remain-on-exit", "on"]);
    execFileSync("tmux", [
      "respawn-pane",
      "-k",
      "-t",
      key,
      "--",
      "/bin/sh",
      "-c",
      `echo evidence-of-what-went-wrong; exit ${exitCode}`,
    ]);
  }

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-dead-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const key of sessions) {
      try {
        execFileSync("tmux", ["kill-session", "-t", key], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  });

  it("THE REGRESSION: a dead pane is reported dead, not as a live pid", async () => {
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const key = newSessionKey("probe");
    spawnCorpse(key, 42);
    await new Promise((r) => setTimeout(r, 400));

    const windows = await new TmuxDriver().listWindows();
    const win = windows.find((w) => w.session === key);
    expect(win).toBeDefined();
    expect(win?.dead).toBe(true);
    expect(win?.exitStatus).toBe(42);

    // The pid is still quoted — that is the whole hazard, so assert it rather
    // than pretend it goes away. Consumers must read `dead`, not `pid`.
    expect(win?.pid).not.toBeNull();
    expect(existsProc(win?.pid ?? 0)).toBe(false);
  }, 20_000);

  it("a listed session holding only a corpse is not alive", async () => {
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const key = newSessionKey("listed");
    spawnCorpse(key, 7);
    await new Promise((r) => setTimeout(r, 400));

    const found = (await new TmuxDriver().listSessions()).find((s) => s.sessionKey === key);
    expect(found).toBeDefined();
    expect(found?.alive).toBe(false);
    expect(found?.probe?.kind).toBe("dead");
  }, 20_000);

  it("a missing target is a FACT, even though tmux reports it by saying nothing", async () => {
    // Measured: exit 0, empty stdout, empty stderr — for a missing session AND
    // a missing window id. Absence has to be read off the empty answer.
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const driver = new TmuxDriver();
    // biome-ignore lint/suspicious/noExplicitAny: reaching a private probe on purpose
    const probe = await (driver as any).probePanePid("no-such-session-at-all", 2);
    expect(probe.kind).toBe("no-such-target");
  }, 20_000);

  it("a live pane still probes as a live pid", async () => {
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const key = newSessionKey("alive");
    execFileSync("tmux", ["new-session", "-d", "-s", key, "--", "/bin/sh", "-c", "sleep 300"]);
    sessions.push(key);
    await new Promise((r) => setTimeout(r, 300));
    const driver = new TmuxDriver();
    // biome-ignore lint/suspicious/noExplicitAny: reaching a private probe on purpose
    const probe = await (driver as any).probePanePid(key, 2);
    expect(probe.kind).toBe("pid");
    expect(existsProc(probe.pid)).toBe(true);
  }, 20_000);

  it("archives what the pane was showing, and says where", async () => {
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const key = newSessionKey("archive");
    spawnCorpse(key, 3);
    await new Promise((r) => setTimeout(r, 400));

    const path = await new TmuxDriver().archivePane(key, "test");
    expect(path).toBeTruthy();
    const saved = await readFile(path as string, "utf-8");
    // The command's own output is the difference between "exited 3" and
    // knowing why it exited 3.
    expect(saved).toContain("evidence-of-what-went-wrong");
    expect(saved).toContain("test");

    const archived = await readdir(join(tempHome, ".claude-bridge", "control", "archive"));
    expect(archived.length).toBe(1);
  }, 20_000);
});

/**
 * A held-open pane is a NEW KIND OF OBJECT on the host, and an operator has to
 * be able to recognise it in the tools rather than read about it in a changelog
 * (ai-designer's condition on enabling `remain-on-exit`, msk1uiyx).
 */
describe("team_reconcile makes a corpse readable", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-recon-dead-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  async function reconcile(windows: unknown[], peers: Record<string, unknown>) {
    const handlers = await import("../src/handlers/index.ts");
    const state = await import("../src/state.ts");
    const mock = await import("../src/hosts/mock-driver.ts");
    const doc = state.emptyState("0.11.8-test");
    Object.assign(doc.peers, peers);
    const driver = new mock.MockDriver();
    // biome-ignore lint/suspicious/noExplicitAny: mock gains an optional method
    (driver as any).listWindows = async () => windows;
    return handlers.dispatch(
      {
        schemaVersion: 1 as const,
        id: "req-recon",
        ts: "2026-08-08T10:00:00.000Z",
        tool: "team_reconcile",
        args: {},
        requestedBy: { sessionId: "operator", name: "operator" },
      },
      // `procRoot` points at a directory with no pids, so every record reads dead.
      { state: doc, hostDriver: driver, daemonVersion: "0.11.8-test", procRoot: "/nonexistent" },
    );
  }

  const corpseWindow = {
    target: "@9",
    label: "team:9",
    session: "team",
    window: 9,
    windowName: "died-here",
    pid: 999,
    dead: true,
    exitStatus: 127,
  };

  it("a record whose pane is STILL STANDING says so, with the exit status", async () => {
    const res = await reconcile([corpseWindow], {
      "peer-1": {
        handle: "peer-1",
        desired: {},
        observed: {
          name: "peer-1",
          hostDriver: "tmux",
          tmuxTarget: "@9",
          pid: 999,
          status: "live",
          model: null,
          startedAt: "2026-08-08T09:00:00.000Z",
          lastUpdatedAt: "2026-08-08T09:00:00.000Z",
        },
      },
    });
    const entry = (res.data as { drift: Array<{ kind: string; detail: string }> }).drift.find(
      (d) => d.kind === "dead",
    );
    expect(entry).toBeDefined();
    // The two situations need different actions, so they must read differently.
    expect(entry?.detail).toContain("pane is still standing");
    expect(entry?.detail).toContain("127");
    expect(entry?.detail).toContain("capture-pane");
  });

  it("the same record with NO pane says the pane is gone", async () => {
    const res = await reconcile([], {
      "peer-2": {
        handle: "peer-2",
        desired: {},
        observed: {
          name: "peer-2",
          hostDriver: "tmux",
          tmuxTarget: "@9",
          pid: 999,
          status: "live",
          model: null,
          startedAt: "2026-08-08T09:00:00.000Z",
          lastUpdatedAt: "2026-08-08T09:00:00.000Z",
        },
      },
    });
    const entry = (res.data as { drift: Array<{ kind: string; detail: string }> }).drift.find(
      (d) => d.kind === "dead",
    );
    expect(entry?.detail).toContain("pane is gone");
  });

  it("THE FIRST LIVE RUN'S BUG: one pane, two address forms, one entry", async () => {
    // Found by the verification round on 2026-08-08, minutes after v0.11.8
    // shipped. A peer spawned as its own session is recorded as
    // `dead-probe_0118`; listWindows reports the same pane as `@2599`. Reading
    // the map by one form only produced TWO contradictory entries for one pane:
    // the record's said "its pane is gone" while a dead_pane entry for that very
    // window said it "belongs to no record". Both untrue, and between them they
    // hid the only useful fact — there is a pane, and it is this peer's.
    const res = await reconcile(
      [{ ...corpseWindow, target: "@9", session: "solo-session", windowName: "solo" }],
      {
        "peer-3": {
          handle: "peer-3",
          desired: {},
          observed: {
            name: "peer-3",
            hostDriver: "tmux",
            // The record holds the SESSION NAME, not the window id.
            tmuxTarget: "solo-session",
            pid: 999,
            status: "live",
            model: null,
            startedAt: "2026-08-08T09:00:00.000Z",
            lastUpdatedAt: "2026-08-08T09:00:00.000Z",
          },
        },
      },
    );
    const d = (res.data as { drift: Array<{ kind: string; detail: string }> }).drift;
    const dead = d.find((x) => x.kind === "dead");
    expect(dead?.detail).toContain("pane is still standing");
    // Addressed by the form tmux will accept, not the one the record happens to hold.
    expect(dead?.detail).toContain("@9");
    // And NOT reported a second time as an orphan.
    expect(d.filter((x) => x.kind === "dead_pane")).toHaveLength(0);
  });

  it("THE GRAVEYARD: a corpse belonging to no record is reported anyway", async () => {
    // A dead pane has no process, so the live-process scan cannot find it.
    // Without its own pass it would stand on the host unmentioned by any tool.
    const res = await reconcile([corpseWindow], {});
    const entry = (res.data as { drift: Array<{ kind: string; detail: string }> }).drift.find(
      (d) => d.kind === "dead_pane",
    );
    expect(entry).toBeDefined();
    expect(entry?.detail).toContain("died-here");
    expect(entry?.detail).toContain("127");
    // And how to get rid of it — after reading it.
    expect(entry?.detail).toContain("kill-window");
  });
});

function existsProc(pid: number): boolean {
  try {
    execFileSync("test", ["-d", `/proc/${pid}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Archive before you destroy — and if the archive fails, do not destroy.
 *
 * The spawn failure of 2026-08-07 could not be reproduced because the handler
 * killed the session that held the explanation. The rule that came out of it is
 * not "never clean up"; it is that cleanup which archives first may be
 * aggressive, and cleanup which deletes first may never be.
 */
describe("peer_spawn meets a process that already exited", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-spawn-dead-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  async function fixture(archiveResult: string | null) {
    const handlers = await import("../src/handlers/index.ts");
    const state = await import("../src/state.ts");
    const mock = await import("../src/hosts/mock-driver.ts");
    const doc = state.emptyState("0.11.7-test");
    const driver = new mock.MockDriver();
    const killed: string[] = [];
    const archived: string[] = [];
    const originalSpawn = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      const rec = await originalSpawn(opts);
      return {
        ...rec,
        alive: false,
        pid: 4242,
        probe: { kind: "dead", pid: 4242, exitStatus: 127, raw: "4242\t1\t127" },
        // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the probe field
      } as any;
    };
    driver.kill = async (k: string) => {
      killed.push(k);
    };
    // biome-ignore lint/suspicious/noExplicitAny: mock gains an optional method
    (driver as any).archivePane = async (k: string) => {
      archived.push(k);
      return archiveResult;
    };
    return { handlers, doc, driver, killed, archived };
  }

  const request = (handle: string) => ({
    schemaVersion: 1 as const,
    id: `req-${handle}`,
    ts: "2026-08-08T09:00:00.000Z",
    tool: "peer_spawn",
    args: {
      handle,
      displayName: handle,
      cwd: "/tmp",
      command: "/bin/sh",
      args: ["-c", "exit 127"],
    },
    requestedBy: { sessionId: "operator", name: "operator" },
  });

  it("archives, THEN tears down, and reports the exit status", async () => {
    const { handlers, doc, driver, killed, archived } = await fixture("/tmp/archive/pane-x.log");
    const res = await handlers.dispatch(request("exited-peer"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.7-test",
    });

    expect(res.error?.code).toBe("spawn_process_exited");
    // The status is the whole point: "exited 127" is a diagnosis, "spawn
    // produced no process" is a shrug.
    expect(res.error?.message).toContain("127");
    expect(res.error?.message).toContain("/tmp/archive/pane-x.log");
    expect(archived).toHaveLength(1);
    expect(killed).toHaveLength(1);
    expect(doc.peers["exited-peer"]).toBeUndefined();
  });

  it("THE RULE: when the archive fails, the pane is KEPT", async () => {
    const { handlers, doc, driver, killed, archived } = await fixture(null);
    const res = await handlers.dispatch(request("unarchivable"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.7-test",
    });

    expect(res.error?.code).toBe("spawn_process_exited");
    expect(archived).toHaveLength(1);
    // Nothing was destroyed, and the message says how to read it by hand.
    expect(killed).toHaveLength(0);
    expect(res.error?.message).toContain("capture-pane");
  });
});

/** Adoption reads the fleet off reality, and a corpse is not part of it. */
describe("team_adopt and dead panes", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-adopt-dead-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE REGRESSION: a dead window is never adopted as a peer", async () => {
    const { handlers, state, mock } = {
      handlers: await import("../src/handlers/index.ts"),
      state: await import("../src/state.ts"),
      mock: await import("../src/hosts/mock-driver.ts"),
    };
    const doc = state.emptyState("0.11.7-test");
    const driver = new mock.MockDriver();
    // biome-ignore lint/suspicious/noExplicitAny: mock gains an optional method
    (driver as any).listWindows = async () => [
      {
        target: "@1",
        label: "team:1",
        session: "team",
        window: 1,
        windowName: "alive-one",
        pid: 111,
        dead: false,
        exitStatus: null,
      },
      {
        target: "@2",
        label: "team:2",
        session: "team",
        window: 2,
        windowName: "the-corpse",
        pid: 222,
        dead: true,
        exitStatus: 42,
      },
    ];

    const res = await handlers.dispatch(
      {
        schemaVersion: 1 as const,
        id: "req-adopt-dead",
        ts: "2026-08-08T09:00:00.000Z",
        tool: "team_adopt",
        args: { team: "team", mode: "auto", dryRun: true },
        requestedBy: { sessionId: "operator", name: "operator" },
      },
      { state: doc, hostDriver: driver, daemonVersion: "0.11.7-test" },
    );

    const seen = JSON.stringify(res.data ?? {});
    expect(seen).not.toContain("the-corpse");
    expect(seen).not.toContain("222");
  });
});

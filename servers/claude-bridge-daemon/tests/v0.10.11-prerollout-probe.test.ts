import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * Three findings from plt-designer's pre-rollout probe of v0.10.10.
 *
 * All nine earlier findings verified fixed. These came from asking a question
 * the pilots had never asked: the sacrificial fixtures used an ABSOLUTE
 * command, while the whole fleet runs a bare `claude` — so that path had never
 * been exercised even once.
 */

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
  inspector: await import("../src/hosts/process-inspector.ts"),
});

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-pp") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-04T21:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

describe("J — a bare command is resolved through the PEER's own PATH", () => {
  let fakeProc: string;
  let binDir: string;

  beforeEach(async () => {
    fakeProc = await mkdtemp(join(tmpdir(), "cb-procpath-"));
    binDir = await mkdtemp(join(tmpdir(), "cb-bin-"));
    await writeFile(join(binDir, "claude"), "#!/bin/sh\n", "utf-8");
    await chmod(join(binDir, "claude"), 0o755);
    await mkdir(join(fakeProc, "999"), { recursive: true });
  });

  afterEach(async () => {
    await rm(fakeProc, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  async function withEnviron(pathVar: string) {
    await writeFile(join(fakeProc, "999", "environ"), `HOME=/x\0PATH=${pathVar}\0`, "utf-8");
    const { inspector } = await importAll();
    return new inspector.LinuxProcessInspector({ procRoot: fakeProc });
  }

  it("THE FLEET KILLER: a bare name resolves to where the peer's PATH says", async () => {
    const insp = await withEnviron(`/nowhere:${binDir}`);
    // The daemon runs under systemd with a stock PATH that has no nvm, so the
    // relaunch environment cannot find a bare `claude`. The peer's own PATH
    // can, by definition — it is running the thing.
    expect(await insp.resolveViaProcessPath(999, "claude")).toBe(join(binDir, "claude"));
  });

  it("an absolute command is returned unchanged", async () => {
    const insp = await withEnviron("/usr/bin");
    expect(await insp.resolveViaProcessPath(999, "/opt/x/claude")).toBe("/opt/x/claude");
  });

  it("unresolvable returns null — the caller keeps what it was given", async () => {
    const insp = await withEnviron("/nowhere:/also-nowhere");
    // Inventing a path would be worse than admitting we could not find one.
    expect(await insp.resolveViaProcessPath(999, "claude")).toBeNull();
  });
});

describe("L — a failed restart keeps the record", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-retain-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE REGRESSION: the peer does not vanish from the control plane", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.11-test");
    doc.peers["p"] = {
      sessionId: "p",
      name: "p",
      hostDriver: "mock",
      tmuxTarget: "p",
      pid: 500,
      status: "live",
      team: "obetni2",
      adopted: true,
      command: "/nonexistent/claude",
      spawnArgs: [],
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
      daemonVersion: "0.10.11-test",
      restartSettleMs: 0,
    });
    expect(res.outcome).toBe("error");

    // peer_spawn deletes the record when a spawn produces nothing — right for a
    // spawn, wrong for a restart. Without this, `team_release --team obetni2`
    // answered `team_not_found, knownTeams: []` and there was nothing to retry.
    const kept = doc.peers["p"];
    expect(kept).toBeDefined();
    expect(kept?.team).toBe("obetni2");
    // Kept, but not pretending: nothing is running behind it.
    expect(kept?.status).toBe("unknown");
    expect(kept?.pid).toBeNull();
    driver.reset();
  });
});

const haveTmux = await execFileAsync("tmux", ["-V"]).then(
  () => true,
  () => false,
);

describe.skipIf(!haveTmux)("K — a home session that no longer exists is recreated", () => {
  const S = "cb-lone-window-test";

  afterAll(async () => {
    await execFileAsync("tmux", ["kill-session", "-t", S]).catch(() => undefined);
  });

  it("THE REGRESSION: the last window's peer can still come back", async () => {
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const driver = new TmuxDriver({});
    // The session does not exist — exactly the state after the only window in
    // it was stopped. Every peer_spawn peer is a single-window session, so this
    // is the ordinary case.
    await execFileAsync("tmux", ["kill-session", "-t", S]).catch(() => undefined);

    const rec = await driver.spawn({
      sessionKey: "lonely",
      inSession: S,
      cwd: "/tmp",
      command: "/bin/sh",
      args: ["-c", "sleep 60"],
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
    });

    // Before this, `new-window -t <gone>:` failed with "can't find session" and
    // the peer was simply dead with nothing to recover from.
    expect(rec.alive).toBe(true);
    const sessions = (await driver.listSessions()).map((s) => s.sessionKey);
    expect(sessions).toContain(S);
    // And it is in the HOME session, not one named after the peer — the escape
    // this release has already fixed twice.
    expect(sessions).not.toContain("lonely");
    await driver.kill(rec.sessionKey);
  });
});

/**
 * M — the half of L that did not hold.
 *
 * The record survived a failed restart, as intended. It survived saying
 * `status: "live"` with the pid of the process that had just died, because the
 * restore only ran in the SPAWN-error branch — and this failure happens later,
 * on the liveness check, by which point `peer_spawn` has already written a
 * fresh `live` record (plt-designer, 4th pilot round).
 *
 * Keeping the row was right. Keeping its claim was not.
 */
describe("M — a record that outlives a failed restart does not claim to be live", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-m-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE REGRESSION: a peer that died after spawning reads unknown, not live", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.12-test");
    doc.peers["p"] = {
      sessionId: "p",
      name: "w2",
      hostDriver: "mock",
      tmuxTarget: "w2",
      pid: 500,
      status: "live",
      team: "obetni",
      adopted: true,
      // Starts, then exits at once — the shape of a failed resume.
      command: "/bin/sh",
      spawnArgs: ["-c", "exit 0"],
      cwd: "/tmp",
      model: null,
      accountProfile: null,
      startedAt: "2026-08-04T10:00:00.000Z",
      lastUpdatedAt: "2026-08-04T10:00:00.000Z",
    };
    const driver = new mock.MockDriver();

    const res = await handlers.dispatch(makeRequest("peer_restart", { peer: "p" }, "req-m"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.10.12-test",
      restartSettleMs: 300,
    });

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("restart_died_after_spawn");
    const rec = doc.peers["p"];
    // Kept — that half already worked.
    expect(rec).toBeDefined();
    expect(rec?.team).toBe("obetni");
    // And no longer asserting a running peer behind a dead pid.
    expect(rec?.status).toBe("unknown");
    expect(rec?.pid).toBeNull();
    driver.reset();
  });
});

/**
 * P — the fleet outage.
 *
 * `env -i` (v0.10.5) made a peer's environment explicit, which was right. Its
 * VALUES came from `process.env` — the DAEMON's, and under systemd that `PATH`
 * has no nvm. So every relaunched peer lost `node`: no statusLine, hooks
 * failing, and its own MCP server unable to spawn. Twenty-one peers went
 * bridge-mute at once on 2026-08-04.
 *
 * The whitelist decides WHICH variables get through. It was never supposed to
 * decide their values.
 */
describe("P — a relaunch uses the peer's own environment, not the daemon's", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-p-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  const NVM = "/home/u/.nvm/versions/node/v24/bin";

  it("THE OUTAGE: the peer's PATH is what reaches the relaunch", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.13-test");
    doc.peers["p"] = {
      sessionId: "p",
      name: "p",
      hostDriver: "mock",
      tmuxTarget: "p",
      pid: 500,
      status: "live",
      command: "/bin/sh",
      spawnArgs: ["-c", "sleep 30"],
      cwd: "/tmp",
      // Captured from the peer at adoption. Contains nvm; the daemon's does not.
      spawnEnv: { PATH: `${NVM}:/usr/bin`, HOME: "/home/u" },
      model: null,
      accountProfile: null,
      startedAt: "2026-08-04T10:00:00.000Z",
      lastUpdatedAt: "2026-08-04T10:00:00.000Z",
    };
    const driver = new mock.MockDriver();
    const seen: Array<Record<string, string>> = [];
    const original = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      seen.push(opts.env);
      return original(opts);
    };

    await handlers.dispatch(makeRequest("peer_restart", { peer: "p" }, "req-p"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.10.13-test",
      restartSettleMs: 0,
    });

    // Before this, the relaunch got the daemon's PATH and could not find node.
    expect(seen[0]?.["PATH"]).toContain(NVM);
    expect(seen[0]?.["PATH"]).not.toBe(process.env["PATH"]);
    driver.reset();
  });

  it("the whitelist still applies — the peer's values do not smuggle secrets", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.13-test");
    doc.peers["p"] = {
      sessionId: "p",
      name: "p",
      hostDriver: "mock",
      tmuxTarget: "p",
      pid: 500,
      status: "live",
      command: "/bin/sh",
      spawnArgs: ["-c", "sleep 30"],
      cwd: "/tmp",
      // A contaminated peer. Its PATH is welcome; its key is not.
      spawnEnv: {
        PATH: `${NVM}:/usr/bin`,
        ANTHROPIC_API_KEY: "sk-ant-should-never-travel",
        CLAUDE_CODE_ENTRYPOINT: "cli",
      },
      model: null,
      accountProfile: null,
      startedAt: "2026-08-04T10:00:00.000Z",
      lastUpdatedAt: "2026-08-04T10:00:00.000Z",
    };
    const driver = new mock.MockDriver();
    const seen: Array<Record<string, string>> = [];
    const original = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      seen.push(opts.env);
      return original(opts);
    };

    await handlers.dispatch(makeRequest("peer_restart", { peer: "p" }, "req-p2"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.10.13-test",
      restartSettleMs: 0,
    });

    // Changing where values come from must not change which names get through —
    // otherwise this fix reopens the billing incident v0.10.5 closed.
    expect(seen[0]?.["PATH"]).toContain(NVM);
    expect(seen[0]?.["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(seen[0]?.["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    driver.reset();
  });
});

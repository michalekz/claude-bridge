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

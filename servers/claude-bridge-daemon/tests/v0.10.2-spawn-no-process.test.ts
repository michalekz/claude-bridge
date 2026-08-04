import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * `peer_restart` reported a successful start of a peer that was not running
 * (found in live testing, 2026-08-04).
 *
 * Two defects stacked:
 *
 *   A. `peer_restart` passed `process.cwd()` — the DAEMON's directory —
 *      because PeerRecord carried no cwd. `claude --resume <uuid>` cannot
 *      find a transcript belonging to another project, so the relaunched
 *      process exited at once and tmux removed the session.
 *
 *   B. the driver's `spawn` returned `alive: true` as a literal and
 *      `peer_spawn` never looked at it. State went to `status: "live"`, a
 *      `peer_started` event was written, and the caller got `outcome: ok`
 *      with `pid: null` as the only hint.
 *
 * A killed the process; B made it invisible. Reported symptom: the tool says
 * started, the tmux session does not exist, and state holds a "live" peer
 * with a null pid that `team_layout` then refuses to resurrect.
 */

const DEAD_COMMAND = "/nonexistent/definitely-not-a-binary";

const importHandlers = () => import("../src/handlers/index.ts");
const importMock = () => import("../src/hosts/mock-driver.ts");
const importState = () => import("../src/state.ts");

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-1") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-04T07:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

async function harness() {
  const { dispatch } = await importHandlers();
  const { MockDriver } = await importMock();
  const { emptyState } = await importState();
  const driver = new MockDriver({});
  return {
    dispatch,
    driver,
    ctx: { state: emptyState("0.10.2-test"), hostDriver: driver, daemonVersion: "0.10.2-test" },
  };
}

describe("a spawn that starts nothing must not report success", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-nospawn-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE REGRESSION: a command that cannot start yields an error, not ok", async () => {
    const { dispatch, ctx } = await harness();

    const res = await dispatch(
      makeRequest("peer_spawn", {
        sessionId: "victim-0804",
        displayName: "victim-0804",
        cwd: "/tmp",
        command: DEAD_COMMAND,
        args: [],
        resume: false,
      }),
      ctx,
    );

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("spawn_produced_no_process");
    // Nothing left behind claiming to be alive — that phantom record is what
    // made team_layout skip the peer forever.
    expect(ctx.state.peers["victim-0804"]).toBeUndefined();
  });

  it("a healthy spawn still succeeds, goes live, and records where it runs", async () => {
    const { dispatch, ctx, driver } = await harness();

    const res = await dispatch(
      makeRequest("peer_spawn", {
        sessionId: "healthy-0804",
        displayName: "healthy-0804",
        cwd: "/tmp",
        command: "/bin/sh",
        args: ["-c", "sleep 30"],
        resume: false,
      }),
      ctx,
    );

    expect(res.outcome).toBe("ok");
    const rec = ctx.state.peers["healthy-0804"];
    expect(rec?.status).toBe("live");
    expect(rec?.pid).toBeGreaterThan(0);
    // The field that lets peer_restart put it back in the right place.
    expect(rec?.cwd).toBe("/tmp");
    await driver.kill("healthy-0804");
  });

  it("peer_restart relaunches in the PEER's directory, not the daemon's", async () => {
    const peerCwd = await mkdtemp(join(tmpdir(), "cb-peercwd-"));
    const { dispatch, ctx, driver } = await harness();
    const seen: string[] = [];
    const original = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      seen.push(opts.cwd);
      return original(opts);
    };

    try {
      await dispatch(
        makeRequest("peer_spawn", {
          sessionId: "moving-0804",
          displayName: "moving-0804",
          cwd: peerCwd,
          command: "/bin/sh",
          args: ["-c", "sleep 30"],
          resume: false,
        }),
        ctx,
      );
      expect(ctx.state.peers["moving-0804"]?.cwd).toBe(peerCwd);

      process.env["CLAUDE_BRIDGE_TEST_COMMAND"] = "/bin/sh";
      await dispatch(makeRequest("peer_restart", { peer: "moving-0804" }, "req-restart"), ctx);

      // Before the fix the second spawn used process.cwd() — the daemon's
      // directory. Whether the relaunch then succeeds is beside the point;
      // what matters is that it was attempted in the peer's own directory.
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe(peerCwd);
      expect(seen[1]).not.toBe(process.cwd());
    } finally {
      // process.env is Record<string,string>: assigning undefined stores the
      // literal string "undefined", so delete is the only way to unset a var.
      // biome-ignore lint/performance/noDelete: see above
      delete process.env["CLAUDE_BRIDGE_TEST_COMMAND"];
      await driver.kill("moving-0804").catch(() => undefined);
      await rm(peerCwd, { recursive: true, force: true });
    }
  });

  it("the driver MEASURES alive instead of asserting it", async () => {
    const { MockDriver } = await importMock();
    const driver = new MockDriver({});

    const dead = await driver.spawn({
      sessionKey: "dead-key",
      cwd: "/tmp",
      command: DEAD_COMMAND,
      args: [],
      env: {},
    });
    expect(dead.alive).toBe(false);
    expect(dead.pid).toBeNull();

    const live = await driver.spawn({
      sessionKey: "live-key",
      cwd: "/tmp",
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      env: {},
    });
    expect(live.alive).toBe(true);
    expect(live.pid).toBeGreaterThan(0);
    await driver.kill("live-key");
  });
});

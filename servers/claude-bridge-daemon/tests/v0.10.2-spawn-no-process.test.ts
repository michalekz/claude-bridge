import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    ctx: {
      state: emptyState("0.10.2-test"),
      hostDriver: driver,
      daemonVersion: "0.10.2-test",
      restartSettleMs: 0,
    },
  };
}

/*
 * `force: true` on every peer_restart below (added v0.11.18).
 *
 * These tests are about the RELAUNCH — which directory, which command, which
 * arguments. From v0.11.18 a plain restart first asks the peer to get ready and
 * waits up to two minutes for an ack no `/bin/sh` peer will ever write, so
 * without this they would each spend the whole window proving nothing. `force`
 * reproduces the pre-v0.11.18 path exactly and leaves what they assert
 * untouched: force skips the asking, never the relaunch.
 */

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
    expect(rec?.observed.status).toBe("live");
    expect(rec?.observed.pid).toBeGreaterThan(0);
    // The field that lets peer_restart put it back in the right place.
    expect(rec?.desired.cwd).toBe("/tmp");
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
      expect(ctx.state.peers["moving-0804"]?.desired.cwd).toBe(peerCwd);

      process.env["CLAUDE_BRIDGE_TEST_COMMAND"] = "/bin/sh";
      await dispatch(
        makeRequest("peer_restart", { peer: "moving-0804", force: true }, "req-restart"),
        ctx,
      );

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

/**
 * The pilot of the `cwd` fix found the other half of the same omission
 * (plt-designer, 2026-08-04, an hour after v0.10.2 shipped).
 *
 * `peer_restart` respawned every peer with the literal string `"claude"`.
 * Not a degraded absolute path — the command was never carried at all,
 * exactly as `cwd` had not been. Under nvm the daemon's PATH has no
 * `claude`, so the respawned process died at once and the restart failed
 * with `spawn_produced_no_process`.
 *
 * That failure was the fix working: honest, and audible enough that the
 * second omission surfaced within the hour instead of at the next incident.
 *
 * The test above covers cwd. These cover the command and its arguments.
 */
describe("a restart relaunches the peer the way it was launched", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-relaunch-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE REGRESSION: the recorded command is used, not a bare 'claude'", async () => {
    const { dispatch, ctx, driver } = await harness();
    const seen: Array<{ command: string; args: string[] }> = [];
    const original = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      seen.push({ command: opts.command, args: [...opts.args] });
      return original(opts);
    };

    // An interpreter at an absolute path no PATH lookup would find — the same
    // shape as an nvm-installed `claude`.
    const ABSOLUTE = "/bin/sh";
    await dispatch(
      makeRequest("peer_spawn", {
        sessionId: "nvm-shaped-0804",
        displayName: "nvm-shaped-0804",
        cwd: "/tmp",
        command: ABSOLUTE,
        args: ["-c", "sleep 30"],
        resume: false,
      }),
      ctx,
    );
    expect(ctx.state.peers["nvm-shaped-0804"]?.desired.command).toBe(ABSOLUTE);
    expect(ctx.state.peers["nvm-shaped-0804"]?.desired.spawnArgs).toEqual(["-c", "sleep 30"]);

    const res = await dispatch(
      makeRequest("peer_restart", { peer: "nvm-shaped-0804", force: true }, "req-relaunch"),
      ctx,
    );

    expect(seen).toHaveLength(2);
    // Before the fix this was the literal "claude".
    expect(seen[1]?.command).toBe(ABSOLUTE);
    expect(res.outcome).toBe("ok");
    await driver.kill("nvm-shaped-0804").catch(() => undefined);
  });

  /**
   * This case used to spawn `carries-args-0804` with `resume: true` and assert
   * that the restart carried exactly one `--resume`. That is the wedging bug
   * plt-designer found in the v0.10.6 pilot: `claude --resume carries-args-0804`
   * matches no transcript, so Claude Code opens its interactive Resume picker
   * and the peer sits there. Only a UUID names something resumable, so the
   * resumable case now uses one — and the other half is covered below.
   */
  it("the caller's arguments come back, and --resume is not doubled", async () => {
    const { dispatch, ctx, driver } = await harness();
    const seen: string[][] = [];
    const original = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      seen.push([...opts.args]);
      return original(opts);
    };
    const UUID = "c4111e5a-0000-4000-8000-000000000001";

    await dispatch(
      makeRequest("peer_spawn", {
        sessionId: UUID,
        displayName: "carries-args-0804",
        cwd: "/tmp",
        command: "/bin/sh",
        args: ["-c", "sleep 30"],
        resume: true,
      }),
      ctx,
    );
    await dispatch(makeRequest("peer_restart", { peer: UUID, force: true }, "req-args"), ctx);

    // The record stores the CALLER's list; peer_spawn appends --resume itself.
    // Storing the computed list instead would append it again on every restart.
    const relaunch = seen[1] ?? [];
    expect(relaunch.slice(0, 2)).toEqual(["-c", "sleep 30"]);
    expect(relaunch.filter((a) => a === "--resume")).toHaveLength(1);
    await driver.kill("carries-args-0804").catch(() => undefined);
  });

  it("THE WEDGE: a peer named by a stable string is relaunched WITHOUT --resume", async () => {
    const { dispatch, ctx, driver } = await harness();
    const seen: string[][] = [];
    const original = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      seen.push([...opts.args]);
      return original(opts);
    };

    await dispatch(
      makeRequest("peer_spawn", {
        sessionId: "obetni-w3",
        displayName: "obetni-w3",
        cwd: "/tmp",
        command: "/bin/sh",
        args: ["-c", "sleep 30"],
        resume: false,
      }),
      ctx,
    );
    await dispatch(
      makeRequest("peer_restart", { peer: "obetni-w3", force: true }, "req-wedge"),
      ctx,
    );

    // Passing it would hand Claude Code an id no transcript answers to, which
    // opens the picker instead of failing — a wedged peer with a fresh session
    // id and an orphaned record whose pid still matches.
    expect(seen[1]).not.toContain("--resume");
    await driver.kill("obetni-w3").catch(() => undefined);
  });

  it("a record from before this release falls back loudly, not silently", async () => {
    const { dispatch, ctx, driver } = await harness();

    // A peer as v0.10.2 would have written it: cwd present, command absent.
    ctx.state.peers["legacy-record-0804"] = {
      sessionId: "legacy-record-0804",
      desired: {
        cwd: "/tmp",
        accountProfile: null,
      },
      observed: {
        name: "legacy-record-0804",
        hostDriver: "mock",
        tmuxTarget: "legacy-record-0804",
        pid: 1,
        status: "live",
        model: null,
        startedAt: "2026-08-04T10:00:00.000Z",
        lastUpdatedAt: "2026-08-04T10:00:00.000Z",
      },
    };

    process.env["CLAUDE_BRIDGE_TEST_COMMAND"] = "/bin/sh";
    try {
      await dispatch(
        makeRequest("peer_restart", { peer: "legacy-record-0804", force: true }, "req-legacy"),
        ctx,
      );
      const raw = await readFile(
        join(homeHolder.current, ".claude-bridge", "control", "events.jsonl"),
        "utf-8",
      );
      const events = raw
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { event: string; details?: Record<string, unknown> });
      const warn = events.find((e) => e.event === "peer_restart_launch_params_unknown");
      expect(warn).toBeDefined();
      // cwd IS recorded on this legacy record — only the command is missing, and
      // the warning must say which, not just that something is.
      expect(warn?.details?.["missing"]).toEqual(["command"]);
    } finally {
      // biome-ignore lint/performance/noDelete: env vars cannot be unset by assignment
      delete process.env["CLAUDE_BRIDGE_TEST_COMMAND"];
      await driver.kill("legacy-record-0804").catch(() => undefined);
    }
  });
});

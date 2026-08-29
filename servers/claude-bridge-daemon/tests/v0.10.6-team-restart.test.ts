import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHostTarget } from "../src/hosts/driver.ts";
import type { PeerDesired } from "../src/state.ts";
import { makePeer } from "./peer-fixture.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * team_restart — roll a team one peer at a time.
 *
 * This is the widest blast radius in the daemon: it is how a new plugin bundle
 * reaches twenty-three live peers. It is also built on machinery that only
 * became honest today — `peer_restart` spent the morning reporting starts it
 * had not performed, and window targets were separated from session targets
 * this afternoon.
 *
 * So most of what follows tests restraint rather than function: refusing up
 * front, stopping at the first failure, and never calling a partial roll a
 * success.
 */

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
});

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-tr") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-04T18:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

function record(sessionId: string, name: string, over: Partial<PeerDesired> = {}) {
  return makePeer(
    sessionId,
    {
      team: "hmh",
      command: "/bin/sh",
      spawnArgs: ["-c", "sleep 30"],
      cwd: "/tmp",
      ...over,
    },
    {
      name,
      tmuxTarget: canonicalHostTarget(name),
      pid: deadPid,
      startedAt: "2026-08-04T10:00:00.000Z",
      lastUpdatedAt: "2026-08-04T10:00:00.000Z",
    },
  );
}

/**
 * Pid, který PROKAZATELNĚ neběží — zjištěný, ne vymyšlený.
 *
 * Fixture tu měla `pid: 100`, což je na Linuxu ŽIVÉ jádrové vlákno. Od
 * v0.11.40 se po stopu ověřuje smrt procesu, takže z toho čísla byl
 * „přeživší peer" a testy padaly na chování, které je správné.
 * **Vymyšlené číslo v testu může být skutečný pid** — táž rodina jako
 * recyklace pidů, kvůli které se vedle pidu nosí čas startu.
 */
const deadPid = (() => {
  const p = spawnSync("/bin/true");
  return p.pid ?? 999_999;
})();

describe("team_restart rolls a team, and stops when something is wrong", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-trestart-${process.hrtime.bigint()}`;
    vi.resetModules();
    process.env["CLAUDE_BRIDGE_TEST_COMMAND"] = "/bin/sh";
  });

  async function fixture(names: string[], over: Record<string, Record<string, unknown>> = {}) {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.6-test");
    for (const n of names) doc.peers[n] = record(n, n, over[n] ?? {});
    const driver = new mock.MockDriver();
    return {
      handlers,
      doc,
      driver,
      ctx: {
        state: doc,
        hostDriver: driver,
        daemonVersion: "0.10.6-test",
        restartSettleMs: 0,
      },
    };
  }

  it("dry run is the default and shows the order plus launch parameters", async () => {
    const { handlers, ctx, doc } = await fixture(["a", "b"]);
    const res = await handlers.dispatch(makeRequest("team_restart", { team: "hmh" }), ctx);

    expect(res.outcome).toBe("ok");
    const plan = res.data as {
      dryRun: boolean;
      order: Array<{ name: string; command: string }>;
    };
    expect(plan.dryRun).toBe(true);
    expect(plan.order.map((o) => o.name)).toEqual(["a", "b"]);
    // Visible BEFORE anything stops — that they exist is the precondition.
    expect(plan.order.every((o) => o.command === "/bin/sh")).toBe(true);
    expect(doc.peers["a"]?.observed.pid).toBe(deadPid);
  });

  it("THE REFUSAL: a peer with no recorded command stops the whole run up front", async () => {
    const { handlers, ctx, doc } = await fixture(["a", "b"], {
      b: { command: undefined },
    });
    const res = await handlers.dispatch(
      makeRequest("team_restart", { team: "hmh", dryRun: false, settleMs: 0 }),
      ctx,
    );

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("launch_params_missing");
    // Discovered up front, not halfway through: peer `a` was never touched.
    expect(doc.peers["a"]?.observed.pid).toBe(deadPid);
  });

  it("velitel goes last", async () => {
    const { handlers, ctx } = await fixture(["plt-velitel", "plt-worker"]);
    const res = await handlers.dispatch(makeRequest("team_restart", { team: "hmh" }), ctx);
    const plan = res.data as { order: Array<{ name: string }> };
    // The coordinator is the last down and the first to see the others return.
    expect(plan.order.map((o) => o.name)).toEqual(["plt-worker", "plt-velitel"]);
  });

  it("an unknown peer refuses the whole run — no partial roll-out", async () => {
    const { handlers, ctx, doc } = await fixture(["a"]);
    const res = await handlers.dispatch(
      makeRequest("team_restart", {
        peers: ["a", "ghost"],
        dryRun: false,
        settleMs: 0,
      }),
      ctx,
    );
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("peer_not_found");
    expect(doc.peers["a"]?.observed.pid).toBe(deadPid);
  });

  it("restarts peers in order and reports the new pids", async () => {
    const { handlers, ctx, driver } = await fixture(["a", "b"]);
    const res = await handlers.dispatch(
      makeRequest("team_restart", { team: "hmh", dryRun: false, settleMs: 0 }),
      ctx,
    );

    expect(res.outcome).toBe("ok");
    const sum = res.data as {
      restarted: string[];
      results: Array<{ pidAfter: number | null }>;
    };
    expect(sum.restarted).toEqual(["a", "b"]);
    expect(sum.results.every((r) => (r.pidAfter ?? 0) > 0)).toBe(true);
    driver.reset();
  });

  it("THE BRAKE: the first failure stops the roll and the rest are named as skipped", async () => {
    const { handlers, ctx, driver } = await fixture(["a", "b", "c"]);
    // `b` cannot come back: its command does not exist. `a` restarts, `b`
    // fails, `c` must never be touched.
    ctx.state.peers["b"] = record("b", "b", { command: "/nonexistent/nope" });
    // The env override would otherwise rescue `b` — this run must use the
    // recorded command so the failure is the one being tested.
    // biome-ignore lint/performance/noDelete: env vars cannot be unset by assignment
    delete process.env["CLAUDE_BRIDGE_TEST_COMMAND"];

    const res = await handlers.dispatch(
      makeRequest("team_restart", { team: "hmh", dryRun: false, settleMs: 0 }),
      ctx,
    );

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("team_restart_incomplete");
    const sum = res.error?.details as {
      restarted: string[];
      failed: Array<{ handle: string }>;
      skipped: string[];
      stoppedEarly: boolean;
    };
    expect(sum.restarted).toEqual(["a"]);
    expect(sum.failed.map((f) => f.handle)).toEqual(["b"]);
    // Half a fleet running beats a whole one broken — and the operator has to
    // be told which peers were never attempted.
    expect(sum.skipped).toEqual(["c"]);
    expect(sum.stoppedEarly).toBe(true);
    driver.reset();
  });

  it("a partial roll reports an ERROR, never ok", async () => {
    const { handlers, ctx, driver } = await fixture(["a", "b"]);
    ctx.state.peers["b"] = record("b", "b", { command: "/nonexistent/nope" });
    // biome-ignore lint/performance/noDelete: env vars cannot be unset by assignment
    delete process.env["CLAUDE_BRIDGE_TEST_COMMAND"];

    const res = await handlers.dispatch(
      makeRequest("team_restart", {
        team: "hmh",
        dryRun: false,
        settleMs: 0,
        continueOnError: true,
      }),
      ctx,
    );

    // Even with continueOnError, "some peers are down" is not a success. An `ok`
    // here would leave the caller believing the roll-out finished.
    expect(res.outcome).toBe("error");
    driver.reset();
  });

  it("`peers` and `team` are mutually exclusive", async () => {
    const { handlers, ctx } = await fixture(["a"]);
    const res = await handlers.dispatch(
      makeRequest("team_restart", { peers: ["a"], team: "hmh" }),
      ctx,
    );
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("invalid_args");
  });
});

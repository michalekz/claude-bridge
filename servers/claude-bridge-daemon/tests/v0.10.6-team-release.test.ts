import { beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * team_release — the undo for adoption.
 *
 * `team_adopt` takes over peers the daemon did not start. When it takes over
 * the wrong one, the only exit until now was `peer_stop`, which removes the
 * record by killing the work — a running peer's life for a bookkeeping
 * mistake. Release drops the record and leaves the process completely alone.
 *
 * The tests below are mostly about what must NOT happen. A release that kills
 * anything is not a milder release, it is the thing this tool exists to avoid.
 */

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
});

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-rel") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-04T18:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

function record(sessionId: string, name: string, team?: string) {
  return {
    sessionId,
    name,
    hostDriver: "mock" as const,
    tmuxTarget: "@42",
    pid: 4242,
    status: "live" as const,
    ...(team ? { team } : {}),
    adopted: true,
    command: "/nvm/bin/claude",
    spawnArgs: [],
    cwd: "/opt/project",
    model: null,
    accountProfile: null,
    startedAt: "2026-08-04T10:00:00.000Z",
    lastUpdatedAt: "2026-08-04T10:00:00.000Z",
  };
}

describe("team_release drops the record and leaves the process running", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-release-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  async function fixture() {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.6-test");
    doc.peers["aaa"] = record("aaa", "plt-alpha", "hmh");
    doc.peers["bbb"] = record("bbb", "plt-beta", "hmh");
    doc.peers["ccc"] = record("ccc", "plt-gamma", "etl");
    const driver = new mock.MockDriver();
    const killed: string[] = [];
    driver.kill = async (k: string) => {
      killed.push(k);
    };
    return {
      handlers,
      killed,
      ctx: { state: doc, hostDriver: driver, daemonVersion: "0.10.6-test" },
      doc,
    };
  }

  it("dry run is the default — it reports and changes nothing", async () => {
    const { handlers, ctx, doc } = await fixture();
    const res = await handlers.dispatch(makeRequest("team_release", { peers: ["plt-alpha"] }), ctx);

    expect(res.outcome).toBe("ok");
    const plan = res.data as { dryRun: boolean; releasing: Array<{ name: string }> };
    expect(plan.dryRun).toBe(true);
    expect(plan.releasing.map((r) => r.name)).toEqual(["plt-alpha"]);
    // Nothing gone.
    expect(Object.keys(doc.peers).sort()).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("THE POINT: releasing does not signal the process or the host", async () => {
    const { handlers, ctx, doc, killed } = await fixture();
    const res = await handlers.dispatch(
      makeRequest("team_release", { peers: ["plt-alpha"], dryRun: false }),
      ctx,
    );

    expect(res.outcome).toBe("ok");
    expect(doc.peers["aaa"]).toBeUndefined();
    // The whole reason this tool exists instead of peer_stop.
    expect(killed).toEqual([]);
    expect((res.data as { processesAffected: number }).processesAffected).toBe(0);
  });

  it("releases a whole team, and only that team", async () => {
    const { handlers, ctx, doc, killed } = await fixture();
    await handlers.dispatch(makeRequest("team_release", { team: "hmh", dryRun: false }), ctx);

    expect(Object.keys(doc.peers)).toEqual(["ccc"]);
    expect(killed).toEqual([]);
  });

  it("the audit trail records that the process outlived the record", async () => {
    const { handlers, ctx } = await fixture();
    await handlers.dispatch(
      makeRequest("team_release", { peers: ["plt-alpha"], dryRun: false, reason: "mis-adopted" }),
      ctx,
    );

    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const raw = await readFile(
      join(homeHolder.current, ".claude-bridge", "control", "events.jsonl"),
      "utf-8",
    );
    const ev = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; details?: Record<string, unknown> })
      .find((e) => e.event === "peer_released");

    expect(ev).toBeDefined();
    // Without this a later reader cannot tell a release from a stop.
    expect(ev?.details?.["processLeftRunning"]).toBe(true);
    expect(ev?.details?.["reason"]).toBe("mis-adopted");
    expect(ev?.details?.["pid"]).toBe(4242);
  });

  it("an unknown peer is named, not silently skipped", async () => {
    const { handlers, ctx, doc } = await fixture();
    const res = await handlers.dispatch(
      makeRequest("team_release", { peers: ["plt-alpha", "plt-ghost"], dryRun: false }),
      ctx,
    );

    expect(res.outcome).toBe("ok");
    const data = res.data as { notFound: string[]; released: string[] };
    // Partial success has to say which half failed, or "released 1 of 2" reads
    // as success.
    expect(data.notFound).toEqual(["plt-ghost"]);
    expect(data.released).toEqual(["aaa"]);
    expect(doc.peers["bbb"]).toBeDefined();
  });

  it("releasing nothing at all is an error, not an empty success", async () => {
    const { handlers, ctx } = await fixture();
    const res = await handlers.dispatch(
      makeRequest("team_release", { peers: ["plt-ghost"], dryRun: false }),
      ctx,
    );
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("peer_not_found");
  });

  it("`peers` and `team` are mutually exclusive", async () => {
    const { handlers, ctx } = await fixture();
    const res = await handlers.dispatch(
      makeRequest("team_release", { peers: ["plt-alpha"], team: "hmh" }),
      ctx,
    );
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("invalid_args");
  });
});

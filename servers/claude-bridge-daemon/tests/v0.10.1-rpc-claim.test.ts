import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.10.1 — claim-before-dispatch (audit 2026-08-03).
 *
 * The 250 ms poll loop used to call `markRequestDone` AFTER `dispatch`, so a
 * long-running handler left its request in `requests/` and every subsequent
 * tick dispatched it again. With `team_stop` waiting up to 120 s per peer that
 * was ~2400 overlapping handlers for a single request.
 *
 * The re-entrancy guard itself is unit-tested in @claude-bridge/shared; these
 * tests cover the other half — the request must be provably out of the pending
 * set BEFORE the handler starts, and must never be handled twice.
 */
describe("v0.10.1 rpc claim-before-dispatch", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-claim-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  async function writeRequest(id: string, tool: string, args: Record<string, unknown> = {}) {
    const { requestPath, atomicWriteJson } = await import("@claude-bridge/shared");
    await atomicWriteJson(requestPath(id), {
      schemaVersion: 1,
      id,
      ts: "2026-08-03T06:00:00.000Z",
      tool,
      args,
      requestedBy: { sessionId: "claim-caller", name: "claim-caller" },
    });
  }

  it("markRequestDone reports success, and treats an already-gone request as claimed", async () => {
    const { ensureRpcDirs, markRequestDone } = await import("../src/rpc.ts");
    await ensureRpcDirs();
    await writeRequest("req-claim", "control_status");

    // First claim moves it.
    expect(await markRequestDone("req-claim")).toBe(true);
    // Second claim finds nothing — post-condition "no longer pending" still
    // holds, so the contract says true (never re-dispatch on a lost race).
    expect(await markRequestDone("req-claim")).toBe(true);
    // A request that never existed is likewise "not pending".
    expect(await markRequestDone("req-never-existed")).toBe(true);
  });

  it("the request is already out of requests/ by the time the handler runs", async () => {
    const { runDaemon } = await import("../src/daemon.ts");
    const { listPendingRequests, ensureRpcDirs } = await import("../src/rpc.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");
    await ensureRpcDirs();
    await writeRequest("req-ordering", "team_status");

    // team_status calls hostDriver.listSessions() — hook it to observe the
    // pending set at the exact moment the handler is executing.
    let pendingDuringDispatch: string[] | null = null;
    const driver = new MockDriver();
    const originalList = driver.listSessions.bind(driver);
    driver.listSessions = async () => {
      pendingDuringDispatch = await listPendingRequests();
      return originalList();
    };

    await runDaemon({ daemonVersion: "0.10.1-test", once: true, hostDriver: driver });

    expect(pendingDuringDispatch).not.toBeNull();
    // THE ASSERTION: claimed before the handler body ran.
    expect(pendingDuringDispatch).toEqual([]);
    driver.reset();
  });

  it("a request is dispatched at most once, even across daemon restarts", async () => {
    const { runDaemon } = await import("../src/daemon.ts");
    const { ensureRpcDirs } = await import("../src/rpc.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");
    const { resultPath } = await import("@claude-bridge/shared");
    await ensureRpcDirs();
    await writeRequest("req-once", "team_status");

    let dispatches = 0;
    const driver = new MockDriver();
    const originalList = driver.listSessions.bind(driver);
    driver.listSessions = async () => {
      dispatches++;
      return originalList();
    };

    // Two full daemon lifecycles over the same request directory — models both
    // a second poll tick and a daemon restart after a crash.
    await runDaemon({ daemonVersion: "0.10.1-test", once: true, hostDriver: driver });
    await runDaemon({ daemonVersion: "0.10.1-test", once: true, hostDriver: driver });

    expect(dispatches).toBe(1);
    const result = JSON.parse(await readFile(resultPath("req-once"), "utf-8"));
    expect(result).toMatchObject({ id: "req-once", outcome: "ok" });
    driver.reset();
  });

  it("a malformed request is claimed once and never retried", async () => {
    const { runDaemon } = await import("../src/daemon.ts");
    const { ensureRpcDirs, listPendingRequests } = await import("../src/rpc.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");
    const { requestPath, atomicWriteJson } = await import("@claude-bridge/shared");
    await ensureRpcDirs();
    await atomicWriteJson(requestPath("req-broken"), { schemaVersion: 1, args: {} });

    const driver = new MockDriver();
    await runDaemon({ daemonVersion: "0.10.1-test", once: true, hostDriver: driver });

    expect(await listPendingRequests()).toEqual([]);
    driver.reset();
  });
});

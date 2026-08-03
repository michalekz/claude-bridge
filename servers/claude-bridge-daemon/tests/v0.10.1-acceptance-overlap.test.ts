import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * ACCEPTANCE — a long-running handler under the daemon's live 250 ms poll loop
 * must be dispatched exactly once (v0.10.1).
 *
 * This is the scenario the 2026-08-03 audit found and the reason the blocker
 * fixes exist. Before them, `processQueue` was fired from `setInterval` with no
 * in-flight guard, and `markRequestDone` ran AFTER `dispatch` — so a request
 * stayed in `requests/` for the whole time its handler was working and every
 * subsequent tick picked it up again.
 *
 * `team_stop` is the worst case in the tool set: it waits up to 120 s PER PEER
 * for a stop-ack. A five-peer team that nobody acks is 600 s of single-request
 * wall time, which at 250 ms per tick is ~2400 overlapping handlers — each one
 * writing its own round of stop-request messages into peer inboxes and firing
 * its own tmux children.
 *
 * The timings here are compressed (1.5 s ack window, ~2.5 s of real ticking)
 * but the structure is the production one: the real `runDaemon`, the real
 * interval, the real handler. The observable is the count of stop-request
 * messages actually written to disk — one per dispatch, so it cannot be
 * satisfied by accident.
 */
describe("v0.10.1 acceptance — no overlapping dispatch under the live poll loop", () => {
  let tempHome: string;
  let sigtermBefore: NodeJS.SignalsListener[];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-overlap-"));
    homeHolder.current = tempHome;
    vi.resetModules();
    sigtermBefore = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
  });

  afterEach(async () => {
    // runDaemon installs signal handlers; drop the ones this test added so the
    // suite does not accumulate listeners.
    for (const l of process.listeners("SIGTERM") as NodeJS.SignalsListener[]) {
      if (!sigtermBefore.includes(l)) process.removeListener("SIGTERM", l);
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("dispatches a slow team_stop exactly ONCE across ~10 poll ticks", async () => {
    const { runDaemon } = await import("../src/daemon.ts");
    const { ensureRpcDirs } = await import("../src/rpc.ts");
    const { emptyState, saveState } = await import("../src/state.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");
    const shared = await import("@claude-bridge/shared");

    await ensureRpcDirs();

    // A peer that is alive on the host and will never send a stop-ack, so the
    // handler blocks for the whole ack window.
    const sessionId = "overlap-peer";
    const doc = emptyState("0.10.1-rc.1");
    const driver = new MockDriver();
    await driver.spawn({
      sessionKey: "overlap_peer",
      cwd: "/tmp",
      command: "/bin/sh",
      args: ["-c", "sleep 30", "mock"],
      env: {},
    });
    doc.peers[sessionId] = {
      sessionId,
      name: "overlap_peer",
      hostDriver: "mock",
      tmuxTarget: "overlap_peer",
      pid: 1234,
      status: "live",
      model: null,
      accountProfile: null,
      startedAt: "2026-08-03T20:00:00.000Z",
      lastUpdatedAt: "2026-08-03T20:00:00.000Z",
    };
    await saveState(doc);

    const ACK_WINDOW_MS = 1_500; // spans 6 poll ticks at 250 ms
    await shared.atomicWriteJson(shared.requestPath("slow-stop"), {
      schemaVersion: 1,
      id: "slow-stop",
      ts: "2026-08-03T21:00:00.000Z",
      tool: "team_stop",
      args: {
        team: "overlap",
        inline: { team: "overlap", peers: [{ sessionId, displayName: "overlap_peer" }] },
        anchorTimeoutMs: ACK_WINDOW_MS,
        ackPollMs: 100,
      },
      requestedBy: { sessionId: "overlap-caller", name: "overlap-caller" },
    });

    // Real daemon, real interval — returns once the poll timer is armed.
    await runDaemon({ daemonVersion: "0.10.1-rc.1", hostDriver: driver });

    // Let the loop tick well past the handler's blocking window.
    await new Promise((r) => setTimeout(r, ACK_WINDOW_MS + 1_000));
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));

    // THE ASSERTION. One dispatch => one stop-request in the peer's inbox.
    // The pre-fix code would have written roughly one per 250 ms tick.
    const inboxDir = join(shared.bridgeRoot(), "inbox", sessionId, "pending");
    const messages = (await readdir(inboxDir).catch(() => [] as string[])).filter((f) =>
      f.endsWith(".json"),
    );
    expect(messages).toHaveLength(1);

    // And the request left the pending set before the handler ran, so no tick
    // could re-pick it.
    const pending = (await readdir(shared.requestsDir()).catch(() => [] as string[])).filter((f) =>
      f.endsWith(".json"),
    );
    expect(pending).toEqual([]);

    // Exactly one result, and the peer was correctly left running because it
    // never acked and force was not set.
    const results = (await readdir(shared.resultsDir()).catch(() => [] as string[])).filter((f) =>
      f.endsWith(".json"),
    );
    expect(results).toHaveLength(1);
    expect(doc.peers[sessionId]?.status).toBe("live");
    expect(await driver.hasSession("overlap_peer")).toBe(true);

    driver.reset();
  }, 20_000);
});

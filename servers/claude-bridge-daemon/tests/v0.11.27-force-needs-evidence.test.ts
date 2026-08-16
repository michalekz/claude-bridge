/**
 * Force-stop must ask for evidence, not accept a claim.
 *
 * THE 2026-08-11 INCIDENT. A background session, resurrected by the Claude Code
 * daemon from a job it had left for dead the previous day, woke with a
 * fourteen-hour-old picture of the world, decided the peer holding its role was
 * "a zombie after the nightly crash", and force-stopped it. The premise was
 * false and measurably so: the victim's heartbeat was 2.3 s old and its
 * transcript had been written 14 minutes earlier.
 *
 * Nothing in `peer_stop` looked. `force` skips the courtesy phase, and the
 * courtesy phase was the only thing that had ever asked the peer anything.
 *
 * These tests fix the shape of the answer:
 *   - a live peer is refused, and the refusal quotes the heartbeat;
 *   - a silent peer is not protected, because the point is to tell "looks dead"
 *     from "is dead";
 *   - the override works, because killing a live peer stuck on a modal dialog
 *     is a real and necessary operation — it just has to be said out loud.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

async function importAll() {
  return {
    stop: await import("../src/handlers/peer-stop.ts"),
    state: await import("../src/state.ts"),
    mock: await import("../src/hosts/mock-driver.ts"),
    shared: await import("@claude-bridge/shared"),
  };
}

const SESSION = "11111111-2222-3333-4444-555555555555";

/**
 * A REAL heartbeat file, because that is what the guard reads.
 *
 * `ageMs` is how long ago the peer last wrote — the one number the whole
 * decision turns on. Writing the file rather than stubbing the reader is
 * deliberate: the acceptance that missed the dead busy-probe in v0.11.26 missed
 * it precisely by stubbing the thing under test.
 */
async function writeHeartbeat(root: string, ageMs: number): Promise<void> {
  const dir = join(root, "status");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${SESSION}.json`),
    JSON.stringify({
      id: SESSION,
      name: "victim",
      pid: 4242,
      lastSeen: new Date(Date.now() - ageMs).toISOString(),
    }),
  );
}

function stopRequest(args: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    id: "req-stop",
    ts: "2026-08-11T06:06:07.000Z",
    tool: "peer_stop",
    args,
    requestedBy: { sessionId: "057a841a", name: "the-resurrected-one" },
  };
}

async function fixture() {
  const { stop, state, mock } = await importAll();
  const doc = state.emptyState("0.11.27");
  doc.peers[SESSION] = {
    handle: SESSION,
    desired: {
      team: "ai",
      label: "victim",
      cwd: "/opt/hmh",
      command: "/bin/sleep",
      spawnArgs: [],
      homeSession: "ai",
      model: null,
      accountProfile: null,
    },
    observed: {
      name: "victim",
      hostDriver: "tmux",
      tmuxTarget: "@1",
      pid: 4242,
      status: "live",
      spawnEnv: {},
      model: null,
      restartRequest: null,
      startedAt: "2026-08-11T04:00:00.000Z",
      lastUpdatedAt: "2026-08-11T04:00:00.000Z",
      sessionId: SESSION,
      identity: "measured",
      identityAt: "2026-08-11T04:00:00.000Z",
      adopted: true,
    },
  } as never;
  const killed: string[] = [];
  const driver = new mock.MockDriver();
  (driver as unknown as { kill: (k: string) => Promise<void> }).kill = async (k) => {
    killed.push(k);
  };
  return { stop, doc, driver, killed };
}

describe("force-stop asks for evidence", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-force-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("refuses a peer whose heartbeat proves it is alive, and quotes it", async () => {
    const { stop, doc, driver, killed } = await fixture();
    const { shared } = await importAll();
    await writeHeartbeat(shared.bridgeRoot(), 2_300); // the victim's real age

    const res = await stop.handlePeerStop(stopRequest({ peer: SESSION, force: true }), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.27",
    } as never);

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("peer_alive");
    // The number has to be IN the refusal. "It seems alive" is the claim we are
    // replacing; "its heartbeat is 2300 ms old" is a fact the caller can check.
    expect(res.error?.message).toMatch(/2[0-9]{3} ms/);
    expect(res.error?.message).toContain("overrideLiveness");
    expect(killed).toEqual([]); // NOTHING was killed
  });

  it("does not protect a peer that stopped heartbeating", async () => {
    // The guard distinguishes "looks dead" from "is dead". A peer that really
    // went silent is exactly what force is for, and protecting it would turn a
    // safety check into an obstacle.
    const { stop, doc, driver, killed } = await fixture();
    const { shared } = await importAll();
    await writeHeartbeat(shared.bridgeRoot(), 10 * 60_000);

    const res = await stop.handlePeerStop(stopRequest({ peer: SESSION, force: true }), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.27",
    } as never);

    expect(res.outcome).toBe("ok");
    expect(killed).toHaveLength(1);
  });

  it("a peer with no heartbeat file at all is not protected either", async () => {
    // Absence is not evidence of life. The guard only ever stops on a POSITIVE
    // reading — the same disposition as the busy-probe fix in the same release,
    // and for the same reason: a check that fires on ignorance fires always.
    const { stop, doc, driver, killed } = await fixture();

    const res = await stop.handlePeerStop(stopRequest({ peer: SESSION, force: true }), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.27",
    } as never);

    expect(res.outcome).toBe("ok");
    expect(killed).toHaveLength(1);
  });

  it("the override kills a live peer — that case is real and must keep working", async () => {
    // 2026-08-10: two peers hung on a modal rate-limit dialog. They heartbeated
    // throughout, and killing the process was the only way out. The guard must
    // not make that impossible — only deliberate.
    const { stop, doc, driver, killed } = await fixture();
    const { shared } = await importAll();
    await writeHeartbeat(shared.bridgeRoot(), 1_000);

    const res = await stop.handlePeerStop(
      stopRequest({ peer: SESSION, force: true, overrideLiveness: true }),
      { state: doc, hostDriver: driver, daemonVersion: "0.11.27" } as never,
    );

    expect(res.outcome).toBe("ok");
    expect(killed).toHaveLength(1);
  });

  it("a graceful stop never answers `peer_alive` — the guard is about force only", async () => {
    // Without `force` the courtesy phase runs, and that already asks the peer.
    // Putting a liveness check there too would refuse the one path that is safe.
    const { stop, doc, driver, killed } = await fixture();
    const { shared } = await importAll();
    await writeHeartbeat(shared.bridgeRoot(), 1_000);

    const res = await stop.handlePeerStop(
      stopRequest({ peer: SESSION, ackTimeoutMs: 1, ackPollMs: 1 }),
      { state: doc, hostDriver: driver, daemonVersion: "0.11.27" } as never,
    );

    // WHAT THIS FIXTURE ACTUALLY IS, and it took a failed assertion to see it:
    // there is no host behind this record, so the courtesy phase does not time
    // out — it reports "nobody to ask" and proceeds to kill with
    // `stoppedCleanly: null`. That is the designed behaviour and the guard
    // deliberately does not interfere: refusing to reap a peer whose host is
    // gone would leave the registry lying about a session nobody can reach.
    //
    // The claim worth pinning is the narrow one: whatever a graceful stop
    // decides, it never decides it on liveness.
    expect(res.error?.code ?? "").not.toBe("peer_alive");
    expect(killed).toEqual(["@1"]);
  });
});

describe("`not found` and `unmanaged` are different answers", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-unmanaged-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("a peer that heartbeats but is not in the registry is UNMANAGED, not missing", async () => {
    // THE 2026-08-11 INCIDENT, second half. After the force-stop, the victim was
    // revived in tmux beside the control plane: heartbeating, listed by
    // peer_list, reported on by peer_context_status — and every lifecycle tool
    // answered `peer_not_found: No peer with id/name in daemon state`. Read
    // plainly that says the peer does not exist. It existed and was talking.
    const { stop, state, mock, shared } = await importAll();
    await writeHeartbeat(shared.bridgeRoot(), 1_200);

    const res = await stop.handlePeerStop(stopRequest({ peer: SESSION, force: true }), {
      state: state.emptyState("0.11.27"), // registry deliberately EMPTY
      hostDriver: new mock.MockDriver(),
      daemonVersion: "0.11.27",
    } as never);

    expect(res.error?.code).toBe("peer_unmanaged");
    expect(res.error?.message).toContain("IS RUNNING");
    // The remedy has to be in the answer. An operator who reads "not found"
    // starts looking for a lost peer; one who reads "adopt it" fixes it.
    expect(res.error?.message).toContain("team_adopt");
    expect((res.error?.details as Record<string, unknown>)?.["remedy"]).toBe("team_adopt");
  });

  it("a peer nobody has heard of is still plainly not found", async () => {
    // Absence of a heartbeat is not upgraded into a claim. The old answer
    // survives for the case it was always right about.
    const { stop, state, mock } = await importAll();

    const res = await stop.handlePeerStop(stopRequest({ peer: "nikdo-takovy" }), {
      state: state.emptyState("0.11.27"),
      hostDriver: new mock.MockDriver(),
      daemonVersion: "0.11.27",
    } as never);

    expect(res.error?.code).toBe("peer_not_found");
  });
});

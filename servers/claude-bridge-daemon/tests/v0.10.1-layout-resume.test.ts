import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

async function importAll() {
  return {
    handlers: await import("../src/handlers/index.ts"),
    state: await import("../src/state.ts"),
    mock: await import("../src/hosts/mock-driver.ts"),
    shared: await import("@claude-bridge/shared"),
  };
}

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-1") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-03T06:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "layout-caller", name: "layout-caller" },
  };
}

/**
 * The resume path appends `--resume <id>` (and `--model`) to the spec args,
 * so the stand-in binary has to tolerate trailing arguments and stay alive —
 * `sleep` would reject them and exit, killing the mock session. `sh -c` takes
 * the extras as positional parameters and ignores them, which is how the real
 * `claude` binary behaves.
 */
function peerSpec(sessionId: string, displayName: string) {
  return {
    sessionId,
    displayName,
    cwd: "/tmp",
    command: "/bin/sh",
    args: ["-c", "sleep 10", "mock-peer"],
    resume: false,
    model: null,
    accountProfile: null,
    extraAllowEnv: [],
    extraEnv: {},
  };
}

/**
 * v0.10.1 — team_layout must resume peers that team_stop put to sleep
 * (audit 2026-08-03).
 *
 * `toSpawn` filtered on `!stateIds.has(sessionId)`, and a stopped peer keeps
 * its record, so the tombstone read as "already running" and the team could
 * never be brought back — breaking the exact round trip the tombstone exists
 * for. A resumed session is also silent until something triggers a turn, so
 * the resume path has to wake it.
 */
describe("v0.10.1 team_layout resume-from-stopped", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-resume-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  async function inboxMessages(shared: { bridgeRoot: () => string }, peerId: string) {
    const dir = join(shared.bridgeRoot(), "inbox", peerId, "pending");
    const files = await readdir(dir).catch(() => [] as string[]);
    const out = [];
    for (const f of files) {
      out.push(JSON.parse(await readFile(join(dir, f), "utf-8")));
    }
    return out;
  }

  it("stop → apply round trip: same sessionIds come back live, host sessions restored", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();
    (driver as unknown as { sendKeys: (k: string, s: string) => Promise<void> }).sendKeys =
      async () => undefined;

    const spec = {
      team: "rt",
      peers: [peerSpec("rt-a", "rt:alice"), peerSpec("rt-b", "rt:bob")],
    };

    // 1. Bring the team up.
    const up = await handlers.dispatch(
      makeRequest("team_layout", { team: "rt", apply: true, inline: spec }, "req-up"),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect(up.outcome).toBe("ok");
    expect((up.data as { spawnedOk: string[] }).spawnedOk.sort()).toEqual(["rt-a", "rt-b"]);

    // 2. Put it to sleep. Both peers ack AFTER the request arrives — the only
    // order accepted since v0.11.15, which sweeps the ack directory before
    // asking so that a leftover cannot answer for a peer that never did.
    const { shared } = await importAll();
    const ackDir = join(shared.controlDir(), "stop-ack");
    // A mock peer, and it has to be a real one: `team_stop` walks the team
    // SERIALLY and sweeps each peer's ack directory immediately before asking
    // it. Writing both acks up front means the second is swept away before its
    // request is even written — the ack must follow the question, per peer.
    const ackers = (async () => {
      const pending = new Set(["rt-a", "rt-b"]);
      const deadline = Date.now() + 15_000;
      while (pending.size > 0 && Date.now() < deadline) {
        for (const id of [...pending]) {
          const inbox = join(shared.bridgeRoot(), "inbox", id, "pending");
          const msgs = await readdir(inbox).catch(() => [] as string[]);
          if (msgs.length > 0) {
            await mkdir(ackDir, { recursive: true });
            await writeFile(join(ackDir, `${id}.json`), JSON.stringify({ ready: true }));
            pending.delete(id);
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    })();

    const stop = await handlers.dispatch(
      makeRequest(
        "team_stop",
        {
          team: "rt",
          inline: {
            team: "rt",
            peers: [
              { sessionId: "rt-a", displayName: "rt:alice" },
              { sessionId: "rt-b", displayName: "rt:bob" },
            ],
          },
          anchorTimeoutMs: 5_000,
          ackPollMs: 50,
        },
        "req-stop",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect((stop.data as { stoppedCleanly: string[] }).stoppedCleanly.sort()).toEqual([
      "rt-a",
      "rt-b",
    ]);
    expect(doc.peers["rt-a"]?.observed.status).toBe("stopped");
    expect(await driver.hasSession("rt_alice")).toBe(false);

    // 3. Bring it back with the SAME spec — this is what used to silently no-op.
    const back = await handlers.dispatch(
      makeRequest(
        "team_layout",
        { team: "rt", apply: true, inline: spec, wakeDelayMs: 0 },
        "req-back",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect(back.outcome).toBe("ok");
    const data = back.data as { spawnedOk: string[]; resumedOk: string[]; wokenOk: string[] };
    expect(data.spawnedOk).toEqual([]); // nothing NEW
    expect(data.resumedOk.sort()).toEqual(["rt-a", "rt-b"]);
    expect(data.wokenOk.sort()).toEqual(["rt-a", "rt-b"]);

    // Same sessionIds, live again, host sessions back.
    expect(doc.peers["rt-a"]?.observed.status).toBe("live");
    expect(doc.peers["rt-b"]?.observed.status).toBe("live");
    expect(doc.peers["rt-a"]?.sessionId).toBe("rt-a");
    expect(doc.peers["rt-a"]?.desired.team).toBe("rt");
    expect(await driver.hasSession("rt_alice")).toBe(true);
    expect(await driver.hasSession("rt_bob")).toBe(true);

    driver.reset();
  }, 25_000);

  it("resume passes --resume <sessionId> so the transcript is not orphaned", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();
    (driver as unknown as { sendKeys: (k: string, s: string) => Promise<void> }).sendKeys =
      async () => undefined;

    // A tombstone left behind by a previous team_stop.
    doc.peers["rs-1"] = {
      sessionId: "rs-1",
      desired: {
        accountProfile: null,
      },
      observed: {
        name: "rs:one",
        hostDriver: "mock",
        tmuxTarget: "rs_one",
        pid: null,
        status: "stopped",
        stoppedCleanly: true,
        model: "claude-opus-4-7",
        startedAt: "2026-08-03T05:00:00.000Z",
        lastUpdatedAt: "2026-08-03T05:30:00.000Z",
      },
    };

    const spawnArgs: string[][] = [];
    const originalSpawn = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      spawnArgs.push(opts.args);
      return originalSpawn(opts);
    };

    await handlers.dispatch(
      makeRequest(
        "team_layout",
        {
          team: "rs",
          apply: true,
          inline: { team: "rs", peers: [peerSpec("rs-1", "rs:one")] },
          wakeDelayMs: 0,
        },
        "req-resume",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );

    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0]).toContain("--resume");
    expect(spawnArgs[0]).toContain("rs-1");
    // Model carried over from the tombstone even though the spec says null.
    expect(spawnArgs[0]).toContain("claude-opus-4-7");

    driver.reset();
  });

  it("wake writes an inbox message and injects keys; a forced stop carries a warning", async () => {
    const { handlers, state, mock, shared } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();
    const injected: Array<{ key: string; keys: string }> = [];
    (driver as unknown as { sendKeys: (k: string, s: string) => Promise<void> }).sendKeys = async (
      key,
      keys,
    ) => {
      injected.push({ key, keys });
    };

    // stoppedCleanly:false — the peer never finished its ack cycle.
    doc.peers["wk-1"] = {
      sessionId: "wk-1",
      desired: {
        accountProfile: null,
      },
      observed: {
        name: "wk:one",
        hostDriver: "mock",
        tmuxTarget: "wk_one",
        pid: null,
        status: "stopped",
        stoppedCleanly: false,
        model: null,
        startedAt: "2026-08-03T05:00:00.000Z",
        lastUpdatedAt: "2026-08-03T05:30:00.000Z",
      },
    };

    await handlers.dispatch(
      makeRequest(
        "team_layout",
        {
          team: "wk",
          apply: true,
          inline: { team: "wk", peers: [peerSpec("wk-1", "wk:one")] },
          wakeDelayMs: 0,
        },
        "req-wake",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );

    // Key injection is what actually makes a resumed session take a turn.
    expect(injected).toHaveLength(1);
    expect(injected[0]?.key).toBe("wk_one");
    expect(injected[0]?.keys).toContain("Wake");

    // This block used to look for `kind === "peer-wake"` and read
    // `content.warning` — and it passed, for months, on a message no recipient
    // could ever read. Both fields belonged to a hand-rolled envelope that
    // `MessageEnvelopeSchema` rejects, so `readEnvelope` returned null and the
    // peer's inbox never listed it. The test asserted the implementation it was
    // written beside rather than the requirement, and so it held the defect in
    // place: waking worked by half, key injection only, explanation missing.
    //
    // What matters is not the shape the writer picked. It is that the recipient
    // can read the message at all, and that a forced stop is visible IN THE
    // TEXT the peer will see — a safety instruction hidden in a field nobody
    // parses is worse than none, because the sender believes it was given.
    const msgs = await inboxMessages(shared, "wk-1");
    const wake = msgs.find((m) => typeof m.content === "string" && m.content.includes("resumed"));
    expect(wake).toBeDefined();
    expect(shared.MessageEnvelopeSchema.safeParse(wake).success).toBe(true);
    expect(wake.kind).toBe("ask");
    expect(String(wake.content)).toContain("FORCED");
    expect(String(wake.content)).toContain("anchor");

    driver.reset();
  });

  it("wake:false resumes without injecting", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();
    const injected: string[] = [];
    (driver as unknown as { sendKeys: (k: string, s: string) => Promise<void> }).sendKeys = async (
      key,
    ) => {
      injected.push(key);
    };

    doc.peers["nw-1"] = {
      sessionId: "nw-1",
      desired: {
        accountProfile: null,
      },
      observed: {
        name: "nw:one",
        hostDriver: "mock",
        tmuxTarget: "nw_one",
        pid: null,
        status: "stopped",
        stoppedCleanly: true,
        model: null,
        startedAt: "2026-08-03T05:00:00.000Z",
        lastUpdatedAt: "2026-08-03T05:30:00.000Z",
      },
    };

    const res = await handlers.dispatch(
      makeRequest(
        "team_layout",
        {
          team: "nw",
          apply: true,
          wake: false,
          inline: { team: "nw", peers: [peerSpec("nw-1", "nw:one")] },
        },
        "req-nowake",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect((res.data as { resumedOk: string[] }).resumedOk).toEqual(["nw-1"]);
    expect(injected).toEqual([]);
    driver.reset();
  });

  it("prune forgets tombstones that are no longer in the spec", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.0");
    const driver = new mock.MockDriver();

    // Tombstone for a peer the spec no longer mentions — pure garbage, and
    // peer_stop is the wrong instrument because there is no host session.
    doc.peers["gone-1"] = {
      sessionId: "gone-1",
      desired: {
        accountProfile: null,
      },
      observed: {
        name: "gone:one",
        hostDriver: "mock",
        tmuxTarget: "gone_one",
        pid: null,
        status: "stopped",
        stoppedCleanly: true,
        model: null,
        startedAt: "2026-08-01T05:00:00.000Z",
        lastUpdatedAt: "2026-08-01T05:30:00.000Z",
      },
    };

    const res = await handlers.dispatch(
      makeRequest(
        "team_layout",
        {
          team: "pr",
          apply: true,
          prune: true,
          inline: { team: "pr", peers: [peerSpec("pr-1", "pr:one")] },
          wakeDelayMs: 0,
        },
        "req-prune",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.0" },
    );
    expect(res.outcome).toBe("ok");
    expect((res.data as { forgotten: string[] }).forgotten).toEqual(["gone-1"]);
    expect(doc.peers["gone-1"]).toBeUndefined();
    expect(doc.peers["pr-1"]?.observed.status).toBe("live");
    driver.reset();
  });
});

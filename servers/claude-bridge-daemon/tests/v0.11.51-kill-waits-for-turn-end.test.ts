/**
 * v0.11.51 — the kill waits for the acking turn to END.
 *
 * THE MYSTERY ACK, 2026-09-12. `peer_restart` (round 3 of the 0.11.50 pilot)
 * accepted oxy-marketing's ack at 07:39:55.952 and killed the session at
 * ~07:39:56 — mid-turn. The ack had been written by a Bash tool call INSIDE
 * that turn, and the kill landed before Claude Code persisted the assistant
 * message carrying the tool_use. What was left: an ack file nobody admitted
 * writing, a transcript whose only closure was a synthetic "No response
 * requested." written by the NEXT process, and a peer stating in writing that
 * it had never acked. It took a byte-level fingerprint of the ack file (the
 * peer's own printf idiom — 69 bytes, no trailing newline, where every other
 * peer's echo left 70) to establish the writer.
 *
 * The lesson is peer_compact's v0.11.26 lesson, applied to the kill: writing
 * the ack is itself a turn. These tests drive the real handlers and a real
 * `claude agents --json` probe — a script standing in for the client, busy a
 * chosen number of times, then idle. Nothing about the probe is mocked.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

const HANDLE = "tst-turnend";
const IDENTITY = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let home = "";
let binDir = "";

/** Busy `busyCalls` times, then idle for ever — state lives in a file because
 * each probe is a fresh process. Same stand-in as v0.11.33's. */
async function fakeClaude(busyCalls: number): Promise<string> {
  const counter = join(binDir, "calls");
  await writeFile(counter, "0");
  const path = join(binDir, `claude-${busyCalls}`);
  await writeFile(
    path,
    [
      "#!/bin/sh",
      `n=$(cat "${counter}")`,
      `echo $((n + 1)) > "${counter}"`,
      `if [ "$n" -lt ${busyCalls} ]; then st=busy; else st=idle; fi`,
      `printf '[{"pid":1,"kind":"interactive","sessionId":"${IDENTITY}","name":"${HANDLE}","status":"%s"}]' "$st"`,
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

async function probeCount(): Promise<number> {
  return Number.parseInt(await readFile(join(binDir, "calls"), "utf-8"), 10);
}

function peerRecord(command: string) {
  return {
    handle: HANDLE,
    desired: { team: "tst", cwd: "/tmp", command, spawnArgs: [] },
    observed: {
      name: HANDLE,
      hostDriver: "tmux",
      tmuxTarget: "tst:1",
      pid: 4242,
      status: "live",
      model: null,
      sessionId: IDENTITY,
      identity: "measured",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    },
  };
}

function stateWith(rec: unknown) {
  return {
    stateVersion: 1,
    daemonVersion: "0.11.51",
    startedAt: new Date().toISOString(),
    peers: { [HANDLE]: rec },
    config: {},
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal state
  } as any;
}

interface KillCall {
  sessionKey: string;
}

function ctxWith(state: unknown) {
  const killed: KillCall[] = [];
  const ctx = {
    state,
    hostDriver: {
      name: "mock",
      hasSession: async () => true,
      kill: async (sessionKey: string) => {
        killed.push({ sessionKey });
        return "killed";
      },
      sendKeys: async () => undefined,
      listWindows: async () => [],
    },
    daemonVersion: "0.11.51",
    restartSettleMs: 0,
    wakeDelayMs: 0,
    procRoot: join(home, "proc"),
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
  } as any;
  return { ctx, killed };
}

/** The peer's side of the courtesy: the ack appears a moment after the ask. */
function ackSoon(channel: "stop-ack" | "restart-ack", delayMs = 200): void {
  setTimeout(async () => {
    const dir = join(home, ".claude-bridge", "control", channel);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${IDENTITY}.json`), "{}");
  }, delayMs);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-turnend-"));
  homeHolder.current = home;
  binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  // Relaunched pid must exist or every restart ends in restart_died_after_spawn.
  await mkdir(join(home, "proc", "5151"), { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("../src/handlers/peer-spawn.ts");
  vi.doUnmock("../src/handlers/wake.ts");
  await rm(home, { recursive: true, force: true });
});

function stubSpawnAndWake() {
  const orderOfEvents: string[] = [];
  vi.doMock("../src/handlers/peer-spawn.ts", () => ({
    handlePeerSpawn: async () => {
      orderOfEvents.push("spawn");
      return {
        outcome: "ok",
        data: { pid: 5151, sessionKey: "tst:1", measuredSessionId: IDENTITY },
      };
    },
  }));
  vi.doMock("../src/handlers/wake.ts", async () => {
    const actual =
      await vi.importActual<typeof import("../src/handlers/wake.ts")>("../src/handlers/wake.ts");
    return {
      ...actual,
      wakePeer: async () => {
        orderOfEvents.push("wake");
        return { bridgeId: HANDLE, wakeMsgId: "m1", injected: true };
      },
    };
  });
  return { orderOfEvents };
}

describe("peer_stop — the graceful kill waits out the acking turn", () => {
  it("🔴 THE INCIDENT SHAPE: ack accepted while the turn still runs → kill only after idle", async () => {
    const bin = await fakeClaude(2);
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const state = stateWith(peerRecord(bin));
    const { ctx, killed } = ctxWith(state);
    ackSoon("stop-ack");

    const res = await handlePeerStop(
      {
        schemaVersion: 1,
        id: "req-stop-gate",
        ts: new Date().toISOString(),
        tool: "peer_stop",
        args: { peer: HANDLE, ackTimeoutMs: 5_000, ackPollMs: 50, turnEndPollMs: 50 },
        requestedBy: { sessionId: "cli:test", name: "test" },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      } as any,
      ctx,
    );

    expect(res.outcome).toBe("ok");
    expect(killed).toHaveLength(1);
    // The probe was asked MORE than once: the first answer was `busy` — the
    // tail of the acking turn — and the kill did not happen on it.
    expect(await probeCount()).toBeGreaterThan(1);
  }, 15_000);

  it("busy past the budget → NOTHING is killed, and the message says why", async () => {
    const bin = await fakeClaude(10_000);
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const state = stateWith(peerRecord(bin));
    const { ctx, killed } = ctxWith(state);
    ackSoon("stop-ack");

    const res = await handlePeerStop(
      {
        schemaVersion: 1,
        id: "req-stop-busy",
        ts: new Date().toISOString(),
        tool: "peer_stop",
        args: {
          peer: HANDLE,
          ackTimeoutMs: 5_000,
          ackPollMs: 50,
          turnEndTimeoutMs: 400,
          turnEndPollMs: 50,
        },
        requestedBy: { sessionId: "cli:test", name: "test" },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      } as any,
      ctx,
    );

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("stop_peer_busy_after_ack");
    expect(killed).toHaveLength(0);
    expect(res.error?.message).toMatch(/NOTHING WAS KILLED/);
  }, 15_000);

  it("force skips the gate — an explicit decision to lose the turn", async () => {
    const bin = await fakeClaude(10_000);
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const rec = peerRecord(bin);
    const state = stateWith(rec);
    const { ctx, killed } = ctxWith(state);

    const res = await handlePeerStop(
      {
        schemaVersion: 1,
        id: "req-stop-force",
        ts: new Date().toISOString(),
        tool: "peer_stop",
        args: { peer: HANDLE, force: true, overrideLiveness: true },
        requestedBy: { sessionId: "cli:test", name: "test" },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      } as any,
      ctx,
    );

    expect(res.outcome).toBe("ok");
    expect(killed).toHaveLength(1);
    // The gate never probed: force asks nobody and waits for nobody.
    expect(await probeCount()).toBe(0);
  }, 15_000);
});

describe("peer_restart — the same gate guards the stop step", () => {
  it("waits out the acking turn, then restarts; the wait is reported", async () => {
    const bin = await fakeClaude(2);
    stubSpawnAndWake();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(peerRecord(bin));
    const { ctx, killed } = ctxWith(state);
    ackSoon("restart-ack");

    const res = await handlePeerRestart(
      {
        schemaVersion: 1,
        id: "req-restart-gate",
        ts: new Date().toISOString(),
        tool: "peer_restart",
        args: { peer: HANDLE, readyTimeoutMs: 5_000, readyPollMs: 50, turnEndPollMs: 50 },
        requestedBy: { sessionId: "cli:test", name: "test" },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      } as any,
      ctx,
    );

    expect(res.outcome).toBe("ok");
    expect(killed).toHaveLength(1);
    expect(await probeCount()).toBeGreaterThan(1);
    const data = res.data as Record<string, unknown>;
    expect(data["turnEndWaitedMs"]).toBeGreaterThan(0);
  }, 15_000);

  it("busy past the budget → the restart REFUSES after the ack, peer keeps running", async () => {
    const bin = await fakeClaude(10_000);
    stubSpawnAndWake();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(peerRecord(bin));
    const { ctx, killed } = ctxWith(state);
    ackSoon("restart-ack");

    const res = await handlePeerRestart(
      {
        schemaVersion: 1,
        id: "req-restart-busy",
        ts: new Date().toISOString(),
        tool: "peer_restart",
        args: {
          peer: HANDLE,
          readyTimeoutMs: 5_000,
          readyPollMs: 50,
          turnEndTimeoutMs: 400,
          turnEndPollMs: 50,
        },
        requestedBy: { sessionId: "cli:test", name: "test" },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      } as any,
      ctx,
    );

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("restart_peer_busy_after_ack");
    expect(killed).toHaveLength(0);
    expect(res.error?.message).toMatch(/NOTHING WAS STOPPED/);
  }, 15_000);
});

describe("the request texts teach the protocol the gate enforces", () => {
  it("restart and stop requests say: ack LAST, then end the turn", async () => {
    const { requestRestartReady } = await import("../src/handlers/restart-protocol.ts");
    const { requestStop } = await import("../src/handlers/stop-protocol.ts");
    await requestRestartReady(IDENTITY, "restart:x:1", null);
    await requestStop(IDENTITY, "stop:x:1", null);
    const dir = join(home, ".claude-bridge", "inbox", IDENTITY, "pending");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    const bodies = await Promise.all(files.map((f) => readFile(join(dir, f), "utf-8")));
    for (const body of bodies) {
      expect(body).toMatch(/LAST action of your turn/);
      expect(body).toMatch(/END the turn/);
    }
  });

  it("the compact anchor request says: after acking, stay idle until the inject", async () => {
    const { dispatch } = await import("../src/handlers/index.ts");
    void dispatch; // module load is enough to catch text regressions at import
    const src = await readFile(
      new URL("../src/handlers/peer-compact.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toContain("do not read your queue");
    expect(src).toContain("END YOUR TURN and stay idle");
  });
});

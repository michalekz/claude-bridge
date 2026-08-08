import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.16 — N4: the handle stopped pretending to be the identity.
 *
 * The defect: `peer_spawn` took `sessionId` as an argument and keyed the whole
 * registry on it, while the Claude process inside the pane minted its own. The
 * registry said `tst-c`, the bridge said `tst-c-3e`, both were right, nothing
 * could reconcile them. Measured on the live fleet 2026-08-08: 25 of 26 keys
 * were genuine UUIDs and the only exception was the only spawned peer.
 *
 * What is asserted here is the DISTINCTION, not just the new field:
 *
 *   handle    — chosen before the peer exists, still the registry key,
 *               still what a team spec declares. Legitimate.
 *   identity  — measured off the running process, or honestly unknown.
 *
 * The unknown case matters as much as the measured one. A spawn that failed
 * because a file was slow would be this campaign's defect class inverted:
 * reporting failure over a working peer.
 */

const REAL_UUID = "9c1b7e64-1111-4222-8333-abcdefabcdef";
const PANE_PID = 4242;
const CLAUDE_PID = 4243;

/** A fake process table: one `claude` living under the pane's shell. */
function inspectorWith(opts: { sessionId?: string | null; underPane?: boolean } = {}) {
  const { sessionId = REAL_UUID, underPane = true } = opts;
  return {
    listClaudePeers: async () => [
      {
        pid: CLAUDE_PID,
        ppid: underPane ? PANE_PID : 1,
        sessionId,
        sessionIdSource: (sessionId ? "sessions-json" : "none") as
          | "sessions-json"
          | "resume-arg"
          | "none",
        cwd: "/opt/hmh",
        cmdline: "claude --dangerously-skip-permissions",
        command: "/usr/bin/claude",
        environ: {},
      },
    ],
    ancestorsOf: async () => (underPane ? [PANE_PID] : [1]),
    readProcEnviron: async () => ({}),
    resolveViaProcessPath: async () => null,
  };
}

let tempHome: string;
/** A fake process filesystem in which the pane pid genuinely exists. */
let fakeProc: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "cbd-n4-"));
  homeHolder.current = tempHome;
  fakeProc = join(tempHome, "proc");
  await mkdir(join(fakeProc, String(PANE_PID)), { recursive: true });
  await writeFile(join(fakeProc, String(PANE_PID), "stat"), "x", "utf-8");
  vi.resetModules();
});
afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

describe("measureIdentity — the measurement itself", () => {
  it("reads the session id off the claude process living under the pane", async () => {
    const { measureIdentity } = await import("../src/handlers/peer-identity.ts");
    const out = await measureIdentity(PANE_PID, {
      // biome-ignore lint/suspicious/noExplicitAny: fake process table
      inspector: inspectorWith() as any,
      procRoot: fakeProc,
    });
    expect(out.kind).toBe("measured");
    if (out.kind !== "measured") return;
    expect(out.measurement.sessionId).toBe(REAL_UUID);
    expect(out.measurement.source).toBe("sessions-json");
    // The MEASURED wait, never the budget.
    expect(out.waitedMs).toBeLessThan(500);
  }, 15_000);

  it("does NOT claim a process that is not ours", async () => {
    // A `claude` running elsewhere on the host is somebody else's peer. Taking
    // its identity would be worse than not knowing: the record would point at a
    // session the daemon has no business touching.
    const { measureIdentity } = await import("../src/handlers/peer-identity.ts");
    const out = await measureIdentity(PANE_PID, {
      // biome-ignore lint/suspicious/noExplicitAny: fake process table
      inspector: inspectorWith({ underPane: false }) as any,
      timeoutMs: 200,
      pollMs: 50,
      procRoot: fakeProc,
    });
    expect(out.kind).toBe("unknown");
    if (out.kind !== "unknown") return;
    expect(out.reason).toBe("no-claude-under-pane");
  }, 15_000);

  it("tells 'nothing of ours is running' apart from 'running, has not said who'", async () => {
    // Collapsing these would hide a boot failure inside a timeout.
    const { measureIdentity } = await import("../src/handlers/peer-identity.ts");
    const out = await measureIdentity(PANE_PID, {
      // biome-ignore lint/suspicious/noExplicitAny: fake process table
      inspector: inspectorWith({ sessionId: null }) as any,
      timeoutMs: 200,
      pollMs: 50,
      procRoot: fakeProc,
    });
    expect(out.kind).toBe("unknown");
    if (out.kind !== "unknown") return;
    expect(out.reason).toBe("no-session-id");
  }, 15_000);

  it("the ceiling is derived from a measurement, not chosen", async () => {
    const { IDENTITY_MEASURE_TIMEOUT_MS } = await import("../src/handlers/peer-identity.ts");
    // 5x the 960 ms measured for the session file to appear (experiment A).
    expect(IDENTITY_MEASURE_TIMEOUT_MS).toBe(5_000);
  });
});

function spawnRequest(handle: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: `req-${handle}`,
    ts: new Date().toISOString(),
    tool: "peer_spawn",
    args: {
      handle: handle,
      displayName: handle,
      cwd: "/tmp",
      // A path ending in `claude`: identity is only measured for a Claude peer,
      // because nothing else has a session id to measure.
      command: "/usr/bin/claude",
      args: [],
      ...extra,
    },
    requestedBy: { sessionId: "cli:test", name: "test" },
  };
}

function ctxWith(inspector: unknown) {
  // `fakeProc` is set per-test in beforeEach; read it at call time.
  const state = {
    stateVersion: 1,
    daemonVersion: "0.11.16",
    startedAt: new Date().toISOString(),
    peers: {} as Record<string, { observed: Record<string, unknown> }>,
    config: {},
  };
  return {
    state,
    hostDriver: {
      name: "mock",
      hasSession: async () => false,
      listSessions: async () => [],
      spawn: async () => ({ sessionKey: "tst-x", pid: PANE_PID, alive: true }),
      kill: async () => undefined,
      probePane: async () => ({ kind: "pid" as const, pid: PANE_PID, raw: String(PANE_PID) }),
    },
    processInspector: inspector,
    spawnConfirmMs: 0,
    identityTimeoutMs: 300,
    procRoot: fakeProc,
    daemonVersion: "0.11.16",
  };
}

describe("peer_spawn — measures who it started", () => {
  it("THE REGRESSION: the record carries the MEASURED session id, not the handle", async () => {
    const { handlePeerSpawn } = await import("../src/handlers/peer-spawn.ts");
    const ctx = ctxWith(inspectorWith());
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
    const res = await handlePeerSpawn(spawnRequest("tst-handle") as any, ctx as any);

    expect(res.outcome).toBe("ok");
    const data = res.data as Record<string, unknown>;
    // The handle is unchanged — it is still how you address this peer.
    expect(data["handle"]).toBe("tst-handle");
    // TOP LEVEL, so a caller cannot miss it.
    expect(data["identity"]).toBe("measured");
    expect(data["measuredSessionId"]).toBe(REAL_UUID);

    const rec = ctx.state.peers["tst-handle"] as { observed: Record<string, unknown> };
    expect(rec.observed["sessionId"]).toBe(REAL_UUID);
    expect(rec.observed["identity"]).toBe("measured");
    expect(rec.observed["identitySource"]).toBe("sessions-json");
    expect(typeof rec.observed["identityAt"]).toBe("string");
    // Before this release the two would have been the same invented string.
    expect(rec.observed["sessionId"]).not.toBe("tst-handle");
  }, 20_000);

  it("an unmeasurable identity is NOT a failed spawn", async () => {
    const { handlePeerSpawn } = await import("../src/handlers/peer-spawn.ts");
    const ctx = ctxWith(inspectorWith({ sessionId: null }));
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
    const res = await handlePeerSpawn(spawnRequest("tst-slow") as any, ctx as any);

    expect(res.outcome).toBe("ok");
    const data = res.data as Record<string, unknown>;
    expect(data["identity"]).toBe("unknown");
    expect(data["measuredSessionId"]).toBeNull();
    expect(String(data["identityNote"])).toMatch(/NOT a failed spawn/);

    const rec = ctx.state.peers["tst-slow"] as { observed: Record<string, unknown> };
    // RUNNING, and we do not know who it is. Distinct from dead, and the status
    // must say so — this is the condition the whole design rests on.
    expect(rec.observed["status"]).toBe("live");
    expect(rec.observed["identity"]).toBe("unknown");
    expect(rec.observed["sessionId"]).toBeNull();
  }, 20_000);

  it("a team spec's invented handle still works — team_layout is not broken", async () => {
    // The regression against the tempting wrong fix ("refuse invented ids").
    // A declarative layout MUST be able to name a peer that does not exist yet.
    const { handlePeerSpawn } = await import("../src/handlers/peer-spawn.ts");
    const ctx = ctxWith(inspectorWith());
    const res = await handlePeerSpawn(
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      spawnRequest("plt-keeper", { team: "plt" }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );
    expect(res.outcome).toBe("ok");
    expect(ctx.state.peers["plt-keeper"]).toBeDefined();
  }, 20_000);
});

describe("peer_spawn — a peer that is not Claude", () => {
  it("is not asked for an identity it cannot have", async () => {
    // "Cannot have one" and "has not written one yet" are different answers.
    // Polling a `/bin/sleep` peer for a session id would spend the whole ceiling
    // proving something the command name already answered — five seconds per
    // spawn on a daemon that serialises requests. Measured when this gate was
    // missing: the suite went from 42 s to 262 s with 42 timeouts.
    const { handlePeerSpawn } = await import("../src/handlers/peer-spawn.ts");
    const ctx = ctxWith(inspectorWith());
    const started = Date.now();
    const res = await handlePeerSpawn(
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      spawnRequest("tst-shell", { command: "/bin/sleep", args: ["30"] }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );
    expect(res.outcome).toBe("ok");
    expect((res.data as Record<string, unknown>)["identity"]).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 15_000);
});

describe("team_reconcile — unknown is temporary, not a scar", () => {
  it("measures an identity that was unknown since spawn, and says so in the audit", async () => {
    const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
    vi.doMock("../src/events.ts", () => ({
      writeEvent: async (e: { event: string; details?: Record<string, unknown> }) => {
        events.push(e);
      },
    }));
    const { handleTeamReconcile } = await import("../src/handlers/team-reconcile.ts");

    // A fake /proc that says the pane process is alive.
    const procRoot = join(tempHome, "proc");
    await mkdir(join(procRoot, String(PANE_PID)), { recursive: true });
    await writeFile(join(procRoot, String(PANE_PID), "stat"), "x", "utf-8");

    const ctx = {
      state: {
        stateVersion: 1,
        daemonVersion: "0.11.16",
        startedAt: new Date().toISOString(),
        peers: {
          "tst-handle": {
            handle: "tst-handle",
            desired: { team: "tst" },
            observed: {
              name: "tst-handle",
              hostDriver: "tmux",
              tmuxTarget: "tst:1",
              pid: PANE_PID,
              status: "live",
              model: null,
              sessionId: null,
              identity: "unknown",
              startedAt: new Date().toISOString(),
              lastUpdatedAt: new Date().toISOString(),
            },
          },
        },
        config: {},
      },
      hostDriver: {
        name: "mock",
        listSessions: async () => [{ sessionKey: "tst:1", pid: PANE_PID }],
        listWindows: async () => [
          { target: "tst:1", session: "tst", window: 1, pid: PANE_PID, dead: false },
        ],
      },
      processInspector: inspectorWith(),
      procRoot,
      daemonVersion: "0.11.16",
    };

    const res = await handleTeamReconcile(
      {
        schemaVersion: 1,
        id: "req-rec",
        ts: new Date().toISOString(),
        tool: "team_reconcile",
        args: {},
        requestedBy: { sessionId: "cli:test", name: "test" },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );

    expect(res.outcome).toBe("ok");
    const rec = ctx.state.peers["tst-handle"] as { observed: Record<string, unknown> };
    expect(rec.observed["identity"]).toBe("measured");
    expect(rec.observed["sessionId"]).toBe(REAL_UUID);

    // The transition unknown → measured must be VISIBLE. Without the event,
    // "temporary" and "never measured" read identically afterwards.
    const measuredEvent = events.find((e) => e.event === "peer_identity_measured");
    expect(measuredEvent).toBeDefined();
    expect(measuredEvent?.details?.["by"]).toBe("team_reconcile");
    expect(measuredEvent?.details?.["measuredSessionId"]).toBe(REAL_UUID);

    const data = res.data as Record<string, unknown>;
    expect(data["identitiesMeasured"]).toHaveLength(1);
    expect(data["identityUnknown"]).toHaveLength(0);
  }, 20_000);
});

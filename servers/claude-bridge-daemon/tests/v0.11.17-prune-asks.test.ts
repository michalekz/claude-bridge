import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

// Without this the reconcile pass writes its measurements into the REAL
// registry. The guard in atomic-write.ts catches it — see the 2026-08-07
// registry loss, which is why that guard exists at all.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

let tempHome: string;
beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "cbd-prune-"));
  homeHolder.current = tempHome;
});
afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

/**
 * v0.11.17 — two loose ends from phase 1, both about a peer nobody came back for.
 *
 * PRUNE ASKS. v0.11.15 pinned `team_layout` prune to the impolite path with a
 * TODO saying the decision was not obvious. It is resolved the other way: a peer
 * dropped from a layout has as much unwritten work as one told to sleep, and
 * prune was impolite only because `peer_stop` had no other mode when it was
 * written. Reconciliation that destroys unsaved work to make a list come true
 * has the priority backwards.
 *
 * STOP_PENDING. Idempotence covers a retry; nothing covered ABANDONMENT. A peer
 * left in `status: "stopping"` was invisible to every check — process alive, pid
 * matching, window where it should be — so `team_reconcile` called it healthy.
 * Raised by ai-designer as "who cleans up the intermediate state when the caller
 * vanishes", and it was a real hole, not a covered case.
 */

const HANDLE = "plt-extra";

function layoutCtx(stopOutcome: "ok" | "stop_ack_timeout") {
  const stopCalls: Array<Record<string, unknown>> = [];
  vi.doMock("../src/handlers/peer-stop.ts", () => ({
    handlePeerStop: async (req: { args: Record<string, unknown> }) => {
      stopCalls.push(req.args);
      return stopOutcome === "ok"
        ? { outcome: "ok", data: { stopped: true } }
        : {
            outcome: "error",
            error: { code: "stop_ack_timeout", message: "STILL RUNNING: no ack" },
          };
    },
  }));
  return { stopCalls };
}

function stateWithExtra() {
  return {
    stateVersion: 1,
    daemonVersion: "0.11.17",
    startedAt: new Date().toISOString(),
    peers: {
      [HANDLE]: {
        sessionId: HANDLE,
        desired: { team: "plt" },
        observed: {
          name: HANDLE,
          hostDriver: "tmux",
          tmuxTarget: "plt:4",
          pid: 900,
          status: "live",
          model: null,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        },
      },
    },
    config: {},
  };
}

function layoutRequest(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "req-layout",
    ts: new Date().toISOString(),
    tool: "team_layout",
    args: {
      team: "plt",
      inline: { team: "plt", peers: [] },
      prune: true,
      wake: false,
      ...extra,
    },
    requestedBy: { sessionId: "cli:test", name: "test" },
  };
}

describe("team_layout prune — asks before removing", () => {
  it("THE RESOLVED TODO: prune does not skip the courtesy any more", async () => {
    vi.resetModules();
    const { stopCalls } = layoutCtx("ok");
    const { handleTeamLayout } = await import("../src/handlers/team-layout.ts");
    const ctx = {
      state: stateWithExtra(),
      hostDriver: { name: "mock", hasSession: async () => true, listSessions: async () => [] },
      daemonVersion: "0.11.17",
    };
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
    const res = await handleTeamLayout(layoutRequest() as any, ctx as any);

    expect(res.outcome).toBe("ok");
    expect(stopCalls).toHaveLength(1);
    // v0.11.15 sent `skipCourtesy: true`. It must be gone, and force must not
    // have quietly taken its place.
    expect(stopCalls[0]?.["skipCourtesy"]).toBeUndefined();
    expect(stopCalls[0]?.["force"]).toBeUndefined();
  }, 15_000);

  it("pruneForce is the old behaviour, and has to be said", async () => {
    vi.resetModules();
    const { stopCalls } = layoutCtx("ok");
    const { handleTeamLayout } = await import("../src/handlers/team-layout.ts");
    const ctx = {
      state: stateWithExtra(),
      hostDriver: { name: "mock", hasSession: async () => true, listSessions: async () => [] },
      daemonVersion: "0.11.17",
    };
    await handleTeamLayout(
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      layoutRequest({ pruneForce: true }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );
    expect(stopCalls[0]?.["force"]).toBe(true);
  }, 15_000);

  it("a peer that REFUSES is reported apart from one that failed", async () => {
    // The two want different things from a reader: patience or `pruneForce`
    // versus investigating. Folding them together would train an operator to
    // force everything.
    vi.resetModules();
    layoutCtx("stop_ack_timeout");
    const { handleTeamLayout } = await import("../src/handlers/team-layout.ts");
    const ctx = {
      state: stateWithExtra(),
      hostDriver: { name: "mock", hasSession: async () => true, listSessions: async () => [] },
      daemonVersion: "0.11.17",
    };
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
    const res = await handleTeamLayout(layoutRequest() as any, ctx as any);

    const data = res.data as Record<string, unknown>;
    expect(data["stoppedRefused"]).toHaveLength(1);
    expect(data["stoppedFailed"]).toHaveLength(0);
    expect(data["stoppedOk"]).toHaveLength(0);
    // And the peer is still in state, because nothing killed it.
    expect(ctx.state.peers[HANDLE]).toBeDefined();
  }, 15_000);
});

describe("team_reconcile — an abandoned stop is visible", () => {
  it("THE HOLE: a peer left in 'stopping' used to read as healthy", async () => {
    vi.resetModules();
    const { handleTeamReconcile } = await import("../src/handlers/team-reconcile.ts");
    const requestedAt = new Date(Date.now() - 90_000).toISOString();
    const ctx = {
      state: {
        stateVersion: 1,
        daemonVersion: "0.11.17",
        startedAt: new Date().toISOString(),
        peers: {
          "plt-abandoned": {
            sessionId: "plt-abandoned",
            desired: { team: "plt" },
            observed: {
              name: "plt-abandoned",
              hostDriver: "tmux",
              tmuxTarget: "plt:9",
              pid: 1,
              // Alive, addressable, where it should be — every other check
              // calls this healthy.
              status: "stopping",
              model: null,
              identity: "measured",
              stopRequest: {
                threadId: "stop:plt-abandoned:x",
                msgId: "m1",
                requestedAt,
                timeoutMs: 120_000,
              },
              startedAt: new Date().toISOString(),
              lastUpdatedAt: new Date().toISOString(),
            },
          },
        },
        config: {},
      },
      hostDriver: {
        name: "mock",
        listSessions: async () => [{ sessionKey: "plt:9", pid: 1 }],
        listWindows: async () => [
          { target: "plt:9", session: "plt", window: 9, pid: 1, dead: false },
        ],
      },
      processInspector: {
        listClaudePeers: async () => [],
        ancestorsOf: async () => [],
      },
      procRoot: "/proc",
      daemonVersion: "0.11.17",
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

    const data = res.data as { drift: Array<{ kind: string; detail: string }> };
    const entry = data.drift.find((d) => d.kind === "stop_pending");
    expect(entry).toBeDefined();
    // The age is what turns "there is a flag on this record" into "somebody
    // asked ninety seconds ago and walked away".
    expect(entry?.detail).toMatch(/90s ago/);
    expect(entry?.detail).toMatch(/STILL RUNNING/);
    // Reported, not corrected: nothing was marked, nothing was killed.
    expect((res.data as Record<string, unknown>)["readOnly"]).toBe(true);
    expect(
      (ctx.state.peers["plt-abandoned"] as { observed: Record<string, unknown> }).observed[
        "status"
      ],
    ).toBe("stopping");
  }, 15_000);
});

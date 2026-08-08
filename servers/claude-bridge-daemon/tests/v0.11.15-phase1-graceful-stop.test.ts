import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.15 — phase 1 of the lifecycle redesign: the courtesy moves into
 * `peer_stop`, and this file is the acceptance the designer's gate asked for.
 *
 * Three runs, and the THIRD is the one that matters:
 *
 *   soft    — peer acks, session ends, stoppedCleanly:true
 *   hard    — force, no asking, kill happens anyway
 *   FAILED  — peer never answers → honest verdict, NOTHING KILLED, an
 *             intermediate state on the record, and a retry that resumes the
 *             same request instead of asking twice
 *
 * The failed run is first in the file on purpose. Two days of this campaign
 * went to one defect family — an actor reporting success it had not
 * established — and the only proof we did not rebuild it here is a run that is
 * SUPPOSED to fail and is watched closely while it does.
 *
 * The protocol these exercise had never run once before this release: the
 * request `team_stop` wrote since v0.10.1 disagreed with the message schema in
 * five places and was silently dropped by the reader. So these are not
 * regression tests over moved code. They are the first evidence it works.
 */

interface KillCall {
  sessionKey: string;
  force: boolean | undefined;
}

function makeCtx(opts: { alive?: boolean } = {}) {
  const killed: KillCall[] = [];
  const state = {
    stateVersion: 1,
    daemonVersion: "0.11.15",
    startedAt: new Date().toISOString(),
    peers: {} as Record<string, unknown>,
    config: {},
  };
  const ctx = {
    state,
    hostDriver: {
      name: "mock",
      hasSession: async () => opts.alive !== false,
      kill: async (sessionKey: string, o: { force?: boolean } = {}) => {
        killed.push({ sessionKey, force: o.force });
      },
    },
  };
  return { ctx, killed, state };
}

const PEER_ID = "11111111-2222-3333-4444-555555555555";

function peerRecord() {
  return {
    sessionId: PEER_ID,
    desired: { team: "tst", label: "tst-victim" },
    observed: {
      name: "tst-victim",
      hostDriver: "tmux",
      tmuxTarget: "tst:1",
      pid: 4242,
      status: "live",
      model: "claude-opus-5",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    },
  };
}

function stopRequest(peer: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: `req-${Math.abs(Math.round(Number(process.hrtime.bigint() % 100000n)))}`,
    ts: new Date().toISOString(),
    tool: "peer_stop",
    args: { peer, ...extra },
    requestedBy: { sessionId: "cli:test", name: "test" },
  };
}

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "cbd-phase1-"));
  homeHolder.current = tempHome;
  vi.resetModules();
});
afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

/** Acks WAITING to be read — `done/` is the archive subdirectory, not an ack. */
async function ackDirFiles(): Promise<string[]> {
  const names = await readdir(join(tempHome, ".claude-bridge", "control", "stop-ack")).catch(
    () => [] as string[],
  );
  return names.filter((n) => n.endsWith(".json"));
}

async function deliveredRequest(): Promise<Record<string, unknown> | null> {
  const dir = join(tempHome, ".claude-bridge", "inbox", PEER_ID, "pending");
  const files = await readdir(dir).catch(() => [] as string[]);
  const first = files[0];
  if (!first) return null;
  return JSON.parse(await readFile(join(dir, first), "utf-8"));
}

describe("RUN 3 (the one that must fail) — no ack means nothing dies", () => {
  it("reports failure honestly and leaves the peer RUNNING", async () => {
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { ctx, killed, state } = makeCtx();
    state.peers[PEER_ID] = peerRecord();

    const res = await handlePeerStop(
      stopRequest(PEER_ID, { ackTimeoutMs: 300, ackPollMs: 50 }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("stop_ack_timeout");
    // THE POINT OF THE WHOLE RELEASE: the verdict and the world agree.
    expect(killed).toHaveLength(0);
    const rec = state.peers[PEER_ID] as { observed: Record<string, unknown> };
    expect(rec.observed["status"]).toBe("stopping");
    // The message must say the peer is still running, in words, not by omission.
    expect(res.error?.message).toMatch(/STILL RUNNING/);
    expect(res.error?.message).toMatch(/force:true/);
  }, 15_000);

  it("leaves an intermediate state that names who asked and when", async () => {
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { ctx, state } = makeCtx();
    state.peers[PEER_ID] = peerRecord();

    await handlePeerStop(
      stopRequest(PEER_ID, { ackTimeoutMs: 300, ackPollMs: 50 }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );

    const rec = state.peers[PEER_ID] as {
      observed: { stopRequest?: { threadId: string; msgId: string; requestedAt: string } | null };
    };
    const pending = rec.observed.stopRequest;
    expect(pending).toBeTruthy();
    expect(pending?.threadId).toMatch(/^stop:/);
    expect(pending?.msgId).toBeTruthy();
    expect(Number.isNaN(Date.parse(pending?.requestedAt ?? ""))).toBe(false);
  }, 15_000);

  it("THE IDEMPOTENCE: a retry resumes the same request, it does not ask twice", async () => {
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { ctx, state } = makeCtx();
    state.peers[PEER_ID] = peerRecord();

    await handlePeerStop(
      stopRequest(PEER_ID, { ackTimeoutMs: 300, ackPollMs: 50 }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );
    const afterFirst = await deliveredRequest();
    const inboxDir = join(tempHome, ".claude-bridge", "inbox", PEER_ID, "pending");
    expect(await readdir(inboxDir)).toHaveLength(1);

    await handlePeerStop(
      stopRequest(PEER_ID, { ackTimeoutMs: 300, ackPollMs: 50 }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );

    // One question, asked once, however many times the operator retries.
    expect(await readdir(inboxDir)).toHaveLength(1);
    const afterSecond = await deliveredRequest();
    expect(afterSecond?.["id"]).toBe(afterFirst?.["id"]);
    expect(afterSecond?.["threadId"]).toBe(afterFirst?.["threadId"]);
  }, 20_000);

  it("a LATE ack still counts — the retry collects it and the peer stops cleanly", async () => {
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { stopAcks } = await import("../src/handlers/stop-protocol.ts");
    const { ctx, killed, state } = makeCtx();
    state.peers[PEER_ID] = peerRecord();

    await handlePeerStop(
      stopRequest(PEER_ID, { ackTimeoutMs: 300, ackPollMs: 50, keepInState: true }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );
    expect(killed).toHaveLength(0);

    // The peer finishes its anchor after the caller gave up — the exact race the
    // stale-ack sweep is normally there to reject, and the exact case a resume
    // must ACCEPT, because this ack answers the request that is still pending.
    const rec = state.peers[PEER_ID] as { observed: { stopRequest?: { threadId: string } | null } };
    const threadId = rec.observed.stopRequest?.threadId as string;
    await writeFile(stopAcks.path(PEER_ID), JSON.stringify({ threadId }), "utf-8");

    const res = await handlePeerStop(
      stopRequest(PEER_ID, { ackTimeoutMs: 2_000, ackPollMs: 50, keepInState: true }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );

    expect(res.outcome).toBe("ok");
    expect(killed).toHaveLength(1);
    const data = res.data as Record<string, unknown>;
    expect(data["mode"]).toBe("graceful");
    expect(data["stoppedCleanly"]).toBe(true);
    const after = state.peers[PEER_ID] as { observed: Record<string, unknown> };
    expect(after.observed["stoppedCleanly"]).toBe(true);
    // The pending request is history once it is answered.
    expect(after.observed["stopRequest"]).toBeNull();
  }, 20_000);
});

describe("RUN 1 (soft) — the peer acks and is stopped cleanly", () => {
  it("asks in an envelope the recipient can actually read", async () => {
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { MessageEnvelopeSchema } = await import("@claude-bridge/shared");
    const { ctx, state } = makeCtx();
    state.peers[PEER_ID] = peerRecord();

    await handlePeerStop(
      stopRequest(PEER_ID, { ackTimeoutMs: 200, ackPollMs: 50 }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );

    const delivered = await deliveredRequest();
    expect(delivered).toBeTruthy();
    // THE REGRESSION. `team_stop` wrote this message with `from`/`to` as
    // objects, `ts` instead of `sentAt`, an object `content` and a `kind` that
    // is not in the enum — five mismatches, so the reader dropped it and the
    // graceful branch could never have completed. Measured 2026-08-08.
    const parsed = MessageEnvelopeSchema.safeParse(delivered);
    expect(parsed.success).toBe(true);
    expect(delivered?.["kind"]).toBe("ask");
    expect(typeof delivered?.["content"]).toBe("string");
    expect(String(delivered?.["content"])).toContain("stop-ack");
  }, 15_000);

  it("kills only after the ack, and records the outcome it MEASURED", async () => {
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { stopAcks } = await import("../src/handlers/stop-protocol.ts");
    const { ctx, killed, state } = makeCtx();
    state.peers[PEER_ID] = peerRecord();

    // The peer answers while the daemon is still waiting.
    const acker = (async () => {
      await new Promise((r) => setTimeout(r, 150));
      await stopAcks.sweepStale(PEER_ID, "noop").catch(() => null);
      await writeFile(stopAcks.path(PEER_ID), "", "utf-8");
    })();

    const res = await handlePeerStop(
      stopRequest(PEER_ID, { ackTimeoutMs: 5_000, ackPollMs: 50, keepInState: true }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );
    await acker;

    expect(res.outcome).toBe("ok");
    const data = res.data as Record<string, unknown>;
    expect(data["stopped"]).toBe(true);
    expect(data["mode"]).toBe("graceful");
    expect(data["stoppedCleanly"]).toBe(true);
    expect(killed).toEqual([{ sessionKey: "tst:1", force: false }]);
    // The ack is consumed, so it cannot answer the next request too.
    expect(await ackDirFiles()).toHaveLength(0);
  }, 20_000);

  it("a caller cannot DECLARE an outcome the handler MEASURED", async () => {
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { stopAcks } = await import("../src/handlers/stop-protocol.ts");
    const { ctx, state } = makeCtx();
    state.peers[PEER_ID] = peerRecord();

    const acker = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      await writeFile(stopAcks.path(PEER_ID), "", "utf-8");
    })();
    const res = await handlePeerStop(
      // The caller insists the peer did not stop cleanly. It did.
      stopRequest(PEER_ID, {
        ackTimeoutMs: 5_000,
        ackPollMs: 50,
        keepInState: true,
        stoppedCleanly: false,
      }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );
    await acker;

    expect((res.data as Record<string, unknown>)["stoppedCleanly"]).toBe(true);
  }, 20_000);
});

describe("RUN 2 (hard) — force asks nothing", () => {
  it("kills immediately, writes no request, waits for nothing", async () => {
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { ctx, killed, state } = makeCtx();
    state.peers[PEER_ID] = peerRecord();

    const started = Date.now();
    const res = await handlePeerStop(
      stopRequest(PEER_ID, { force: true, keepInState: true }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );

    expect(res.outcome).toBe("ok");
    expect((res.data as Record<string, unknown>)["mode"]).toBe("forced");
    expect(killed).toEqual([{ sessionKey: "tst:1", force: true }]);
    expect(await deliveredRequest()).toBeNull();
    // Not a timing assertion for its own sake: a force that waited would be the
    // defect wearing the flag that promises it will not.
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 15_000);

  it("a peer with no host session is stopped without being asked", async () => {
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { ctx, killed, state } = makeCtx({ alive: false });
    state.peers[PEER_ID] = peerRecord();

    const res = await handlePeerStop(
      stopRequest(PEER_ID, { keepInState: true, ackTimeoutMs: 60_000 }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );

    expect(res.outcome).toBe("ok");
    const data = res.data as Record<string, unknown>;
    expect(data["mode"]).toBe("already-gone");
    // `null`, not `false`: nobody failed to answer, there was nobody to ask.
    expect(data["stoppedCleanly"]).toBeNull();
    expect(killed).toHaveLength(1);
    expect(await deliveredRequest()).toBeNull();
  }, 15_000);

  it("skipCourtesy skips the ASKING without buying the shorter verify budget", async () => {
    // The distinction the internal callers depend on: `force` also halves the
    // driver's post-kill verify, and that verify is what catches a respawn.
    const { handlePeerStop } = await import("../src/handlers/peer-stop.ts");
    const { ctx, killed, state } = makeCtx();
    state.peers[PEER_ID] = peerRecord();

    await handlePeerStop(
      stopRequest(PEER_ID, { skipCourtesy: true, keepInState: true }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      ctx as any,
    );

    expect(await deliveredRequest()).toBeNull();
    expect(killed).toEqual([{ sessionKey: "tst:1", force: false }]);
  }, 15_000);
});

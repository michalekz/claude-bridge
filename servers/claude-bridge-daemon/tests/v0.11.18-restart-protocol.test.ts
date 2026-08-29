import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

// Without this the handler writes into the REAL registry — the guard added
// after the 2026-08-07 registry loss catches it, loudly.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

let tempHome: string;
beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "cbd-restart-"));
  homeHolder.current = tempHome;
  // A fake /proc where the relaunched pid exists. Without it every restart ends
  // in `restart_died_after_spawn`, which would be the suite measuring the
  // absence of a fixture rather than the protocol.
  await mkdir(join(tempHome, "proc", "5151"), { recursive: true });
  vi.resetModules();
});
afterEach(async () => {
  vi.doUnmock("../src/handlers/peer-spawn.ts");
  vi.doUnmock("../src/handlers/peer-stop.ts");
  vi.doUnmock("../src/handlers/wake.ts");
  await rm(tempHome, { recursive: true, force: true });
});

/**
 * v0.11.18 — the owner's protocol a)–g), and the defect that measuring it found.
 *
 * The plan said step a) was "verify the id". Measured against the code, the
 * handler was not verifying anything — it was handing the REGISTRY KEY to
 * `--resume`. For a peer keyed by a handle that key names no transcript, so the
 * peer came back with no memory and the tool reported a successful restart.
 *
 * That is the quietest failure in this whole campaign: fresh pid, right window,
 * matching name, and a peer that has forgotten everything. Nothing downstream
 * can tell the difference, which is why it needed a test that watches what goes
 * on the command line rather than what the result says.
 */

const HANDLE = "tst-c";
const IDENTITY = "e8197b26-f873-40fb-afec-4e370b5c0997";

function recordFor(over: Record<string, unknown> = {}) {
  return {
    handle: HANDLE,
    desired: { team: "tst", cwd: "/tmp", command: "/usr/bin/claude", spawnArgs: ["--x"] },
    observed: {
      name: HANDLE,
      hostDriver: "tmux",
      tmuxTarget: "tst:3",
      pid: 4242,
      status: "live",
      model: null,
      sessionId: IDENTITY,
      identity: "measured",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ...over,
    },
  };
}

function stateWith(rec: unknown) {
  return {
    stateVersion: 1,
    daemonVersion: "0.11.18",
    startedAt: new Date().toISOString(),
    peers: { [HANDLE]: rec },
    config: {},
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal state
  } as any;
}

function restartRequest(args: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "req-restart",
    ts: new Date().toISOString(),
    tool: "peer_restart",
    args: { peer: HANDLE, ...args },
    requestedBy: { sessionId: "cli:test", name: "test" },
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
  } as any;
}

/** A context whose host says the peer is there. */
function ctxWith(state: unknown) {
  return {
    state,
    hostDriver: {
      name: "mock",
      hasSession: async () => true,
      kill: async () => undefined,
      sendKeys: async () => undefined,
      listWindows: async () => [],
    },
    daemonVersion: "0.11.18",
    restartSettleMs: 0,
    wakeDelayMs: 0,
    procRoot: join(tempHome, "proc"),
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
  } as any;
}

/** Stub the two primitives and the wake, and record what they were given. */
function stubPrimitives(opts: { spawnOk?: boolean; measured?: string | null } = {}) {
  const spawnArgs: Array<Record<string, unknown>> = [];
  const stopArgs: Array<Record<string, unknown>> = [];
  const wakes: Array<Record<string, unknown>> = [];
  const orderOfEvents: string[] = [];
  vi.doMock("../src/handlers/peer-spawn.ts", () => ({
    handlePeerSpawn: async (req: { args: Record<string, unknown> }) => {
      spawnArgs.push(req.args);
      orderOfEvents.push("spawn");
      return opts.spawnOk === false
        ? { outcome: "error", error: { code: "spawn_failed", message: "no" } }
        : {
            outcome: "ok",
            data: {
              pid: 5151,
              sessionKey: "tst:3",
              measuredSessionId: opts.measured === undefined ? IDENTITY : opts.measured,
            },
          };
    },
  }));
  vi.doMock("../src/handlers/peer-stop.ts", () => ({
    handlePeerStop: async (req: { args: Record<string, unknown> }) => {
      stopArgs.push(req.args);
      orderOfEvents.push("stop");
      return { outcome: "ok", data: { stopped: true, stoppedCleanly: true, mode: "graceful" } };
    },
  }));
  vi.doMock("../src/handlers/wake.ts", async () => {
    const actual =
      await vi.importActual<typeof import("../src/handlers/wake.ts")>("../src/handlers/wake.ts");
    return {
      ...actual,
      wakePeer: async (_r: unknown, _c: unknown, o: Record<string, unknown>) => {
        wakes.push(o);
        orderOfEvents.push("wake");
        return { bridgeId: HANDLE, wakeMsgId: "m1", injected: true };
      },
    };
  });
  return { spawnArgs, stopArgs, wakes, orderOfEvents };
}

describe("step a) — what gets resumed", () => {
  it("🔴 THE DEFECT: a handle-keyed peer resumes its MEASURED identity, not its key", async () => {
    const { spawnArgs } = stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor());
    const res = await handlePeerRestart(restartRequest({ force: true }), ctxWith(state));

    expect(res.outcome).toBe("ok");
    // Before v0.11.18: `resume: isResumableSessionId("tst-c")` → false, no
    // `--resume` at all, and the peer came back empty under its own name.
    expect(spawnArgs[0]?.["resume"]).toBe(true);
    expect(spawnArgs[0]?.["resumeSessionId"]).toBe(IDENTITY);
    // The KEY is still the key. This release fixes what is resumed, and renames
    // nothing.
    expect(spawnArgs[0]?.["handle"]).toBe(HANDLE);
    expect((res.data as Record<string, unknown>)["resumeSource"]).toBe("measured-identity");
  }, 15_000);

  it("a key that IS the identity keeps resuming the key — 24 of 25 fleet records", async () => {
    const { spawnArgs } = stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const rec = recordFor({ sessionId: IDENTITY });
    rec.handle = IDENTITY;
    const state = {
      stateVersion: 1,
      daemonVersion: "0.11.18",
      startedAt: new Date().toISOString(),
      peers: { [IDENTITY]: rec },
      config: {},
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal state
    } as any;
    const req = restartRequest({ force: true });
    req.args.peer = IDENTITY;
    await handlePeerRestart(req, ctxWith(state));
    expect(spawnArgs[0]?.["resumeSessionId"]).toBe(IDENTITY);
  }, 15_000);

  it("identity UNKNOWN — REFUSE, and touch nothing", async () => {
    const { spawnArgs, stopArgs } = stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor({ sessionId: null, identity: "unknown" }));
    const res = await handlePeerRestart(restartRequest(), ctxWith(state));

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("restart_identity_unknown");
    // Guessing has two options and both are bad: resume the handle (the peer
    // comes back empty) or resume nothing (the context is dropped on purpose).
    expect(stopArgs).toHaveLength(0);
    expect(spawnArgs).toHaveLength(0);
    expect(state.peers[HANDLE].observed.status).toBe("live");
  }, 15_000);
});

describe("step b) — ask, and wait", () => {
  it("the request is DELIVERED as an envelope, not built by hand", async () => {
    // The fourth member of the family that cost `peer_compact` two days and
    // `team_stop` its entire graceful branch. A hand-built envelope is dropped
    // by the reader in silence, so the writer has to be the shared one.
    stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor());
    // 300 ms window: the ack will not come, and that is the point here.
    const res = await handlePeerRestart(
      restartRequest({ readyTimeoutMs: 300, readyPollMs: 50 }),
      ctxWith(state),
    );
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("restart_ready_timeout");

    const inboxRoot = join(tempHome, ".claude-bridge", "inbox", IDENTITY, "pending");
    const files = await readdir(inboxRoot).catch(() => [] as string[]);
    expect(files.length).toBe(1);
    const env = JSON.parse(await readFile(join(inboxRoot, files[0] as string), "utf-8"));
    // The five fields `team_stop` got wrong, every one of them.
    expect(typeof env.from).toBe("string");
    expect(typeof env.to).toBe("string");
    expect(typeof env.content).toBe("string");
    expect(env.kind).toBe("ask");
    expect(typeof env.sentAt).toBe("string");
    expect(env.threadId).toMatch(/^restart:/);
    // And it must tell the peer it is COMING BACK — a peer that thinks it is
    // being shut down prepares the wrong thing.
    expect(env.content).toMatch(/COMING BACK/);
  }, 15_000);

  it("🔴 no ack = NOTHING HAPPENS: not stopped, not killed, still live", async () => {
    const { stopArgs, spawnArgs } = stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor());
    const res = await handlePeerRestart(
      restartRequest({ readyTimeoutMs: 300, readyPollMs: 50 }),
      ctxWith(state),
    );

    expect(res.outcome).toBe("error");
    expect((res.data as Record<string, unknown> | undefined) ?? {}).toBeDefined();
    expect(stopArgs).toHaveLength(0);
    expect(spawnArgs).toHaveLength(0);
    // The mark stays, in the phase it was abandoned in, so a retry can resume it
    // and `team_reconcile` can see it.
    const mark = state.peers[HANDLE].observed.restartRequest;
    expect(mark?.phase).toBe("ready-ack");
    expect(state.peers[HANDLE].observed.status).toBe("restarting");
  }, 15_000);

  it("retry UVNITŘ okna resumuje tutéž žádost — neptá se dvakrát", async () => {
    stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor());
    const ctx = ctxWith(state);

    // Druhé volání přijde DŘÍV, než první okno vyprší (60 s), takže jde
    // opravdu o pokračování téhož čekání.
    await handlePeerRestart(restartRequest({ readyTimeoutMs: 200, readyPollMs: 50 }), ctx);
    const firstThread = state.peers[HANDLE].observed.restartRequest?.threadId;
    if (state.peers[HANDLE].observed.restartRequest) {
      state.peers[HANDLE].observed.restartRequest.requestedAt = new Date().toISOString();
    }
    await handlePeerRestart(restartRequest({ readyTimeoutMs: 1_000, readyPollMs: 50 }), ctx);

    // Same thread, and one message in the inbox rather than two. A peer that
    // acks late is answering a question that was asked ONCE.
    expect(state.peers[HANDLE].observed.restartRequest?.threadId).toBe(firstThread);
    const inboxRoot = join(tempHome, ".claude-bridge", "inbox", IDENTITY, "pending");
    expect((await readdir(inboxRoot)).length).toBe(1);
  }, 15_000);

  it("🔴 ack zapsaný PO konci okna už nepustí stop — retry se ptá ZNOVU", async () => {
    // ZMĚNA KONTRAKTU 29. 8., a je to oprava dvou děr, které patří k sobě.
    //
    // ① Resume vypršelé žádosti si bral PŮVODNÍ deadline, takže okno vyšlo
    //    0 ms (naměřeno naostro `waitedMs: 1`) — a hláška přitom slibovala
    //    „call again to keep waiting, a late ack still counts".
    // ② Ack zapsaný po konci okna zůstával na disku jako MINA: velitel našel
    //    potvrzení z 13:24 pro žádost, kterou v 13:23 zrušil, a další restart
    //    by ho vzal jako platný a pustil se rovnou do stopu ŽIVÉ session.
    //
    // Samostatná oprava ① by ②-minu AKTIVOVALA (nulové okno ji do té doby
    // nechtěně krylo), proto jdou spolu. Ack odpovídá OKNU, ve kterém byl
    // vyžádán; po jeho konci se zametá a peer dostane novou otázku.
    const { stopArgs } = stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const { restartAcks } = await import("../src/handlers/restart-protocol.ts");
    const state = stateWith(recordFor());
    const ctx = ctxWith(state);

    await handlePeerRestart(restartRequest({ readyTimeoutMs: 200, readyPollMs: 50 }), ctx);
    const threadId = state.peers[HANDLE].observed.restartRequest?.threadId as string;

    // Peer odpoví, až když první volání dávno vzdalo.
    await writeFile(restartAcks.path(IDENTITY), JSON.stringify({ threadId }), "utf-8");
    const res = await handlePeerRestart(
      restartRequest({ readyTimeoutMs: 200, readyPollMs: 50 }),
      ctx,
    );

    expect(res.outcome).toBe("error");
    expect(stopArgs).toHaveLength(0);
    // Nová otázka: druhá zpráva v inboxu a nové vlákno.
    const inboxRoot = join(tempHome, ".claude-bridge", "inbox", IDENTITY, "pending");
    expect((await readdir(inboxRoot)).length).toBe(2);
    expect(state.peers[HANDLE].observed.restartRequest?.threadId).not.toBe(threadId);
  }, 15_000);

  // ODSTRANĚN 29. 8.: „a LATE ack still counts — the retry collects it".
  // Ten kontrakt přestal platit a nahradil ho test nad tímhle komentářem.
  // Slib „opožděný ack se ještě počítá" nešel držet bezpečně: potvrzení, které
  // přišlo po konci okna, nelze odlišit od potvrzení pro žádost, kterou mezitím
  // někdo zrušil — a to druhé je mina pod živou session.
});

describe("idempotence and abandonment", () => {
  it("a second caller is REFUSED past the point of no return", async () => {
    stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(
      recordFor({
        restartRequest: {
          threadId: "restart:tst-c:x",
          msgId: null,
          requestedAt: new Date().toISOString(),
          timeoutMs: 120_000,
          requestId: "req-earlier",
          phase: "spawning",
        },
      }),
    );
    const res = await handlePeerRestart(restartRequest({ force: true }), ctxWith(state));
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("restart_in_progress");
    // Entering a spawn that is already in flight is how one handle ends up with
    // two processes.
    expect(res.error?.message).toContain("spawning");
  }, 15_000);

  it("🔴 FOUND BY ACCEPTANCE: a failure that RETURNS clears its mark", async () => {
    // Left standing at first, and the acceptance run walked into what that
    // costs: the restart failed, the operator retried, and the retry was
    // refused as `restart_in_progress` for an operation that had already
    // finished failing. Nothing could clear it.
    //
    // A mark means "underway, and nobody came back". This caller came back.
    vi.doMock("../src/handlers/peer-spawn.ts", () => ({
      handlePeerSpawn: async () => ({ outcome: "ok", data: { pid: 5151 } }),
    }));
    vi.doMock("../src/handlers/peer-stop.ts", () => ({
      handlePeerStop: async () => ({
        outcome: "error",
        error: { code: "stop_ack_timeout", message: "STILL RUNNING" },
      }),
    }));
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor());
    const ctx = ctxWith(state);
    const first = await handlePeerRestart(restartRequest({ force: true }), ctx);
    expect(first.error?.code).toBe("restart_stop_failed");
    expect(state.peers[HANDLE].observed.restartRequest).toBeNull();

    // And the proof that matters: the retry is not refused.
    const second = await handlePeerRestart(restartRequest({ force: true }), ctx);
    expect(second.error?.code).toBe("restart_stop_failed");
    expect(second.error?.code).not.toBe("restart_in_progress");
  }, 15_000);

  it("🔴 the mark is written BEFORE the spawn, not after", async () => {
    // The one phase whose abandonment can leave a process no record names. A
    // mark that appears once the spawn succeeded is silent about the spawn that
    // did not.
    const phasesSeen: string[] = [];
    vi.doMock("../src/handlers/peer-spawn.ts", () => ({
      handlePeerSpawn: async () => {
        phasesSeen.push(state.peers[HANDLE].observed.restartRequest?.phase ?? "none");
        return { outcome: "error", error: { code: "spawn_failed", message: "died" } };
      },
    }));
    vi.doMock("../src/handlers/peer-stop.ts", () => ({
      handlePeerStop: async () => ({ outcome: "ok", data: { stoppedCleanly: false } }),
    }));
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor());
    const res = await handlePeerRestart(restartRequest({ force: true }), ctxWith(state));

    expect(phasesSeen).toEqual(["spawning"]);
    expect(res.error?.code).toBe("restart_spawn_failed");
    // A failed restart is over. Leaving the mark would make the next call refuse
    // and reconcile report an abandonment, for something that finished.
    expect(state.peers[HANDLE].observed.restartRequest).toBeNull();
    expect(state.peers[HANDLE].observed.status).toBe("unknown");
  }, 15_000);

  it("team_reconcile reports an abandoned restart WITH ITS PHASE", async () => {
    const { handleTeamReconcile } = await import("../src/handlers/team-reconcile.ts");
    const requestedAt = new Date(Date.now() - 45_000).toISOString();
    const ctx = {
      state: stateWith(
        recordFor({
          status: "live",
          // pid 1 exists on any Linux host, so the peer reads as ALIVE. A dead
          // peer would (correctly) be reported as `dead` first — that case is
          // the test below.
          pid: 1,
          restartRequest: {
            threadId: "restart:tst-c:y",
            msgId: "m9",
            requestedAt,
            timeoutMs: 120_000,
            requestId: "req-gone",
            phase: "spawning",
          },
        }),
      ),
      hostDriver: {
        name: "mock",
        listSessions: async () => [{ sessionKey: "tst:3", pid: 1 }],
        listWindows: async () => [
          { target: "tst:3", session: "tst", window: 3, pid: 1, dead: false },
        ],
      },
      processInspector: { listClaudePeers: async () => [], ancestorsOf: async () => [] },
      procRoot: "/proc",
      daemonVersion: "0.11.18",
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
    } as any;

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
      ctx,
    );

    const data = res.data as { drift: Array<{ kind: string; detail: string }> };
    const entry = data.drift.find((d) => d.kind === "restart_pending");
    expect(entry).toBeDefined();
    expect(entry?.detail).toMatch(/45s ago/);
    // THE PHASE IS THE POINT. "Abandoned in ready-ack" means the peer is
    // untouched; "abandoned in spawning" means check the host before relaunching
    // anything, or the retry becomes a fork.
    expect(entry?.detail).toMatch(/spawning/);
    expect(entry?.detail).toMatch(/CHECK THE HOST/);
    // Reported, never corrected.
    expect((res.data as Record<string, unknown>)["readOnly"]).toBe(true);
  }, 15_000);

  it("🔴 a DEAD peer with a restart mark says so — 'just relaunch it' is the trap", async () => {
    const { handleTeamReconcile } = await import("../src/handlers/team-reconcile.ts");
    const ctx = {
      state: stateWith(
        recordFor({
          status: "live",
          pid: 999_999, // not running
          restartRequest: {
            threadId: "restart:tst-c:z",
            msgId: null,
            requestedAt: new Date(Date.now() - 10_000).toISOString(),
            timeoutMs: 120_000,
            requestId: "req-gone",
            phase: "spawning",
          },
        }),
      ),
      hostDriver: {
        name: "mock",
        listSessions: async () => [],
        listWindows: async () => [],
      },
      processInspector: { listClaudePeers: async () => [], ancestorsOf: async () => [] },
      procRoot: "/proc",
      daemonVersion: "0.11.18",
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
    } as any;

    const res = await handleTeamReconcile(
      {
        schemaVersion: 1,
        id: "req-rec2",
        ts: new Date().toISOString(),
        tool: "team_reconcile",
        args: {},
        requestedBy: { sessionId: "cli:test", name: "test" },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      } as any,
      ctx,
    );

    const data = res.data as { drift: Array<{ kind: string; detail: string }> };
    const entry = data.drift.find((d) => d.kind === "dead");
    // `dead` is the measured fact and stays the kind. But the detail has to
    // carry the mark, or an operator reads "dead peer" and relaunches over a
    // spawn that may have half-run — which is a fork.
    expect(entry?.detail).toMatch(/RESTART WAS UNDERWAY/);
    expect(entry?.detail).toMatch(/spawning/);
  }, 15_000);
});

describe("step g) — the peer is told what happened", () => {
  it("a graceful restart reports, and says the anchor should be whole", async () => {
    const { wakes } = stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const { restartAcks } = await import("../src/handlers/restart-protocol.ts");
    const state = stateWith(recordFor());
    const ctx = ctxWith(state);
    await handlePeerRestart(restartRequest({ readyTimeoutMs: 200, readyPollMs: 50 }), ctx);
    const threadId = state.peers[HANDLE].observed.restartRequest?.threadId as string;
    // Ack UVNITŘ okna: značka se posune na „teď", takže druhé volání okno
    // resumuje místo aby ho otevíralo znovu (od 29. 8. je ack platný jen pro
    // okno, ve kterém byl vyžádán).
    if (state.peers[HANDLE].observed.restartRequest) {
      state.peers[HANDLE].observed.restartRequest.requestedAt = new Date().toISOString();
    }
    await writeFile(restartAcks.path(IDENTITY), JSON.stringify({ threadId }), "utf-8");
    const res = await handlePeerRestart(
      restartRequest({ readyTimeoutMs: 2_000, readyPollMs: 50 }),
      ctx,
    );

    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.["event"]).toBe("restarted");
    expect(wakes[0]?.["stoppedCleanly"]).toBe(true);
    expect((res.data as Record<string, unknown>)["reported"]).toBe(true);
  }, 15_000);

  it("🔴 FORCE still reports — that is the case where it matters most", async () => {
    // A forced stop measures `stoppedCleanly: false`; the wake turns that into
    // "your anchor may be mid-write".
    const wakes: Array<Record<string, unknown>> = [];
    const orderOfEvents: string[] = [];
    vi.doMock("../src/handlers/peer-spawn.ts", () => ({
      handlePeerSpawn: async () => {
        orderOfEvents.push("spawn");
        return {
          outcome: "ok",
          data: { pid: 5151, sessionKey: "tst:3", measuredSessionId: IDENTITY },
        };
      },
    }));
    vi.doMock("../src/handlers/peer-stop.ts", () => ({
      handlePeerStop: async () => {
        orderOfEvents.push("stop");
        return { outcome: "ok", data: { stopped: true, stoppedCleanly: false, mode: "forced" } };
      },
    }));
    vi.doMock("../src/handlers/wake.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../src/handlers/wake.ts")>("../src/handlers/wake.ts");
      return {
        ...actual,
        wakePeer: async (_r: unknown, _c: unknown, o: Record<string, unknown>) => {
          wakes.push(o);
          orderOfEvents.push("wake");
          return { bridgeId: HANDLE, wakeMsgId: "m1", injected: true };
        },
      };
    });
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor());
    const res = await handlePeerRestart(restartRequest({ force: true }), ctxWith(state));

    expect(res.outcome).toBe("ok");
    expect((res.data as Record<string, unknown>)["mode"]).toBe("forced");
    // Force skips WAITING, never EVIDENCE — and a warning that never arrives is
    // the absence of evidence. The peer that was never asked to tidy up is
    // exactly the peer most likely to be holding a half-written anchor.
    expect((res.data as Record<string, unknown>)["reported"]).toBe(true);
    expect(wakes[0]?.["stoppedCleanly"]).toBe(false);
    expect(orderOfEvents).toEqual(["stop", "spawn", "wake"]);
  }, 15_000);

  it("🔴 FOUND BY ACCEPTANCE: a forced stop reports null, and the warning still fires", async () => {
    // The live run of this release: `peer_stop` skips the courtesy under force,
    // so it has nothing to measure and returns `stoppedCleanly: null` — and the
    // wake only warns on `false`. The peer least entitled to reassurance got the
    // most reassuring message there is: none at all, after being killed
    // mid-sentence.
    const wakes: Array<Record<string, unknown>> = [];
    vi.doMock("../src/handlers/peer-spawn.ts", () => ({
      handlePeerSpawn: async () => ({
        outcome: "ok",
        data: { pid: 5151, sessionKey: "tst:3", measuredSessionId: IDENTITY },
      }),
    }));
    vi.doMock("../src/handlers/peer-stop.ts", () => ({
      // Exactly what the real primitive returns under force.
      handlePeerStop: async () => ({
        outcome: "ok",
        data: { stopped: true, stoppedCleanly: null, mode: "forced" },
      }),
    }));
    vi.doMock("../src/handlers/wake.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../src/handlers/wake.ts")>("../src/handlers/wake.ts");
      return {
        ...actual,
        wakePeer: async (_r: unknown, _c: unknown, o: Record<string, unknown>) => {
          wakes.push(o);
          return { bridgeId: HANDLE, wakeMsgId: "m1", injected: true };
        },
      };
    });
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor());
    await handlePeerRestart(restartRequest({ force: true }), ctxWith(state));

    // Whether we ASKED is a fact this handler owns, and from the peer's side an
    // unasked stop is an unclean one.
    expect(wakes[0]?.["stoppedCleanly"]).toBe(false);
  }, 15_000);

  it("the FORCED wake message names the risk in words the peer can act on", async () => {
    const { wakePeer } = await import("../src/handlers/wake.ts");
    const written: string[] = [];
    const req = {
      id: "r",
      requestedBy: { sessionId: "cli", name: "t" },
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
    } as any;
    const ctx = {
      hostDriver: { name: "mock", sendKeys: async (_k: string, p: string) => written.push(p) },
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
    } as any;
    await wakePeer(req, ctx, {
      bridgeId: HANDLE,
      sessionKey: "tst:3",
      reason: "roll",
      stoppedCleanly: false,
      event: "restarted",
      wakeDelayMs: 0,
    });

    const inboxRoot = join(tempHome, ".claude-bridge", "inbox", HANDLE, "pending");
    const files = await readdir(inboxRoot);
    const env = JSON.parse(await readFile(join(inboxRoot, files[0] as string), "utf-8"));
    expect(env.content).toMatch(/FORCED/);
    expect(env.content).toMatch(/ANCHOR MAY BE MID-WRITE/);
    expect(written).toHaveLength(1);
  }, 15_000);
});

describe("🔴 the address a request is sent to (found by acceptance)", () => {
  /**
   * The daemon keys its registry by HANDLE. The bridge — inboxes, acks, replies
   * — keys everything by the peer's own session id, because that is the only
   * name a peer knows itself by. For 24 of 25 fleet records those are the same
   * string, so nothing noticed for three releases.
   *
   * Measured on a live scratch peer 2026-08-08: the request landed in
   * `inbox/tst-r18/pending/` (1 file) while the peer drained
   * `inbox/bbcaed51-…/pending/` (0 files). The peer reported "my inbox is
   * empty"; the daemon reported a timeout. Both were telling the truth.
   *
   * Same family as N4 and as the three hand-built envelopes: written, addressed
   * wrong, dropped without a word. It applies to compact and stop too — this is
   * not new to the restart, it is newly REACHABLE, because `team_layout` names
   * peers by handle.
   */
  it("the request goes to the peer's IDENTITY, not to the registry key", async () => {
    stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const state = stateWith(recordFor());
    await handlePeerRestart(
      restartRequest({ readyTimeoutMs: 200, readyPollMs: 50 }),
      ctxWith(state),
    );

    const byIdentity = join(tempHome, ".claude-bridge", "inbox", IDENTITY, "pending");
    const byHandle = join(tempHome, ".claude-bridge", "inbox", HANDLE, "pending");
    expect((await readdir(byIdentity)).length).toBe(1);
    // The handle inbox must not even exist — nobody drains it.
    expect(await readdir(byHandle).catch(() => null)).toBeNull();
    // And the envelope says so, so a reader of the file can tell too.
    const files = await readdir(byIdentity);
    const env = JSON.parse(await readFile(join(byIdentity, files[0] as string), "utf-8"));
    expect(env.to).toBe(IDENTITY);
  }, 15_000);

  it("the ack is polled at the same address the peer was told to write", async () => {
    // The message tells the peer to write `<sessionId>.json`, and the only
    // session id a peer knows is its own. If the daemon polled the handle it
    // would wait out the window next to a file that was already there.
    stubPrimitives();
    const { handlePeerRestart } = await import("../src/handlers/peer-restart.ts");
    const { restartAcks } = await import("../src/handlers/restart-protocol.ts");
    const state = stateWith(recordFor());
    const ctx = ctxWith(state);
    await handlePeerRestart(restartRequest({ readyTimeoutMs: 200, readyPollMs: 50 }), ctx);
    const threadId = state.peers[HANDLE].observed.restartRequest?.threadId as string;

    await writeFile(restartAcks.path(IDENTITY), JSON.stringify({ threadId }), "utf-8");
    const res = await handlePeerRestart(
      restartRequest({ readyTimeoutMs: 500, readyPollMs: 50 }),
      ctx,
    );
    expect(res.outcome).toBe("ok");
  }, 15_000);
});

describe("the startup sweep covers every channel", () => {
  it("🔴 it swept only compact-ack from v0.10.0 to v0.11.17", async () => {
    const { ALL_ACK_CHANNELS } = await import("../src/handlers/ack-protocol.ts");
    const { sweepAllAcksAtStartup } = await import("../src/handlers/peer-compact.ts");
    const { mkdir } = await import("node:fs/promises");

    for (const ch of ALL_ACK_CHANNELS) {
      await mkdir(ch.dir(), { recursive: true });
      await writeFile(ch.path("someone"), "{}", "utf-8");
    }
    // Three channels existed; two of them were never swept, so a daemon that
    // died mid-stop left an ack waiting for the next request — the exact case
    // this function was written for.
    expect(await sweepAllAcksAtStartup()).toBe(ALL_ACK_CHANNELS.length);
    for (const ch of ALL_ACK_CHANNELS) {
      expect(await readdir(ch.dir())).toEqual(["done"]);
    }
  }, 15_000);
});

describe("v0.11.19 — the same defect in the tool that makes handle-keyed peers", () => {
  /**
   * `team_layout` names peers before they exist, so its spec entries are handles
   * by construction. Its resume path passed that handle to `--resume`, which is
   * exactly the v0.11.18 defect one tool over — and the more dangerous instance,
   * because closing the hole in `peer_restart` while leaving it open in the tool
   * that produces the records would fix the symptom at one end and keep the
   * source at the other.
   */
  it("🔴 a resumed tombstone gets its MEASURED identity, not its handle", async () => {
    const spawnArgs: Array<Record<string, unknown>> = [];
    vi.doMock("../src/handlers/peer-spawn.ts", () => ({
      handlePeerSpawn: async (req: { args: Record<string, unknown> }) => {
        spawnArgs.push(req.args);
        return { outcome: "ok", data: { pid: 7, sessionKey: "tst:1" } };
      },
    }));
    const { handleTeamLayout } = await import("../src/handlers/team-layout.ts");
    // A tombstone, as `peer_stop keepInState` leaves one: no pid, no status,
    // and the identity still measured.
    const state = stateWith({
      bridgeId: HANDLE,
      desired: { team: "tst", cwd: "/tmp", command: "/usr/bin/claude", spawnArgs: [] },
      observed: {
        name: HANDLE,
        hostDriver: "tmux",
        tmuxTarget: null,
        pid: null,
        status: "stopped",
        model: null,
        sessionId: IDENTITY,
        identity: "measured",
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      },
    });
    const ctx = {
      state,
      hostDriver: { name: "mock", hasSession: async () => false, listSessions: async () => [] },
      daemonVersion: "0.11.19",
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
    } as any;

    await handleTeamLayout(
      {
        schemaVersion: 1,
        id: "req-layout",
        ts: new Date().toISOString(),
        tool: "team_layout",
        args: {
          team: "tst",
          apply: true,
          wake: false,
          inline: {
            team: "tst",
            peers: [
              {
                handle: HANDLE,
                displayName: HANDLE,
                cwd: "/tmp",
                command: "/usr/bin/claude",
                resume: true,
              },
            ],
          },
        },
        requestedBy: { sessionId: "cli:test", name: "test" },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      } as any,
      ctx,
    );

    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0]?.["resume"]).toBe(true);
    // Before v0.11.19: absent, so `--resume tst-c` — a string no transcript is
    // named after. The peer wedges in the Resume picker under a new identity.
    expect(spawnArgs[0]?.["resumeSessionId"]).toBe(IDENTITY);
    // The handle is still the key. Only what gets resumed changed.
    expect(spawnArgs[0]?.["handle"]).toBe(HANDLE);
  }, 15_000);

  it("an unmeasured record resumes nothing extra — no guessing", async () => {
    const spawnArgs: Array<Record<string, unknown>> = [];
    vi.doMock("../src/handlers/peer-spawn.ts", () => ({
      handlePeerSpawn: async (req: { args: Record<string, unknown> }) => {
        spawnArgs.push(req.args);
        return { outcome: "ok", data: { pid: 7 } };
      },
    }));
    const { handleTeamLayout } = await import("../src/handlers/team-layout.ts");
    const state = stateWith({
      bridgeId: HANDLE,
      desired: { team: "tst", cwd: "/tmp", command: "/usr/bin/claude", spawnArgs: [] },
      observed: {
        name: HANDLE,
        hostDriver: "tmux",
        tmuxTarget: null,
        pid: null,
        status: "stopped",
        model: null,
        sessionId: null,
        identity: "unknown",
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      },
    });
    const ctx = {
      state,
      hostDriver: { name: "mock", hasSession: async () => false, listSessions: async () => [] },
      daemonVersion: "0.11.19",
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
    } as any;
    await handleTeamLayout(
      {
        schemaVersion: 1,
        id: "req-layout2",
        ts: new Date().toISOString(),
        tool: "team_layout",
        args: {
          team: "tst",
          apply: true,
          wake: false,
          inline: {
            team: "tst",
            peers: [
              {
                handle: HANDLE,
                displayName: HANDLE,
                cwd: "/tmp",
                command: "/usr/bin/claude",
                resume: true,
              },
            ],
          },
        },
        requestedBy: { sessionId: "cli:test", name: "test" },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
      } as any,
      ctx,
    );
    // An identity we never measured is not an identity to resume.
    expect(spawnArgs[0]?.["resumeSessionId"]).toBeUndefined();
  }, 15_000);
});

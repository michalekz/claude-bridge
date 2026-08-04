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
    inspector: await import("../src/hosts/process-inspector.ts"),
  };
}

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-1") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-03T21:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "adopt-caller", name: "adopt-caller" },
  };
}

type ProcRec = import("../src/hosts/process-inspector.ts").ProcessRecord;

/**
 * Fake process table: a flat pid -> ppid map plus the Claude peers found in it.
 * Lets the adoption tests exercise the real ancestry walk without needing tmux
 * or live Claude processes.
 */
function fakeInspector(peers: ProcRec[], parents: Record<number, number> = {}) {
  return {
    listClaudePeers: async () => peers,
    ancestorsOf: async (pid: number, maxDepth = 8) => {
      const chain: number[] = [];
      let cur = pid;
      for (let i = 0; i < maxDepth; i++) {
        const p = parents[cur];
        if (p === undefined || p <= 1) break;
        chain.push(p);
        cur = p;
      }
      return chain;
    },
  };
}

function peer(
  pid: number,
  ppid: number,
  sessionId: string | null,
  over: Partial<ProcRec> = {},
): ProcRec {
  // An absolute interpreter path, the way an nvm-installed `claude` appears in
  // /proc — a bare name would hide the very case adoption has to carry through.
  const argv = ["/home/u/.nvm/versions/node/v24/bin/claude", "--resume", sessionId ?? "none"];
  return {
    pid,
    ppid,
    sessionId,
    sessionIdSource: sessionId ? "sessions-json" : "none",
    cmdline: argv.join(" "),
    argv,
    cwd: "/opt/project",
    ...over,
  };
}

/**
 * v0.10.1 team_adopt — take over peers the daemon did not spawn.
 *
 * Motivating case (velitel, 2026-07-25 16:54): the HMH team was started by
 * start_peer.sh, so state.peers was empty while eleven peers were live, and
 * peer_compact returned peer_not_found with no audited fallback.
 */
describe("v0.10.1 team_adopt", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-adopt-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  /** Two tmux sessions, each with a shell whose child is a Claude process. */
  async function twoSessionFixture() {
    const { mock } = await importAll();
    const driver = new mock.MockDriver();
    // Register host sessions whose pane pid is the SHELL, not claude —
    // matching how tmux actually reports panes.
    driver.listSessions = async () => [
      { sessionKey: "hmh_alice", alive: true, pid: 100 },
      { sessionKey: "hmh_bob", alive: true, pid: 200 },
    ];
    const inspector = fakeInspector(
      [
        peer(101, 100, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"),
        peer(201, 200, "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"),
      ],
      { 101: 100, 201: 200 },
    );
    return { driver, inspector };
  }

  it("dryRun is the DEFAULT — it plans the adoption and writes nothing", async () => {
    const { handlers, state } = await importAll();
    const doc = state.emptyState("0.10.1-rc.1");
    const { driver, inspector } = await twoSessionFixture();

    // Note: no dryRun in args at all.
    const res = await handlers.dispatch(makeRequest("team_adopt", { team: "hmh" }, "req-dry"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.10.1-rc.1",
      processInspector: inspector,
    });
    expect(res.outcome).toBe("ok");
    const data = res.data as {
      dryRun: boolean;
      mode: string;
      planned: Array<{ sessionId: string }>;
    };
    expect(data.dryRun).toBe(true);
    expect(data.mode).toBe("auto");
    expect(data.planned.map((p) => p.sessionId).sort()).toEqual([
      "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    ]);
    // THE ASSERTION: nothing was taken over.
    expect(Object.keys(doc.peers)).toHaveLength(0);
  });

  it("dryRun:false adopts, stamping team, tmuxTarget, pid and the adopted flag", async () => {
    const { handlers, state } = await importAll();
    const doc = state.emptyState("0.10.1-rc.1");
    const { driver, inspector } = await twoSessionFixture();

    const res = await handlers.dispatch(
      makeRequest("team_adopt", { team: "hmh", dryRun: false }, "req-adopt"),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.1", processInspector: inspector },
    );
    expect(res.outcome).toBe("ok");
    expect((res.data as { adopted: string[] }).adopted).toHaveLength(2);

    const rec = doc.peers["aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"];
    expect(rec?.status).toBe("live");
    expect(rec?.team).toBe("hmh");
    expect(rec?.adopted).toBe(true);
    expect(rec?.tmuxTarget).toBe("hmh_alice");
    expect(rec?.pid).toBe(101);
    expect(rec?.hostDriver).toBe("mock");
  });

  it("two Claude processes in one pane are reported ambiguous, never guessed", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.1");
    const driver = new mock.MockDriver();
    driver.listSessions = async () => [{ sessionKey: "hmh_dup", alive: true, pid: 300 }];
    // The §6/11 duplicate-identity failure mode: one pane, two peers.
    const inspector = fakeInspector(
      [
        peer(301, 300, "cccccccc-3333-4333-8333-cccccccccccc"),
        peer(302, 300, "dddddddd-4444-4444-8444-dddddddddddd"),
      ],
      { 301: 300, 302: 300 },
    );

    const res = await handlers.dispatch(
      makeRequest("team_adopt", { team: "hmh", dryRun: false }, "req-ambig"),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.1", processInspector: inspector },
    );
    expect(res.outcome).toBe("ok");
    const data = res.data as {
      adopted: string[];
      ambiguous: Array<{ sessionKey: string; candidates: unknown[] }>;
    };
    expect(data.adopted).toEqual([]);
    expect(data.ambiguous).toHaveLength(1);
    expect(data.ambiguous[0]?.sessionKey).toBe("hmh_dup");
    expect(data.ambiguous[0]?.candidates).toHaveLength(2);
    // Ambiguity must never end up in state.
    expect(Object.keys(doc.peers)).toHaveLength(0);
  });

  it("skips a peer the daemon already runs, so a live record is never overwritten", async () => {
    const { handlers, state } = await importAll();
    const doc = state.emptyState("0.10.1-rc.1");
    const { driver, inspector } = await twoSessionFixture();
    const known = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    doc.peers[known] = {
      sessionId: known,
      name: "spawned-by-daemon",
      hostDriver: "mock",
      tmuxTarget: "hmh_alice",
      pid: 999,
      status: "live",
      model: "claude-opus-4-7",
      accountProfile: null,
      startedAt: "2026-08-03T10:00:00.000Z",
      lastUpdatedAt: "2026-08-03T10:00:00.000Z",
    };

    const res = await handlers.dispatch(
      makeRequest("team_adopt", { team: "hmh", dryRun: false }, "req-known"),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.1", processInspector: inspector },
    );
    const data = res.data as {
      adopted: string[];
      skipped: Array<{ sessionKey: string; reason: string }>;
    };
    expect(data.adopted).toEqual(["bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"]);
    expect(data.skipped.some((s) => s.reason === "already_adopted")).toBe(true);
    // Provenance of the spawned record survives untouched.
    expect(doc.peers[known]?.name).toBe("spawned-by-daemon");
    expect(doc.peers[known]?.model).toBe("claude-opus-4-7");
    expect(doc.peers[known]?.adopted).toBeUndefined();
  });

  it("a session with no Claude process inside is skipped, not invented", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.1");
    const driver = new mock.MockDriver();
    driver.listSessions = async () => [{ sessionKey: "just_a_shell", alive: true, pid: 400 }];
    const inspector = fakeInspector([], {});

    const res = await handlers.dispatch(
      makeRequest("team_adopt", { team: "hmh", dryRun: false }, "req-empty"),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.1", processInspector: inspector },
    );
    const data = res.data as { adopted: string[]; skipped: Array<{ reason: string }> };
    expect(data.adopted).toEqual([]);
    expect(data.skipped[0]?.reason).toBe("no_claude_process");
  });

  it("manual mode maps host sessions explicitly and canonicalizes the key", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.1");
    const driver = new mock.MockDriver();
    driver.listSessions = async () => [{ sessionKey: "hmh_carol", alive: true, pid: 500 }];

    const res = await handlers.dispatch(
      makeRequest(
        "team_adopt",
        {
          team: "hmh",
          mode: "manual",
          // Raw key with a colon — must canonicalize to hmh_carol (T1 contract).
          mapping: { "hmh:carol": "eeeeeeee-5555-4555-8555-eeeeeeeeeeee" },
          dryRun: false,
        },
        "req-manual",
      ),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.1" },
    );
    expect(res.outcome).toBe("ok");
    expect((res.data as { adopted: string[] }).adopted).toEqual([
      "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
    ]);
    expect(doc.peers["eeeeeeee-5555-4555-8555-eeeeeeeeeeee"]?.tmuxTarget).toBe("hmh_carol");
  });

  it("manual mode without a mapping is rejected", async () => {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.1-rc.1");
    const res = await handlers.dispatch(
      makeRequest("team_adopt", { team: "hmh", mode: "manual" }, "req-nomap"),
      { state: doc, hostDriver: new mock.MockDriver(), daemonVersion: "0.10.1-rc.1" },
    );
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("mapping_required");
  });

  /**
   * An adopted record has to carry HOW to relaunch the peer, not just its name.
   *
   * Without `command`/`spawnArgs`/`cwd` the first daemon-issued `peer_restart`
   * falls back to a bare `claude`, which under nvm resolves to nothing. Adopting
   * twenty-three peers that way would look complete and leave the control layer
   * unusable at the exact moment anyone first reached for it (raised by
   * plt-designer, 2026-08-04).
   */
  it("THE REGRESSION: adoption records command, args and cwd from /proc", async () => {
    const { handlers, state } = await importAll();
    const doc = state.emptyState("0.10.1-rc.1");
    const { driver, inspector } = await twoSessionFixture();

    const res = await handlers.dispatch(
      makeRequest("team_adopt", { team: "hmh", dryRun: false }, "adopt-launch"),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.1", processInspector: inspector },
    );
    expect(res.outcome).toBe("ok");

    const records = Object.values(doc.peers);
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      // The absolute path the process was actually started with — not "claude".
      expect(rec.command).toBe("/home/u/.nvm/versions/node/v24/bin/claude");
      expect(rec.cwd).toBe("/opt/project");
      // `--resume` is re-appended by peer_spawn; storing it would double it.
      expect(rec.spawnArgs).not.toContain("--resume");
    }
  });

  it("a dry run shows the launch parameters before anything is written", async () => {
    const { handlers, state } = await importAll();
    const doc = state.emptyState("0.10.1-rc.1");
    const { driver, inspector } = await twoSessionFixture();

    const res = await handlers.dispatch(
      makeRequest("team_adopt", { team: "hmh", dryRun: true }, "adopt-preview"),
      { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.1", processInspector: inspector },
    );
    expect(res.outcome).toBe("ok");
    const plan = res.data as {
      planned: Array<{ command: string | null; cwd: string | null }>;
      hostWindowsSeen: number;
    };
    // Visible in the PLAN, so a pilot can prove restartability before granting
    // dryRun:false — the gate that is still closed on this layout.
    expect(plan.planned.length).toBeGreaterThan(0);
    for (const p of plan.planned) {
      expect(p.command).toBe("/home/u/.nvm/versions/node/v24/bin/claude");
      expect(p.cwd).toBe("/opt/project");
    }
    // And the plan states how many host windows it looked at, so "4 planned"
    // can never again be read without knowing the denominator.
    expect(plan.hostWindowsSeen).toBeGreaterThan(0);
    expect(Object.keys(doc.peers)).toHaveLength(0);
  });
});

describe("process-inspector parsing", () => {
  it("parses ppid past a comm containing spaces and parentheses", async () => {
    const { inspector } = await importAll();
    // Real-world hazard: comm is parenthesised and may itself contain ')'.
    expect(inspector.parsePpidFromStat("4242 (weird (name) here) S 100 4242 …")).toBe(100);
    expect(inspector.parsePpidFromStat("7 (claude) R 1234 7 7 0")).toBe(1234);
    expect(inspector.parsePpidFromStat("garbage")).toBeNull();
  });

  it("extracts the session id from a --resume TRANSCRIPT PATH, not just a bare uuid", async () => {
    const { inspector } = await importAll();
    // This is how start_peer.sh actually invokes claude — verified on the live fleet.
    expect(
      inspector.sessionIdFromCmdline(
        "claude --dangerously-skip-permissions --resume /home/u/.claude/projects/-opt-hmh/6508975c-82bc-48ac-ba43-f41145ad6ab3.jsonl --model x",
      ),
    ).toBe("6508975c-82bc-48ac-ba43-f41145ad6ab3");
    expect(
      inspector.sessionIdFromCmdline("claude --resume 6508975c-82bc-48ac-ba43-f41145ad6ab3"),
    ).toBe("6508975c-82bc-48ac-ba43-f41145ad6ab3");
    expect(inspector.sessionIdFromCmdline("claude --model opus")).toBeNull();
  });
});

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
 * Five findings from plt-designer's v0.10.6 pilot. Everything the pilot passed
 * is already covered; these are the parts that failed.
 */

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
  adopt: await import("../src/handlers/team-adopt.ts"),
  restart: await import("../src/handlers/peer-restart.ts"),
});

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-p") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-04T19:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

const CLAUDE = "/home/u/.nvm/versions/node/v24/bin/claude";

describe("A — adoption must not lose the model", () => {
  it("--model is pulled out of argv into its own field, not dropped", async () => {
    const { adopt } = await importAll();
    const p = adopt.extractLaunchParams([
      CLAUDE,
      "--mcp-config",
      "/etc/mcp.json",
      "--model",
      "claude-opus-5",
      "--resume",
      "5c8b1b7e-0000-4000-8000-000000000000",
    ]);

    expect(p.command).toBe(CLAUDE);
    // The pilot found kb-ops on --model claude-opus-5 and the plan carrying
    // neither it nor a model field: the peer would have come back on the default.
    expect(p.model).toBe("claude-opus-5");
    // Both flags stay out of spawnArgs — peer_spawn appends its own.
    expect(p.spawnArgs).toEqual(["--mcp-config", "/etc/mcp.json"]);
    expect(p.spawnArgs).not.toContain("--model");
    expect(p.spawnArgs).not.toContain("--resume");
  });

  it("no --model means null, not an invented default", async () => {
    const { adopt } = await importAll();
    expect(adopt.extractLaunchParams([CLAUDE, "--mcp-config", "/x"]).model).toBeNull();
  });
});

describe("C — a restart must not resume something that is not a transcript", () => {
  it("THE HANG: a stable name is not resumable", async () => {
    const { restart } = await importAll();
    // `claude --resume obetni-w3` matches nothing, so Claude Code opens its
    // interactive Resume picker and the peer sits there wedged.
    expect(restart.isResumableSessionId("obetni-w3")).toBe(false);
    expect(restart.isResumableSessionId("plt-bridge-dev")).toBe(false);
  });

  it("a UUID is", async () => {
    const { restart } = await importAll();
    expect(restart.isResumableSessionId("fb749bc6-c2f6-404c-8af4-422dfc2eb42e")).toBe(true);
  });
});

describe("C — identity is verified after the restart, not assumed", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cb-ident-"));
    await mkdir(join(home, ".claude", "sessions"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const EXPECTED = "fb749bc6-c2f6-404c-8af4-422dfc2eb42e";

  async function sessionFile(pid: number, sessionId: string) {
    await writeFile(
      join(home, ".claude", "sessions", `${pid}.json`),
      JSON.stringify({ sessionId }),
      "utf-8",
    );
  }

  it("same id back = no mismatch", async () => {
    const { restart } = await importAll();
    await sessionFile(4242, EXPECTED);
    const r = await restart.verifyRestartedIdentity(EXPECTED, 4242, {
      attempts: 1,
      delayMs: 0,
      homeDir: home,
    });
    expect(r.mismatch).toBe(false);
    expect(r.actual).toBe(EXPECTED);
  });

  it("THE REGRESSION: a different id back IS a mismatch", async () => {
    const { restart } = await importAll();
    // The pilot's case: the resume did not take, Claude Code started fresh, the
    // pid matched the record, and everything downstream kept saying "live"
    // about an identity that had moved.
    await sessionFile(4242, "7b885aad-1111-4111-8111-111111111111");
    const r = await restart.verifyRestartedIdentity(EXPECTED, 4242, {
      attempts: 1,
      delayMs: 0,
      homeDir: home,
    });
    expect(r.mismatch).toBe(true);
    expect(r.actual).toBe("7b885aad-1111-4111-8111-111111111111");
  });

  it("an unreadable file is NOT a mismatch — silence is not evidence", async () => {
    const { restart } = await importAll();
    const r = await restart.verifyRestartedIdentity(EXPECTED, 9999, {
      attempts: 1,
      delayMs: 0,
      homeDir: home,
    });
    expect(r.mismatch).toBe(false);
    expect(r.actual).toBeNull();
  });

  it("a non-resumable id is not checked at all — there is nothing to compare", async () => {
    const { restart } = await importAll();
    await sessionFile(4242, "anything-at-all");
    const r = await restart.verifyRestartedIdentity("obetni-w3", 4242, {
      attempts: 1,
      delayMs: 0,
      homeDir: home,
    });
    expect(r.mismatch).toBe(false);
  });
});

describe("E — adoption can be scoped to one host session", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-filter-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  async function fixture() {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.7-test");
    const driver = new mock.MockDriver();
    driver.listSessions = async () => [];
    // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the optional method
    (driver as any).listWindows = async () => [
      { target: "@1", label: "hmh:1", session: "hmh", window: 1, windowName: "a", pid: 101 },
      { target: "@2", label: "hmh:2", session: "hmh", window: 2, windowName: "b", pid: 102 },
      { target: "@3", label: "etl:1", session: "etl", window: 1, windowName: "c", pid: 103 },
    ];
    const inspector = {
      listClaudePeers: async () => [
        {
          pid: 101,
          ppid: 1,
          sessionId: "aaaaaaaa-0000-4000-8000-000000000000",
          sessionIdSource: "sessions-json" as const,
          cmdline: "",
          argv: [CLAUDE],
          cwd: "/x",
        },
        {
          pid: 102,
          ppid: 1,
          sessionId: "bbbbbbbb-0000-4000-8000-000000000000",
          sessionIdSource: "sessions-json" as const,
          cmdline: "",
          argv: [CLAUDE],
          cwd: "/x",
        },
        {
          pid: 103,
          ppid: 1,
          sessionId: "cccccccc-0000-4000-8000-000000000000",
          sessionIdSource: "sessions-json" as const,
          cmdline: "",
          argv: [CLAUDE],
          cwd: "/x",
        },
      ],
      ancestorsOf: async () => [],
    };
    return {
      handlers,
      ctx: {
        state: doc,
        hostDriver: driver,
        daemonVersion: "0.10.7-test",
        processInspector: inspector,
      },
    };
  }

  it("THE GAP: without a filter every window lands in one team", async () => {
    const { handlers, ctx } = await fixture();
    const res = await handlers.dispatch(makeRequest("team_adopt", { team: "all" }), ctx);
    expect((res.data as { hostWindowsSeen: number }).hostWindowsSeen).toBe(3);
  });

  it("hostSession scopes adoption to one family", async () => {
    const { handlers, ctx } = await fixture();
    const res = await handlers.dispatch(
      makeRequest("team_adopt", { team: "hmh", hostSession: "hmh" }),
      ctx,
    );
    const plan = res.data as { hostWindowsSeen: number; planned: Array<{ sessionId: string }> };
    // Two of three — the etl window is out of scope, so four families can be
    // adopted under four team stamps.
    expect(plan.hostWindowsSeen).toBe(2);
    expect(plan.planned).toHaveLength(2);
  });

  it("a /regex/ filter works for families that share a prefix", async () => {
    const { handlers, ctx } = await fixture();
    const res = await handlers.dispatch(
      makeRequest("team_adopt", { team: "x", hostSession: "/^(hmh|etl)$/" }),
      ctx,
    );
    expect((res.data as { hostWindowsSeen: number }).hostWindowsSeen).toBe(3);
  });
});

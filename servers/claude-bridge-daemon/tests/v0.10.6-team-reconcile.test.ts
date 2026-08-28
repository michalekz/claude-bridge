import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHostTarget } from "../src/hosts/driver.ts";
import { makePeer } from "./peer-fixture.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * team_reconcile — measure the gap between what the daemon believes and what
 * is running, and say it out loud.
 *
 * Every defect in this release was a claim nobody checked against the world.
 * `state.json` is the same kind of claim at the layer above: `status: "live"`
 * is a belief about a pid, and it goes stale the moment a process dies without
 * telling anyone. Nothing was watching that gap.
 */

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
});

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-rec") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-04T18:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

function record(sessionId: string, name: string, pid: number | null, target: string | null) {
  return makePeer(
    sessionId,
    { team: "hmh" },
    {
      name,
      tmuxTarget: target === null ? null : canonicalHostTarget(target),
      pid,
      startedAt: "2026-08-04T10:00:00.000Z",
      lastUpdatedAt: "2026-08-04T10:00:00.000Z",
    },
  );
}

describe("team_reconcile reports the gap between state and reality", () => {
  let procRoot: string;

  beforeEach(async () => {
    homeHolder.current = `/tmp/cbd-recon-${process.hrtime.bigint()}`;
    procRoot = await mkdtemp(join(tmpdir(), "cb-proc-"));
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(procRoot, { recursive: true, force: true });
  });

  /** A pid is "alive" iff /proc/<pid> exists — so a fixture directory is one. */
  async function alive(pid: number) {
    await mkdir(join(procRoot, String(pid)), { recursive: true });
  }

  async function fixture(
    opts: { windows?: Array<{ target: string; pid: number }>; peers?: unknown[] } = {},
  ) {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.10.6-test");
    const driver = new mock.MockDriver();
    driver.listSessions = async () => [];
    // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the optional driver method
    (driver as any).listWindows = async () =>
      (opts.windows ?? []).map((w) => ({
        target: w.target,
        label: `s:${w.target}`,
        session: "s",
        window: 1,
        windowName: "w",
        pid: w.pid,
      }));
    const inspector = {
      listClaudePeers: async () => (opts.peers ?? []) as never[],
      ancestorsOf: async () => [],
      readProcEnviron: async () => ({}) as Record<string, string>,
    };
    return {
      handlers,
      doc,
      ctx: {
        state: doc,
        hostDriver: driver,
        daemonVersion: "0.10.6-test",
        processInspector: inspector,
        procRoot,
      },
    };
  }

  it("a state that matches the host reports no drift", async () => {
    await alive(1001);
    const { handlers, doc, ctx } = await fixture({ windows: [{ target: "@1", pid: 1001 }] });
    doc.peers["a"] = record("a", "plt-a", 1001, "@1");

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    const rep = res.data as { driftCount: number; inSync: number; readOnly: boolean };
    expect(rep.driftCount).toBe(0);
    expect(rep.inSync).toBe(1);
    expect(rep.readOnly).toBe(true);
  });

  it("DEAD: a record says live, the process is gone", async () => {
    const { handlers, doc, ctx } = await fixture({ windows: [{ target: "@1", pid: 1001 }] });
    doc.peers["a"] = record("a", "plt-a", 1001, "@1"); // no /proc/1001

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    const rep = res.data as { drift: Array<{ kind: string; detail: string }> };
    expect(rep.drift).toHaveLength(1);
    expect(rep.drift[0]?.kind).toBe("dead");
    expect(rep.drift[0]?.detail).toContain("pid 1001 is not running");
  });

  it("PID_CHANGED: the target holds someone else — the dangerous one", async () => {
    await alive(1001);
    await alive(2002);
    const { handlers, doc, ctx } = await fixture({ windows: [{ target: "@1", pid: 2002 }] });
    doc.peers["a"] = record("a", "plt-a", 1001, "@1");

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    const rep = res.data as { drift: Array<{ kind: string; actualPid: number | null }> };
    // Every lifecycle call on this record would have reached pid 2002.
    expect(rep.drift[0]?.kind).toBe("pid_changed");
    expect(rep.drift[0]?.actualPid).toBe(2002);
  });

  it("THE FALSE ALARM: a pane holding a SHELL that owns the peer is not drift", async () => {
    await alive(1001);
    await alive(2002);
    // The pane pid is a shell (2002); the peer (1001) is its child. That is how
    // every launcher-script peer looks, and reconcile called all of them
    // `pid_changed` — accusing the host of holding a stranger when the peer was
    // exactly where it belonged (plt-designer, recovery round).
    const { handlers, doc, ctx } = await fixture({ windows: [{ target: "@1", pid: 2002 }] });
    doc.peers["a"] = record("a", "plt-a", 1001, "@1");
    // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the fake inspector
    (ctx as any).processInspector.ancestorsOf = async (pid: number) =>
      pid === 1001 ? [2002, 1] : [];

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    expect((res.data as { driftCount: number }).driftCount).toBe(0);
  });

  it("a pane holding an UNRELATED process still is", async () => {
    await alive(1001);
    await alive(3003);
    const { handlers, doc, ctx } = await fixture({ windows: [{ target: "@1", pid: 3003 }] });
    doc.peers["a"] = record("a", "plt-a", 1001, "@1");
    // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the fake inspector
    (ctx as any).processInspector.ancestorsOf = async () => [1];

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    const drift = (res.data as { drift: Array<{ kind: string }> }).drift;
    // Suppressing the false alarm must not suppress the real one.
    expect(drift[0]?.kind).toBe("pid_changed");
  });

  it("HOST_MISSING: the process lives on, its window does not", async () => {
    await alive(1001);
    const { handlers, doc, ctx } = await fixture({ windows: [{ target: "@9", pid: 9009 }] });
    doc.peers["a"] = record("a", "plt-a", 1001, "@1");

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    const rep = res.data as { drift: Array<{ kind: string }> };
    expect(rep.drift.some((d) => d.kind === "host_missing")).toBe(true);
  });

  it("UNMANAGED: a peer runs on the host with no record at all", async () => {
    const { handlers, ctx } = await fixture({
      peers: [
        {
          pid: 7777,
          ppid: 1,
          handle: "zzz",
          sessionIdSource: "sessions-json",
          cmdline: "claude",
          argv: ["claude"],
          cwd: "/x",
        },
      ],
    });

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    const rep = res.data as { drift: Array<{ kind: string; actualPid: number | null }> };
    expect(rep.drift[0]?.kind).toBe("unmanaged");
    expect(rep.drift[0]?.actualPid).toBe(7777);
  });

  it("a deliberately stopped peer is state, not drift", async () => {
    const { handlers, doc, ctx } = await fixture();
    const rec = record("a", "plt-a", null, "@1");
    doc.peers["a"] = { ...rec, observed: { ...rec.observed, status: "stopped" } };

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    expect((res.data as { driftCount: number }).driftCount).toBe(0);
  });

  it("READ-ONLY by default: a dead record is reported, not touched", async () => {
    const { handlers, doc, ctx } = await fixture();
    doc.peers["a"] = record("a", "plt-a", 1001, "@1");

    await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    // Still claims to be live — reconcile diagnoses, it does not repair.
    expect(doc.peers["a"]?.observed.status).toBe("live");
  });

  it("markDead sets 'unknown', never 'stopped', and never removes", async () => {
    const { handlers, doc, ctx } = await fixture();
    doc.peers["a"] = record("a", "plt-a", 1001, "@1");

    const res = await handlers.dispatch(makeRequest("team_reconcile", { markDead: true }), ctx);
    // Nobody asked this peer to stop; it simply is not there. Calling that a
    // clean stop would be inventing the reason.
    expect(doc.peers["a"]?.observed.status).toBe("unknown");
    expect(doc.peers["a"]).toBeDefined();
    expect((res.data as { marked: string[] }).marked).toEqual(["a"]);
    expect((res.data as { readOnly: boolean }).readOnly).toBe(false);
  });

  it("drift is logged at warn — a clean report is not", async () => {
    const { handlers, doc, ctx } = await fixture();
    doc.peers["a"] = record("a", "plt-a", 1001, "@1");
    await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);

    const raw = await readFile(
      join(homeHolder.current, ".claude-bridge", "control", "events.jsonl"),
      "utf-8",
    );
    const ev = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; level: string })
      .find((e) => e.event === "team_reconciled");
    // A state file that disagrees with the host is the precondition for every
    // confident lie the lifecycle tools can tell. It belongs above info.
    expect(ev?.level).toBe("warn");
  });
});

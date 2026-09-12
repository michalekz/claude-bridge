import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Nález Ⓥ (mic-admin, 10. 9., měřeno na živé flotile): bg-spare session pod
 * systemd — druhá živá relace se jménem mic-marketing — prošla comm-filtrem
 * `listClaudePeers` a reconcile řekl driftCount 0. Druhý enumerační zdroj je
 * CC vlastní registr session; tenhle soubor dokazuje, že reconcile procesy
 * z registru VIDÍ, že jmenný nárok POJMENUJE, a že nikoho nepočítá dvakrát.
 */

import { canonicalHostTarget } from "../src/hosts/driver.ts";
import { makePeer } from "./peer-fixture.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
});

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-v48") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-09-12T08:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

function record(sessionId: string, name: string, pid: number | null, target: string | null) {
  return makePeer(
    sessionId,
    { team: "mic" },
    {
      name,
      tmuxTarget: target === null ? null : canonicalHostTarget(target),
      pid,
      startedAt: "2026-09-12T07:00:00.000Z",
      lastUpdatedAt: "2026-09-12T07:00:00.000Z",
    },
  );
}

describe("v0.11.48 — the second enumeration source (Ⓥ)", () => {
  let procRoot: string;

  beforeEach(async () => {
    homeHolder.current = `/tmp/cbd-v48-${process.hrtime.bigint()}`;
    procRoot = await mkdtemp(join(tmpdir(), "cb-proc-"));
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(procRoot, { recursive: true, force: true });
    await rm(homeHolder.current, { recursive: true, force: true });
  });

  async function alive(pid: number) {
    await mkdir(join(procRoot, String(pid)), { recursive: true });
  }

  async function fixture(opts: {
    windows?: Array<{ target: string; pid: number }>;
    peers?: unknown[];
    registered?: Array<{
      pid: number;
      sessionId: string;
      name: string | null;
      kind: string | null;
    }>;
  }) {
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.11.48-test");
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
      listRegisteredSessions: async () => opts.registered ?? [],
    };
    return {
      handlers,
      doc,
      ctx: {
        state: doc,
        hostDriver: driver,
        daemonVersion: "0.11.48-test",
        processInspector: inspector,
        procRoot,
      },
    };
  }

  it("a live registered session invisible to the comm walk is UNMANAGED, with the name-claim named", async () => {
    await alive(1001);
    await alive(1116299);
    const { handlers, doc, ctx } = await fixture({
      windows: [{ target: "@1", pid: 1001 }],
      peers: [],
      registered: [
        {
          pid: 1116299,
          sessionId: "0099013a-1111-2222-3333-444444444444",
          name: "mic-marketing",
          kind: "bg",
        },
      ],
    });
    doc.peers["e4e34f16-aaaa-bbbb-cccc-dddddddddddd"] = record(
      "e4e34f16-aaaa-bbbb-cccc-dddddddddddd",
      "mic-marketing",
      1001,
      "@1",
    );

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    const rep = res.data as {
      drift: Array<{ kind: string; detail: string; actualPid: number | null }>;
      registeredSessionsSeen: number;
    };
    expect(rep.registeredSessionsSeen).toBe(1);
    const row = rep.drift.find((d) => d.actualPid === 1116299);
    expect(row?.kind).toBe("unmanaged");
    expect(row?.detail).toContain("CC's own registry");
    expect(row?.detail).toContain("CLAIMS the name 'mic-marketing'");
    expect(row?.detail).toContain("e4e34f16");
  });

  it("an anonymous subagent is a parent's tool, not drift — but an ADDRESSABLE one flags", async () => {
    await alive(3003);
    await alive(4004);
    const { handlers, doc, ctx } = await fixture({
      windows: [],
      peers: [],
      registered: [
        // anonymní subagent: kind agent, žádné jméno, žádný status soubor
        { pid: 3003, sessionId: "aaaa3003-1111-2222-3333-444444444444", name: null, kind: "agent" },
        // adresovatelný bg: vlastní bridge status soubor = vlastní schránka
        { pid: 4004, sessionId: "bbbb4004-1111-2222-3333-444444444444", name: null, kind: "bg" },
      ],
    });
    const statusDir = join(homeHolder.current, ".claude-bridge", "status");
    await mkdir(statusDir, { recursive: true });
    await writeFile(
      join(statusDir, "bbbb4004-1111-2222-3333-444444444444.json"),
      JSON.stringify({ id: "bbbb4004-1111-2222-3333-444444444444", name: "x" }),
    );

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    const rep = res.data as { drift: Array<{ kind: string; actualPid: number | null }> };
    expect(rep.drift.filter((d) => d.actualPid === 3003)).toHaveLength(0);
    expect(rep.drift.filter((d) => d.actualPid === 4004)).toHaveLength(1);
  });

  it("a session both walks see is reported ONCE, and a known one not at all", async () => {
    await alive(1001);
    await alive(2002);
    const { handlers, doc, ctx } = await fixture({
      windows: [{ target: "@1", pid: 1001 }],
      peers: [
        {
          pid: 2002,
          ppid: 1,
          sessionId: "unknown-9999-2222-3333-444444444444",
          sessionIdSource: "sessions-json",
          cmdline: "claude",
        },
        {
          pid: 1001,
          ppid: 1,
          sessionId: "known-sid-2222-3333-444444444444aaaa",
          sessionIdSource: "sessions-json",
          cmdline: "claude",
        },
      ],
      registered: [
        {
          pid: 2002,
          sessionId: "unknown-9999-2222-3333-444444444444",
          name: null,
          kind: "interactive",
        },
        {
          pid: 1001,
          sessionId: "known-sid-2222-3333-444444444444aaaa",
          name: "plt-a",
          kind: "interactive",
        },
      ],
    });
    const rec = record("a", "plt-a", 1001, "@1");
    (rec.observed as { sessionId?: string }).sessionId = "known-sid-2222-3333-444444444444aaaa";
    doc.peers["a"] = rec;

    const res = await handlers.dispatch(makeRequest("team_reconcile", {}), ctx);
    const rep = res.data as { drift: Array<{ kind: string; actualPid: number | null }> };
    const rows2002 = rep.drift.filter((d) => d.actualPid === 2002);
    expect(rows2002).toHaveLength(1); // both walks saw it; one row
    expect(rep.drift.filter((d) => d.actualPid === 1001)).toHaveLength(0); // known = not drift
  });
});

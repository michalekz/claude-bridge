/**
 * v0.11.34 — specifikace týmu je domov `args` i pro peery, kteří UŽ běží.
 *
 * Do teď se reconcile živého záznamu nedotkl: spawnoval chybějící a resumoval
 * uspané. Peer, který ve stavu byl, si nesl `spawnArgs` z adopce navěky.
 * Změřeno na `mic-bitrix-dev` 27. 8.: jeho `--mcp-config` (primární MCP
 * server) nebyl v záznamu ANI na živém procesu, takže ho nešlo získat ani
 * novou adopcí — jediná cesta zpět bylo ruční přeložení peera.
 *
 * GO ai-velitele se čtyřmi pojistkami; každá z nich má níž svůj test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePeer } from "./peer-fixture.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

const HANDLE = "mic-bitrix-dev";
const MCP = "--mcp-config";
const MCP_PATH = "/opt/micronic/mcp/bitrix24.json";
const BASE = ["--dangerously-skip-permissions", "--channels", "plugin:x@y"];

let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-layout-"));
  homeHolder.current = home;
  vi.resetModules();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function fleet(recordArgs: string[], opts: { command?: string; cwd?: string } = {}) {
  const { emptyState } = await import("../src/state.ts");
  const doc = emptyState("0.11.34-test");
  doc.peers[HANDLE] = makePeer(
    HANDLE,
    {
      team: "mic",
      cwd: opts.cwd ?? "/opt/micronic",
      command: opts.command ?? "/bin/claude",
      spawnArgs: recordArgs,
    },
    { name: HANDLE, status: "live", pid: 4242 },
  );
  return doc;
}

function inline(args: string[], over: Record<string, unknown> = {}) {
  return {
    team: "mic",
    peers: [
      {
        handle: HANDLE,
        displayName: HANDLE,
        cwd: "/opt/micronic",
        command: "/bin/claude",
        args,
        ...over,
      },
    ],
  };
}

async function layout(doc: unknown, spec: unknown, apply: boolean) {
  const { dispatch } = await import("../src/handlers/index.ts");
  return dispatch(
    {
      schemaVersion: 1 as const,
      id: `req-${apply ? "apply" : "plan"}`,
      ts: "2026-08-27T19:00:00.000Z",
      tool: "team_layout",
      args: { team: "mic", inline: spec, apply },
      requestedBy: { sessionId: "operator", name: "operator" },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal handler context
    { state: doc, hostDriver: { name: "mock" }, daemonVersion: "0.11.34-test" } as any,
  );
}

describe("args běžícího peera se dají deklarovat ze specifikace", () => {
  it("🔴 REPRODUKCE: chybějící --mcp-config se doplní do desired.spawnArgs", async () => {
    const doc = await fleet(BASE);
    const spec = inline([...BASE, MCP, MCP_PATH]);

    const res = await layout(doc, spec, true);
    expect(res.outcome).toBe("ok");

    const rec = (doc as { peers: Record<string, { desired: { spawnArgs: string[] } }> }).peers[
      HANDLE
    ];
    expect(rec?.desired.spawnArgs).toEqual([...BASE, MCP, MCP_PATH]);

    const data = res.data as { redeclared: Array<{ handle: string; was: string[]; will: string[] }> };
    expect(data.redeclared).toHaveLength(1);
    expect(data.redeclared[0]?.was).toEqual(BASE);
    expect(data.redeclared[0]?.will).toContain(MCP_PATH);
  });

  it("pojistka ③: odpověď říká, že ZÁPIS NENÍ ÚČINEK", async () => {
    // Lekce z `switch`, kde věta „platí od dalšího požadavku" musela být
    // opravena na TŘECH místech, protože každé z nich tvrdilo něco jiného.
    const doc = await fleet(BASE);
    const res = await layout(doc, inline([...BASE, MCP, MCP_PATH]), true);
    const note = (res.data as { redeclareNote?: string }).redeclareNote ?? "";
    expect(note).toContain("PŘÍŠTÍHO RESTARTU");
    expect(note.toLowerCase()).toContain("zápis není účinek");
  });

  it("pojistka ②: dryRun jmenuje každý změněný záznam a NIC nezapíše", async () => {
    const doc = await fleet(BASE);
    const res = await layout(doc, inline([...BASE, MCP, MCP_PATH]), false);

    const diff = (res.data as { diff: { plannedRedeclare: Array<{ handle: string }> } }).diff;
    expect(diff.plannedRedeclare).toHaveLength(1);
    expect(diff.plannedRedeclare[0]?.handle).toBe(HANDLE);
    // A záznam zůstal netknutý — plán je plán.
    const rec = (doc as { peers: Record<string, { desired: { spawnArgs: string[] } }> }).peers[
      HANDLE
    ];
    expect(rec?.desired.spawnArgs).toEqual(BASE);
  });

  it("🔴 PRÁZDNÝ SEZNAM = NEDEKLAROVÁNO, ne „žádné argumenty\"", async () => {
    // `args` má ve schématu `.default([])`, takže KAŽDÁ dnešní specifikace,
    // která args neuvádí, jich nese nula. Bez téhle podmínky by první `apply`
    // vymazal spawnArgs celé flotile — a peer bez `--channels` už nedostane
    // budíček, což by se poznalo až tím, že přestanou chodit zprávy.
    const doc = await fleet(BASE);
    const spec = { team: "mic", peers: [{ handle: HANDLE, displayName: HANDLE, cwd: "/opt/micronic", command: "/bin/claude" }] };

    const res = await layout(doc, spec, true);
    const rec = (doc as { peers: Record<string, { desired: { spawnArgs: string[] } }> }).peers[
      HANDLE
    ];
    expect(rec?.desired.spawnArgs).toEqual(BASE);
    expect((res.data as { redeclared: unknown[] }).redeclared).toHaveLength(0);
  });

  it("pojistka ①: command a cwd se HLÁSÍ, nikdy nepřepisují", async () => {
    // Ty dvě jsou přesně to, čeho se bojí poznámka u `control_config`:
    // špatná hodnota = peer, který se už nespustí.
    const doc = await fleet(BASE, { command: "/bin/claude", cwd: "/opt/micronic" });
    const spec = inline([...BASE, MCP, MCP_PATH], {
      command: "/jiny/claude",
      cwd: "/jiny/adresar",
    });

    const res = await layout(doc, spec, true);
    const rec = (doc as {
      peers: Record<string, { desired: { command: string; cwd: string; spawnArgs: string[] } }>;
    }).peers[HANDLE];

    expect(rec?.desired.command).toBe("/bin/claude");
    expect(rec?.desired.cwd).toBe("/opt/micronic");
    // Ale args projít MĚLY — jedno pole se nezastavuje kvůli druhému.
    expect(rec?.desired.spawnArgs).toContain(MCP_PATH);

    const data = res.data as {
      launchConflicts: Array<{ field: string; record: string; spec: string }>;
      conflictNote: string;
    };
    expect(data.launchConflicts.map((c) => c.field).sort()).toEqual(["command", "cwd"]);
    expect(data.conflictNote).toContain("NEPŘEPISUJÍ");
  });

  it("shodné args nic nezapisují — plán nesmí hlásit práci, která není", async () => {
    const doc = await fleet([...BASE, MCP, MCP_PATH]);
    const res = await layout(doc, inline([...BASE, MCP, MCP_PATH]), false);
    const diff = (res.data as { diff: { plannedRedeclare: unknown[] } }).diff;
    expect(diff.plannedRedeclare).toHaveLength(0);
  });
});

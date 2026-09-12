/**
 * Ⓞ-A (v0.11.49; incident 9. 9.): token-autentizovaný peer se z restartu
 * vracel BEZ `CLAUDE_CODE_OAUTH_TOKEN` — harvest tu proměnnou z principu
 * stripuje, takže uložené prostředí ji nemá jak nést. Projev: „náhodná
 * porucha MCP" u relaunchnutého peera.
 *
 * Táž lekce jako v0.11.35: otevřít bránu (whitelist) nestačí, akci musí
 * někdo vykonat — a důkaz se ptá PROCESU (`printenv`), ne datové struktury.
 * Uložený spawnEnv token PRINCIPIÁLNĚ nemá, takže hodnota po restartu může
 * přijít jedině přenosem z živého /proc environ zastavovaného procesu.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

let home = "";
const SECRET = "sk-test-carry-me-0001";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-tok-"));
  homeHolder.current = home;
  vi.resetModules();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function req(id: string, tool: string, args: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-09-12T07:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

describe("Ⓞ-A: token přežije restart — a jde pamětí, ne stavem", () => {
  it("spawn s extraEnv tokenem projde branou; restart ho PŘENESE z živého environ", async () => {
    const { dispatch } = await import("../src/handlers/index.ts");
    const { emptyState } = await import("../src/state.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");

    const out = join(home, "videno.txt");
    const doc = emptyState("0.11.49-test");
    const driver = new MockDriver();
    const ctx = { state: doc, hostDriver: driver, daemonVersion: "0.11.49-test" };

    // ① SPAWN: brána whitelistu — token dorazí do procesu.
    const spawn = await dispatch(
      req("req-tok-spawn", "peer_spawn", {
        handle: "tok-test",
        displayName: "tok-test",
        cwd: home,
        command: "/bin/sh",
        args: ["-c", `printenv CLAUDE_CODE_OAUTH_TOKEN > ${out}; exec sleep 30`],
        extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: SECRET },
      }),
      ctx,
    );
    expect(spawn.outcome).toBe("ok");
    await new Promise((r) => setTimeout(r, 400));
    expect((await readFile(out, "utf-8")).trim()).toBe(SECRET);

    // Uložený harvest token NEMÁ — to je celý důvod, proč přenos existuje.
    const stored = doc.peers["tok-test"]?.observed.spawnEnv ?? {};
    expect(stored["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();

    // ② RESTART (force — sh nemá jak ackovat): hodnota po relaunchi může
    // přijít JEDINĚ přenosem z živého /proc environ.
    const restart = await dispatch(
      req("req-tok-restart", "peer_restart", { peer: "tok-test", force: true }),
      ctx,
    );
    expect(restart.outcome).toBe("ok");
    await new Promise((r) => setTimeout(r, 500));
    expect((await readFile(out, "utf-8")).trim()).toBe(SECRET);

    // ③ Event nese PŘÍTOMNOST, nikdy hodnotu — a events.jsonl ji nesmí
    // obsahovat nikde.
    const events = await readFile(join(home, ".claude-bridge", "control", "events.jsonl"), "utf-8");
    expect(events).toContain("peer_restart_token_carried");
    expect(events).not.toContain(SECRET);
  });

  it("peer bez tokenu: žádný přenos, žádný event — pojistka hlídá doloženou ztrátu, ne domněnku", async () => {
    const { dispatch } = await import("../src/handlers/index.ts");
    const { emptyState } = await import("../src/state.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");

    const doc = emptyState("0.11.49-test");
    const ctx = { state: doc, hostDriver: new MockDriver(), daemonVersion: "0.11.49-test" };
    const spawn = await dispatch(
      req("req-plain-spawn", "peer_spawn", {
        handle: "plain-test",
        displayName: "plain-test",
        cwd: home,
        command: "/bin/sh",
        args: ["-c", "exec sleep 30"],
      }),
      ctx,
    );
    expect(spawn.outcome).toBe("ok");
    await new Promise((r) => setTimeout(r, 300));
    const restart = await dispatch(
      req("req-plain-restart", "peer_restart", { peer: "plain-test", force: true }),
      ctx,
    );
    expect(restart.outcome).toBe("ok");
    const events = await readFile(join(home, ".claude-bridge", "control", "events.jsonl"), "utf-8");
    expect(events).not.toContain("peer_restart_token_carried");
  });
});

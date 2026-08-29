import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePeerIdentity } from "../../src/identity.ts";
import { createPeerRegistry } from "../../src/registry/peers.ts";

/**
 * v0.11.39 — peer a jeho agent na pozadí sdílejí JMÉNO.
 *
 * MĚŘENO 29. 8. na živé flotile (25x `interactive`, 4x `bg`):
 *
 *   sessions/2337683.json  kind interactive  name mic-bitrix-dev  jobId —
 *   sessions/2361805.json  kind bg           name mic-bitrix-dev  jobId 3cb1a054
 *
 * Claude Code zapíše agentovi na pozadí JMÉNO JEHO RODIČE. Každá session
 * přitom píše VLASTNÍ status soubor s vlastním pidem — nikdo nikoho
 * nepřepisuje. Čtenář klíčovaný podle jména ale uvidí jedno jméno se dvěma
 * pidy a přečte to jako „cizí proces přepsal heartbeat" (tak to 29. 8.
 * přečetl hlídač doručování i autor tohohle testu, dokud neotevřeli
 * sessions soubor).
 *
 * Rozlišovač tedy nepatří k pidu, patří ke JMÉNU — a leží na disku už dnes.
 */

async function sessionFile(dir: string, pid: number, extra: Record<string, unknown>) {
  await mkdir(join(dir, ".claude", "sessions"), { recursive: true });
  await writeFile(
    join(dir, ".claude", "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId: "11111111-2222-3333-4444-555555555555", ...extra }),
    "utf-8",
  );
}

describe("kind rozlišuje peera od jeho agenta na pozadí", () => {
  it("bg session nese kind i jobId", async () => {
    const home = await mkdtemp(join(tmpdir(), "cb-kind-"));
    await sessionFile(home, 4242, {
      cwd: "/opt/micronic",
      name: "mic-bitrix-dev",
      kind: "bg",
      jobId: "3cb1a054",
    });
    const id = await resolvePeerIdentity({
      ppid: 4242,
      home,
      cwd: "/opt/micronic",
      env: {},
      skipTitleScan: true,
      resumedSessionId: null,
    });
    expect(id.kind).toBe("bg");
    expect(id.jobId).toBe("3cb1a054");
    // Jméno je TOTOŽNÉ s rodičem — to je ta věc, kterou samo o sobě rozlišit nejde.
    expect(id.name).toBe("mic-bitrix-dev");
  });

  it("interaktivní session nese kind bez jobId", async () => {
    const home = await mkdtemp(join(tmpdir(), "cb-kind-"));
    await sessionFile(home, 4243, {
      cwd: "/opt/micronic",
      name: "mic-bitrix-dev",
      kind: "interactive",
    });
    const id = await resolvePeerIdentity({
      ppid: 4243,
      home,
      cwd: "/opt/micronic",
      env: {},
      skipTitleScan: true,
      resumedSessionId: null,
    });
    expect(id.kind).toBe("interactive");
    expect(id.jobId).toBeUndefined();
  });

  it("chybějící kind ZŮSTÁVÁ chybějící — nedosazuje se interactive", async () => {
    // TŘI STAVY. Starší Claude Code (nebo soubor bez toho pole) nesmí být
    // k nerozeznání od změřené interaktivní session: dosadit tu hodnotu by
    // z neznalosti udělalo výrok a agenta na pozadí by to zase schovalo.
    const home = await mkdtemp(join(tmpdir(), "cb-kind-"));
    await sessionFile(home, 4244, { cwd: "/opt/micronic", name: "mic-bitrix-dev" });
    const id = await resolvePeerIdentity({
      ppid: 4244,
      home,
      cwd: "/opt/micronic",
      env: {},
      skipTitleScan: true,
      resumedSessionId: null,
    });
    expect(id.kind).toBeUndefined();
    expect("kind" in id).toBe(false);
  });

  it("kind i jobId dojedou až do status souboru, který čtou ostatní", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "cb-hb-"));
    const registry = createPeerRegistry({ baseDir, intervalMs: 60_000 });
    const handle = await registry.startHeartbeat({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "mic-bitrix-dev",
      pid: 2361805,
      kind: "bg",
      jobId: "3cb1a054",
    });
    const raw = await readFile(
      join(baseDir, "status", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json"),
      "utf-8",
    );
    await handle.stop();
    const written = JSON.parse(raw);
    expect(written.kind).toBe("bg");
    expect(written.jobId).toBe("3cb1a054");
  });
});

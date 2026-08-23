import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolvePeerIdentity } from "../../src/identity.ts";

/**
 * 🔴 Registrace u mostu je mechanismus, na kterém visí adresovatelnost celé
 * flotily. `plt-velitel` (275 MB transkript) se 22. 8. 2026 při přepojení
 * nezaregistroval a deset hodin byl nedosažitelný — zjistilo se to teprve
 * ve chvíli, kdy mu někdo chtěl doručit poplach.
 *
 * Změřeno: sken titulku je lineární ve velikosti (8,6 ms/MB), 2,49 s
 * u 275 MB proti 0,16 s u malé session, a běžel PŘED zápisem statusu.
 */
describe("líná registrace: jméno se nesmí plést do cesty adresovatelnosti", () => {
  let home: string;
  const SID = "11111111-2222-3333-4444-555555555555";
  const CWD = "/opt/hmh";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "lazyreg-"));
    await mkdir(join(home, ".claude", "sessions"), { recursive: true });
    await mkdir(join(home, ".claude", "projects", "-opt-hmh"), { recursive: true });
    await writeFile(
      join(home, ".claude", "sessions", "4242.json"),
      JSON.stringify({ sessionId: SID, cwd: CWD }),
    );
    await writeFile(
      join(home, ".claude", "projects", "-opt-hmh", `${SID}.jsonl`),
      `${JSON.stringify({ type: "ai-title", aiTitle: "plt-velitel" })}\n`,
    );
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const opts = () => ({
    ppid: 4242,
    cwd: CWD,
    home,
    env: {} as NodeJS.ProcessEnv,
    resumedSessionId: null,
  });

  test("bez příznaku se titulek z transkriptu ČTE (pozitivní kontrola)", async () => {
    const id = await resolvePeerIdentity(opts());
    expect(id.source).toBe("jsonl-title");
    expect(id.name).toBe("plt-velitel");
  });

  test("se skipTitleScan se transkript NEOTEVŘE a identita přesto vznikne", async () => {
    const id = await resolvePeerIdentity({ ...opts(), skipTitleScan: true });
    // id musí být totožné — líná cesta nesmí měnit, KDO peer je
    expect(id.id).toBe(SID);
    expect(id.source).not.toBe("jsonl-title");
    expect(id.name).toBeTruthy(); // pod nějakým jménem být musí, jinak není v registru
  });

  test("líná cesta dá TÝŽ výsledek jako plná, jen bez titulku", async () => {
    const full = await resolvePeerIdentity(opts());
    const lazy = await resolvePeerIdentity({ ...opts(), skipTitleScan: true });
    expect(lazy.id).toBe(full.id); // adresa je táž
    expect(lazy.name).not.toBe(full.name); // popisek se doplní až potom
  });

  // Prázdný nebo chybějící titulek NESMÍ přepsat prozatímní jméno na horší.
  test("chybí-li titulek, líná i plná cesta se shodnou", async () => {
    await rm(join(home, ".claude", "projects", "-opt-hmh", `${SID}.jsonl`));
    const full = await resolvePeerIdentity(opts());
    const lazy = await resolvePeerIdentity({ ...opts(), skipTitleScan: true });
    expect(lazy.name).toBe(full.name);
    expect(full.source).not.toBe("jsonl-title");
  });
});

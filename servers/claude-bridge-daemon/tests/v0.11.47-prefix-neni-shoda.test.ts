import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { TmuxDriver } from "../src/hosts/tmux-driver.ts";

const execFileAsync = promisify(execFile);

/**
 * tmux dohledává cíl PREFIXEM — a démon se tak ptal.
 *
 * Naostro to našel velitel 2026-09-09 při přenosu mic týmu: spawn s
 * `inSession: "mic"` přistál v session `mic-admin`, protože session `mic`
 * neexistovala a tmux prefix dohledal. Pojistka „chybějící domov si sám
 * založím" se nespustila přesně proto, že se ptala prefixem.
 *
 * Test jede proti ŽIVÉMU tmuxu záměrně: chování, které se opravuje, je
 * chování tmuxu, ne naše. Podvržený tmux by ověřil jen to, že posíláme
 * řetězec, který jsme si sami vymysleli — přesně ta třída testu, která
 * v tomhle projektu už jednou prošla nad zavřenou branou.
 */
const haveTmux = await execFileAsync("tmux", ["-V"]).then(
  () => true,
  () => false,
);

/** Delší jméno, jehož PREFIXEM je jméno, na které se budeme ptát. */
const DECOY = "cbtest-prefix-decoy";
const ASKED = "cbtest-prefix";

async function tmux(args: string[]): Promise<void> {
  await execFileAsync("tmux", args).catch(() => undefined);
}
async function sessionExists(name: string): Promise<boolean> {
  return execFileAsync("tmux", ["has-session", "-t", `=${name}`]).then(
    () => true,
    () => false,
  );
}

afterAll(async () => {
  for (const s of [DECOY, ASKED]) await tmux(["kill-session", "-t", `=${s}`]);
});

describe.skipIf(!haveTmux)("prefix není shoda (živý tmux)", () => {
  it("hasSession('cbtest-prefix') je NEPRAVDA, když existuje jen 'cbtest-prefix-decoy'", async () => {
    await tmux(["kill-session", "-t", `=${ASKED}`]);
    await tmux(["new-session", "-d", "-s", DECOY]);
    // Pozitivní kontrola: bez ní by test prošel i tehdy, kdyby tmux vůbec neběžel.
    expect(await sessionExists(DECOY)).toBe(true);
    expect(await sessionExists(ASKED)).toBe(false);

    const driver = new TmuxDriver();
    // 🔴 Před opravou: TRUE — tmux dohledal `cbtest-prefix-decoy` prefixem.
    expect(await driver.hasSession(ASKED)).toBe(false);
  });

  it("spawn s inSession domov ZALOŽÍ, místo aby se svezl na cizí session", async () => {
    await tmux(["kill-session", "-t", `=${ASKED}`]);
    await tmux(["new-session", "-d", "-s", DECOY]);

    const driver = new TmuxDriver();
    const rec = await driver.spawn({
      sessionKey: "cbtest-prefix-peer",
      inSession: ASKED,
      cwd: process.cwd(),
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });

    // Domov musí VZNIKNOUT — to je ta pojistka, kterou prefix vyřadil.
    expect(await sessionExists(ASKED)).toBe(true);

    // A okno musí sedět v NĚM, ne v návnadě.
    const { stdout } = await execFileAsync("tmux", [
      "list-windows",
      "-a",
      "-F",
      "#{window_id} #{session_name}",
    ]);
    const line = stdout.split("\n").find((l) => l.startsWith(`${rec.sessionKey} `));
    expect(line, `okno ${rec.sessionKey} nenalezeno`).toBeDefined();
    expect(line?.split(" ")[1]).toBe(ASKED);
  });
});

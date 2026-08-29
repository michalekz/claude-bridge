import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { TmuxDriver } from "../src/hosts/tmux-driver.ts";
import { markProcess, markedProcessAlive, pidIsZombie, pidStartTicks } from "../src/pid.ts";

const execFileAsync = promisify(execFile);

/**
 * v0.11.40 — `stoppedCleanly` měřilo SOUHLAS, ne smrt.
 *
 * CO SE STALO 29. 8.: z 16 restartovaných peerů jeden přežil. Starý
 * plt-velitel běžel souběžně s novým nad JEDNÍM transkriptem — obojí
 * `--resume`, dvojí drain fronty — a stop přitom hlásil úspěch. Ta hodnota
 * nikdy netvrdila, že proces umřel: měří, že peer potvrdil ready-request,
 * tedy že dostal šanci uložit práci. **Jméno lhalo v místě použití.**
 *
 * A dohledat se to nedalo, protože `kill` vracel `void`: „zabito" a „nebylo
 * co zabít" vypadaly z volajícího místa stejně.
 *
 * Testy níž jsou REPRODUKCE na skutečném tmuxu, ne konstrukce nad daty —
 * obojí naměřeno téhož dne na vlastních testovacích oknech.
 */

const haveTmux = await execFileAsync("tmux", ["-V"]).then(
  () => true,
  () => false,
);

const SESSIONS = ["cb-kill-stale", "cb-kill-stale-2", "cb-kill-linked", "cb-kill-linked-2"];

async function makeWindow(session: string) {
  await execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => undefined);
  await execFileAsync("tmux", [
    "new-session",
    "-d",
    "-s",
    session,
    "-n",
    "peer",
    "sh",
    "-c",
    "sleep 300",
  ]);
  const target = (
    await execFileAsync("tmux", ["display-message", "-p", "-t", `${session}:peer`, "#{window_id}"])
  ).stdout.trim();
  const pid = Number(
    (
      await execFileAsync("tmux", ["display-message", "-p", "-t", `${session}:peer`, "#{pane_pid}"])
    ).stdout.trim(),
  );
  return { target, pid };
}

describe("kill říká, co udělal — ne jen že skončil", () => {
  afterAll(async () => {
    for (const s of SESSIONS) {
      await execFileAsync("tmux", ["kill-session", "-t", s]).catch(() => undefined);
    }
  });

  it.skipIf(!haveTmux)(
    "zastaralý cíl: nezabije NIC a řekne to",
    async () => {
      // Přesně tvar z 29. 8.: záznam držel id okna, které peerovi už nepatřilo.
      const { target } = await makeWindow("cb-kill-stale");
      await execFileAsync("tmux", ["kill-window", "-t", target]);
      // Peer mezitím žije jinde — jeho proces se stopu vůbec netýká.
      const elsewhere = await makeWindow("cb-kill-stale-2");

      const outcome = await new TmuxDriver({}).kill(target);

      expect(outcome).toBe("target-missing");
      expect(markedProcessAlive(markProcess(elsewhere.pid))).toBe(true);
    },
    20_000,
  );

  it.skipIf(!haveTmux)(
    "nalinkované okno: ODLINKUJE a proces BĚŽÍ DÁL",
    async () => {
      // Vlastní vědomý kód: okno patřící i druhé session se odlinkuje místo
      // zabití, aby kill-window nesebral okno té druhé. Ochrana je správná —
      // vydávat ji za provedený stop správné není. A tenhle režim nepotřebuje
      // ani zastaralý záznam: stačí, že si někdo okno nalinkoval.
      const { target, pid } = await makeWindow("cb-kill-linked");
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        "cb-kill-linked-2",
        "sh",
        "-c",
        "sleep 300",
      ]);
      await execFileAsync("tmux", ["link-window", "-s", target, "-t", "cb-kill-linked-2:"]);

      const outcome = await new TmuxDriver({}).kill(target);
      await new Promise((r) => setTimeout(r, 400));

      expect(outcome).toBe("unlinked-not-killed");
      expect(markedProcessAlive(markProcess(pid))).toBe(true);
    },
    20_000,
  );
});

describe("pid je adresa, čas startu je totožnost", () => {
  it("recyklovaný pid se počítá za MRTVÝ", async () => {
    // Moje vlastní úvaha „vyšší pid ⇒ mladší proces" byla 29. 8. vyvrácena
    // měřením `lstart`; pidy se recyklují. Značka proto nese čas startu a
    // proces s jiným časem startu NENÍ ten, kterého jsme si poznamenali.
    const mark = markProcess(process.pid);
    expect(markedProcessAlive(mark)).toBe(true);
    const recycled = {
      pid: process.pid,
      startTicks: (mark.startTicks ?? 0) + 1,
    };
    expect(markedProcessAlive(recycled)).toBe(false);
  });

  it("zombie je pro tuhle otázku MRTVÝ — a měří se to na přípravku, ne na náhodě", async () => {
    // 🔴 PRVNÍ VERZE TOHOHLE TESTU NEMOHLA SPADNOUT: spouštěla `/bin/true`
    // a doufala, že ho stihne vidět jako zombie dřív, než ho Node sklidí —
    // a obě větve `if` tvrdily totéž. Mutace „zombie počítej za živého" přes
    // něj prošla zeleně. Test, který si podmínku neumí vyrobit, měří svoji
    // konfiguraci, ne kód.
    //
    // Zombie MÁ adresář v procfs, takže pro `existsSync` vypadá živě. Starý
    // plt-velitel skončil 29. 8. přesně takhle (`Zs`, čekal na reap tmuxem),
    // a stav, který by ho počítal za živého, hlásí přeživšího peera tam, kde
    // se všechno povedlo.
    const root = await mkdtemp(join(tmpdir(), "cb-proc-"));
    // Jméno programu se schválně píše se závorkou a mezerou: `stat` se musí
    // parsovat AŽ ZA poslední závorkou, jinak se na takovém procesu rozpadne.
    const write = async (pid: number, state: string, startTicks: number) => {
      await mkdir(join(root, String(pid)), { recursive: true });
      const fields = [state, "1", "1", "0", "-1", "0", ...Array(13).fill("0"), String(startTicks)];
      await writeFile(join(root, String(pid), "stat"), `${pid} (sh (x)) ${fields.join(" ")}\n`);
    };

    await write(4242, "Z", 999); // zombie
    await write(4243, "S", 999); // spící, tedy živý

    expect(markedProcessAlive({ pid: 4242, startTicks: 999 }, root)).toBe(false);
    expect(markedProcessAlive({ pid: 4243, startTicks: 999 }, root)).toBe(true);
    expect(pidIsZombie(4242, root)).toBe(true);
    expect(pidStartTicks(4243, root)).toBe(999);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Je ten pid pořád naživu — a je to pořád TENTÝŽ proces?
 *
 * 🔴 PID SÁM O SOBĚ IDENTITU NENESE. Systém je recykluje, a 29. 8. na tom
 * stála moje chybná úvaha („vyšší pid ⇒ mladší proces"), kterou vyvrátil
 * ai-velitel měřením `lstart`. Táž past téhož dne zmátla mic-velitele
 * u předpřipravené session. Proto se tady vedle pidu vždycky nosí ČAS STARTU:
 * dvojice (pid, starttime) je identita, samotný pid je jen adresa.
 *
 * Čte se z procfs, ne přes `process.kill(pid, 0)`: signální sonda vrací EPERM
 * u procesů, na které nesmíme, a to by se četlo jako „je pryč" (převzato
 * z `team_reconcile`, kde tenhle argument vznikl).
 */
export function pidAlive(pid: number, procRoot = "/proc"): boolean {
  return existsSync(join(procRoot, String(pid)));
}

/**
 * Čas startu procesu v jednotkách jádra (pole 22 v `/proc/<pid>/stat`).
 *
 * Parsuje se AŽ ZA poslední závorkou: druhé pole je jméno programu v
 * závorkách a smí obsahovat mezery i závorky samo („(sh (x))"), takže dělení
 * podle mezer od začátku řádku je rozbité pro každý takový proces.
 *
 * `null` = nešlo přečíst. To NENÍ „proces neexistuje" — je to nevědomost,
 * a volající ji musí odlišit.
 */
function statFields(pid: number, procRoot: string): string[] | null {
  try {
    const raw = readFileSync(join(procRoot, String(pid), "stat"), "utf-8");
    // AŽ ZA poslední závorkou: druhé pole je jméno programu v závorkách a smí
    // obsahovat mezery i závorky samo („(sh (x))"), takže dělení podle mezer
    // od začátku řádku je rozbité pro každý takový proces.
    return raw
      .slice(raw.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
  } catch {
    return null;
  }
}

export function pidStartTicks(pid: number, procRoot = "/proc"): number | null {
  // Po jménu následuje pole 3 (state); starttime je pole 22 celkem,
  // tedy index 19 v tomhle zbytku.
  const ticks = Number.parseInt(statFields(pid, procRoot)?.[19] ?? "", 10);
  return Number.isNaN(ticks) ? null : ticks;
}

/**
 * Je to ZOMBIE — tedy proces, který už doběhl a čeká jen na to, až si ho
 * rodič vyzvedne?
 *
 * 🔴 Zombie MÁ svůj adresář v procfs, takže pro `existsSync` vypadá živě.
 * Pro otázku „umřel ten peer?" je ale mrtvý: nic nevykonává, nic nedrží,
 * jen zabírá pid do reapu. Starý plt-velitel skončil 29. 8. přesně takhle
 * (`Zs`, čekal na tmux server) a stav, který by ho počítal za živého, by
 * hlásil přeživšího peera tam, kde se všechno povedlo.
 */
export function pidIsZombie(pid: number, procRoot = "/proc"): boolean {
  return statFields(pid, procRoot)?.[0] === "Z";
}

/** Snímek identity procesu — pid je adresa, čas startu je totožnost. */
export interface ProcessMark {
  pid: number;
  startTicks: number | null;
}

export function markProcess(pid: number, procRoot = "/proc"): ProcessMark {
  return { pid, startTicks: pidStartTicks(pid, procRoot) };
}

/**
 * Žije PRÁVĚ TEN proces, který jsme si poznamenali?
 *
 * Recyklovaný pid (jiný čas startu) se počítá za MRTVÝ — původní proces
 * skončil a to je přesně otázka, na kterou se ptáme. Když čas startu neznáme
 * (starý záznam, nečitelné procfs), rozhoduje samotná existence pidu:
 * z nevědomosti se nesmí stát ujištění.
 */
export function markedProcessAlive(mark: ProcessMark, procRoot = "/proc"): boolean {
  if (!pidAlive(mark.pid, procRoot)) return false;
  if (pidIsZombie(mark.pid, procRoot)) return false;
  if (mark.startTicks === null) return true;
  const now = pidStartTicks(mark.pid, procRoot);
  if (now === null) return true;
  return now === mark.startTicks;
}

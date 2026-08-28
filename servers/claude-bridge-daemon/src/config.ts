import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, controlDir, makeLogger } from "@claude-bridge/shared";

/**
 * Daemon-side config file: `~/.claude-bridge/control/config.json`.
 *
 * Owner-writable knobs that shape opt-in behaviour — the safest
 * defaults live in code, this file only records the operator's choice
 * to enable something. Owner edits it directly (or via a future
 * `claude-bridge daemon config` CLI); the daemon reads it on demand.
 */

const log = makeLogger("daemon.config");

export interface CompactWatchdogConfig {
  /** Owner-gated: injects `/compact` via send-keys — charter §8. Default OFF. */
  enabled: boolean;
  warnAtPercent: number;
  criticalAtPercent: number;
}

/**
 * Kudy peeři chodí na Anthropic — flotilový výchozí stav.
 *
 * 🔴 TŘI STAVY, NE DVA. Chybějící klíč a `null` znamenají různé věci a
 * pletou se přesně tak, jak se 27. 8. pletl `args: []`:
 *
 *   klíč chybí   nikdo nerozhodl → spawn nic nenastaví, ale BRÁNA restartu
 *                odmítne, pokud by tím peer o proxy přišel
 *   řetězec      tuhle adresu dosadit každému, kdo neřekl jinak
 *   null         flotila jede ZÁMĚRNĚ napřímo → brána mlčí
 *
 * Výchozí hodnota v kódu je ZÁMĚRNĚ ŽÁDNÁ. Zadrátovaná `127.0.0.1:8402` by
 * byla správná pro tenhle stroj a rozbila by každou instalaci, která žádný
 * router identit nemá — a most se rozdává ven. Bezpečí nezajišťuje výchozí
 * hodnota, ale brána: nenastavená hodnota nic tiše neprovede, jen odmítne
 * restart, který by peera vyhodil z proxy.
 */
export interface SpawnConfig {
  anthropicBaseUrl?: string | null;
}

export interface DaemonConfig {
  compactWatchdog: CompactWatchdogConfig;
  spawn: SpawnConfig;
}

export const DEFAULT_CONFIG: Readonly<DaemonConfig> = Object.freeze({
  compactWatchdog: Object.freeze({
    enabled: false,
    warnAtPercent: 0.85,
    criticalAtPercent: 0.95,
  }),
  spawn: Object.freeze({}),
});

function configFilePath(): string {
  return join(controlDir(), "config.json");
}

export async function readConfig(): Promise<DaemonConfig> {
  try {
    const raw = await readFile(configFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DaemonConfig>;
    return {
      compactWatchdog: {
        ...DEFAULT_CONFIG.compactWatchdog,
        ...(parsed.compactWatchdog ?? {}),
      },
      // Rozprostření, ne `?? {}` na celém `spawn`: klíč, který v souboru
      // NENÍ, musí zůstat `undefined` — jinak by „nikdo nerozhodl" splynulo
      // s „rozhodnuto na null".
      spawn: { ...(parsed.spawn ?? {}) },
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return { compactWatchdog: { ...DEFAULT_CONFIG.compactWatchdog }, spawn: {} };
    log.warn("config_read_error", { err: String(e) });
    return { compactWatchdog: { ...DEFAULT_CONFIG.compactWatchdog }, spawn: {} };
  }
}

export async function writeConfig(config: DaemonConfig): Promise<void> {
  await atomicWriteJson(configFilePath(), config);
}

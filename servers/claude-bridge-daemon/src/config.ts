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

export interface DaemonConfig {
  compactWatchdog: CompactWatchdogConfig;
}

export const DEFAULT_CONFIG: Readonly<DaemonConfig> = Object.freeze({
  compactWatchdog: Object.freeze({
    enabled: false,
    warnAtPercent: 0.85,
    criticalAtPercent: 0.95,
  }),
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
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { compactWatchdog: { ...DEFAULT_CONFIG.compactWatchdog } };
    log.warn("config_read_error", { err: String(e) });
    return { compactWatchdog: { ...DEFAULT_CONFIG.compactWatchdog } };
  }
}

export async function writeConfig(config: DaemonConfig): Promise<void> {
  await atomicWriteJson(configFilePath(), config);
}

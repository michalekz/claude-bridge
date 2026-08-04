import { readFile } from "node:fs/promises";
import { atomicWriteJson, makeLogger, stateFilePath } from "@claude-bridge/shared";

/**
 * Daemon-authoritative state (single writer).
 *
 * `stateVersion` gates load-time migration. Reading a state written by a
 * newer daemon => refuse to start (no silent downgrade — see §7 of the
 * control-plane zadání).
 *
 * Alpha scope: minimal shape — peers dict + daemon metadata. Beta/rc will
 * extend with team declarations, telemetry cache pointers, etc.
 */

const log = makeLogger("daemon.state");

export const STATE_VERSION = 1;

export type PeerLifecycleStatus = "unknown" | "starting" | "live" | "stopping" | "stopped";
export type PeerHostDriver = "tmux" | "bg-pty" | "mock" | "unknown";

export interface PeerRecord {
  sessionId: string;
  name: string;
  hostDriver: PeerHostDriver;
  tmuxTarget: string | null;
  pid: number | null;
  status: PeerLifecycleStatus;
  /**
   * Set when status === "stopped" (v0.10.1 team_stop lifecycle):
   *   true  — peer acknowledged stop-request; kill succeeded cleanly
   *   false — peer did not ack; killed with force
   *   null  — peer was dead (kill-idempotent) or plain peer_stop keepInState:true without explicit outcome
   * undefined for peers that are live/starting/etc.
   */
  stoppedCleanly?: boolean | null;
  /** Team identifier from team_layout apply or team_adopt; undefined for ad-hoc peer_spawn. */
  team?: string;
  /**
   * True when the daemon took over a process it did not start (team_adopt).
   * Matters because `startedAt` is then the adoption time, not the boot time,
   * and because provenance is worth keeping when diagnosing identity problems.
   */
  adopted?: boolean;
  /**
   * Working directory the peer was launched in.
   *
   * Added 2026-08-04 because `peer_restart` had nowhere to read it from and
   * substituted `process.cwd()` — the DAEMON's directory. `claude --resume
   * <uuid>` cannot find a transcript that belongs to another project, so the
   * relaunched process exited immediately and tmux tore the session down.
   * Combined with the unmeasured `alive` flag in the driver, the tool then
   * reported a successful restart of a peer that was not running.
   *
   * Optional because records written before this release do not have it;
   * `peer_restart` warns and falls back rather than refusing to run.
   */
  cwd?: string;
  /**
   * The executable the peer was launched with, and the arguments the caller
   * supplied (before the daemon appends `--resume` / `--model`).
   *
   * Added 2026-08-04, hours after `cwd`, for the same reason and by the same
   * oversight: `peer_restart` had nowhere to read them from, so it relaunched
   * every peer with the literal string `"claude"` and no arguments. On a PATH
   * install that happens to work; under nvm — which is how this fleet runs —
   * `claude` is not on the daemon's PATH and the respawn dies at once.
   *
   * Caught by the pilot of the `cwd` fix: the restart now failed honestly
   * (`spawn_produced_no_process`) instead of claiming success, which is what
   * made the second half of the same omission visible at all.
   *
   * Optional for records written before this release; `peer_restart` warns and
   * falls back to `"claude"` rather than refusing to run.
   */
  command?: string;
  spawnArgs?: string[];
  model: string | null;
  accountProfile: string | null;
  startedAt: string;
  lastUpdatedAt: string;
}

export interface StateDoc {
  stateVersion: number;
  daemonVersion: string;
  daemonStartedAt: string;
  peers: Record<string, PeerRecord>;
}

export class StateVersionMismatch extends Error {
  constructor(
    public readonly onDisk: number,
    public readonly supported: number,
  ) {
    super(
      `state.json stateVersion=${onDisk} exceeds daemon-supported ${supported}; rollback path is not supported — upgrade or wipe the state file explicitly`,
    );
    this.name = "StateVersionMismatch";
  }
}

export function emptyState(daemonVersion: string): StateDoc {
  return {
    stateVersion: STATE_VERSION,
    daemonVersion,
    daemonStartedAt: new Date().toISOString(),
    peers: {},
  };
}

export async function loadState(daemonVersion: string): Promise<StateDoc> {
  try {
    const raw = await readFile(stateFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StateDoc>;
    const onDisk = parsed.stateVersion ?? 0;
    if (onDisk > STATE_VERSION) throw new StateVersionMismatch(onDisk, STATE_VERSION);
    if (onDisk < STATE_VERSION) {
      log.warn("state_migration_needed", { onDisk, target: STATE_VERSION });
      // Alpha: no migrations yet — start fresh. Recorded as event by caller.
      return emptyState(daemonVersion);
    }
    const doc: StateDoc = {
      stateVersion: STATE_VERSION,
      daemonVersion,
      daemonStartedAt: new Date().toISOString(),
      peers: parsed.peers ?? {},
    };
    return doc;
  } catch (e) {
    if (e instanceof StateVersionMismatch) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      log.info("state_missing_bootstrap");
      return emptyState(daemonVersion);
    }
    log.error("state_load_error", { err: String(e) });
    throw e;
  }
}

export async function saveState(doc: StateDoc): Promise<void> {
  await atomicWriteJson(stateFilePath(), doc);
}

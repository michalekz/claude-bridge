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
export type PeerHostDriver = "tmux" | "bg-pty" | "unknown";

export interface PeerRecord {
  sessionId: string;
  name: string;
  hostDriver: PeerHostDriver;
  tmuxTarget: string | null;
  pid: number | null;
  status: PeerLifecycleStatus;
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

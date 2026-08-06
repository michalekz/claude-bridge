import { readFile, writeFile } from "node:fs/promises";
import { atomicWriteJson, makeLogger, stateFilePath } from "@claude-bridge/shared";
import { HOST_PROVIDED_VARS, stripHostProvided } from "./env-whitelist.ts";

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

export const STATE_VERSION = 2;

export type PeerLifecycleStatus = "unknown" | "starting" | "live" | "stopping" | "stopped";
export type PeerHostDriver = "tmux" | "bg-pty" | "mock" | "unknown";

/**
 * A peer record is two things that used to be one.
 *
 * Every incident of 2026-08-05 was the same defect wearing a different hat: a
 * value that had been MEASURED was later replayed as a value that had been
 * INTENDED. `spawnEnv` is the textbook case — TERM and TMUX_PANE were harvested
 * from a live pane, frozen, and handed to every later relaunch as if someone
 * had asked for them. `homeSession` drifted the same way at rename time, and
 * window names had no separation between the identity (`name`) and what is
 * painted on the tab (`label`).
 *
 * Flat records cannot express the difference, so the difference was carried in
 * people's heads, and people forget. The split makes it a type error to add a
 * field without deciding which kind it is:
 *
 *   desired  — what an operator declared. Only the config path writes it.
 *              This is what a restart replays.
 *   observed — what the daemon measured. Only measurement writes it.
 *              Never replayed as intent; carries `harvestedAt` when it was
 *              sampled from somewhere that can go stale.
 *
 * `sessionId` belongs to neither — it is the identity, and it is the one thing
 * that is true whether or not anybody is looking.
 */
export interface PeerRecord {
  sessionId: string;
  desired: PeerDesired;
  observed: PeerObserved;
}

/** Intent. Written by the config path and by spawn/adopt; replayed by restart. */
export interface PeerDesired {
  /** Team identifier from team_layout apply or team_adopt; undefined for ad-hoc peer_spawn. */
  team?: string;
  /**
   * Short display name — the tmux window title and what projections show.
   *
   * Separate from `observed.name` (the FQN) on purpose. Until v0.10.20 there
   * was no such separation, so windows wore the fully qualified name and the
   * fix had to strip a prefix back off at every call site that painted one.
   * Default is derived (`name` minus the `<team>-` prefix); an explicit value
   * wins. Identity stays with `name` — routing and name-based resume never
   * read this.
   */
  label?: string;
  /**
   * Requested position of the peer's window within its session.
   *
   * v0.11.0 STORES this and reports drift. It does NOT move windows. Asserting
   * it makes reconcile a writer against a surface a human also edits, and a
   * control plane that silently undoes a deliberate drag is the same defect
   * inverted — intent passed off as observation. The assertion lands in v0.11.1
   * behind an explicit opt-in, alongside the `adopt` path that lets the
   * operator declare reality to be the intent instead.
   */
  windowIndex?: number;
  /** The model the operator asked for. `observed.model` is what is actually running. */
  model?: string | null;
  /** Billing identity — which account/pool this peer draws from. */
  accountProfile?: string | null;
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
  /**
   * The tmux session this peer belongs to, when it lives in a WINDOW of a
   * shared one.
   *
   * Recorded at spawn/adopt time rather than derived from the live window at
   * restart time. Deriving it worked only while the window still existed, so a
   * peer whose window had already died escaped into a session of its own —
   * which on a fleet roll is every peer that crashed before its turn. Measured
   * 2026-08-04: after a manual kill, `pw1` came back as a standalone session.
   *
   * Duplicates `team` since "session = team" was ratified. Deprecation and
   * migration to a computed default land in v0.11.1 — not here, because one
   * risky change per release.
   */
  homeSession?: string;
}

/** Measurement. Written only by the daemon observing the world. Never replayed as intent. */
export interface PeerObserved {
  /**
   * Fully qualified name (`<team>-<short>`), read from the bridge registry by
   * sessionId since v0.10.15. Observed, but authoritative for routing and for
   * name-based resume — see `desired.label` for the display half.
   */
  name: string;
  hostDriver: PeerHostDriver;
  tmuxTarget: string | null;
  pid: number | null;
  status: PeerLifecycleStatus;
  /** Where the window actually sits. Compared against `desired.windowIndex` to report drift. */
  windowIndex?: number;
  /** The model actually running, as last measured. `desired.model` is what was asked for. */
  model: string | null;
  /**
   * Set when status === "stopped" (v0.10.1 team_stop lifecycle):
   *   true  — peer acknowledged stop-request; kill succeeded cleanly
   *   false — peer did not ack; killed with force
   *   null  — peer was dead (kill-idempotent) or plain peer_stop keepInState:true without explicit outcome
   * undefined for peers that are live/starting/etc.
   */
  stoppedCleanly?: boolean | null;
  /**
   * True when the daemon took over a process it did not start (team_adopt).
   * Matters because `startedAt` is then the adoption time, not the boot time,
   * and because provenance is worth keeping when diagnosing identity problems.
   */
  adopted?: boolean;
  /**
   * The peer's own environment, already whitelisted, captured when the daemon
   * first saw it.
   *
   * The whitelist decides WHICH variables a relaunch gets. Their VALUES used to
   * come from the daemon's `process.env`, which under systemd has a `PATH`
   * without nvm — so a relaunched peer could not find `node`, and lost its
   * statusLine, its hooks and its own MCP server in one step. Twenty-one peers
   * on 2026-08-04. Values belong to the peer; only the filter is ours.
   *
   * This is the field that named the whole defect class. It sits in `observed`
   * so that nothing can hand it to a relaunch as though it were a request.
   */
  spawnEnv?: Record<string, string>;
  /**
   * When `spawnEnv` was sampled.
   *
   * Missing provenance is why the poisoning of 2026-08-04 took two readings
   * eight minutes apart to see at all: the record looked equally authoritative
   * before and after it went wrong. A harvested value without a timestamp
   * cannot be judged stale by anyone.
   */
  harvestedAt?: string;
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

/**
 * Drop pane-scoped variables from `spawnEnv` written by an earlier version.
 *
 * Not a `stateVersion` migration: bumping the version discards the whole
 * document, which would lose 23 adopted peers to fix three variables. This is
 * a repair applied on every load — idempotent, and cheap enough not to care.
 *
 * Without it the bad values are self-perpetuating. `spawnEnv` is captured once
 * at adoption and replayed by every later restart, so `kb-ops` would keep
 * announcing `TMUX_PANE=%71` from a pane destroyed on 2026-08-04 no matter how
 * many times it was restarted. See `HOST_PROVIDED_VARS`.
 */
function repairHarvestedEnv(peers: Record<string, PeerRecord>): Record<string, PeerRecord> {
  for (const record of Object.values(peers)) {
    const env = record.observed.spawnEnv;
    if (!env) continue;
    const cleaned = stripHostProvided(env);
    if (Object.keys(cleaned).length === Object.keys(env).length) continue;
    log.info("spawn_env_repaired", {
      sessionId: record.sessionId,
      dropped: HOST_PROVIDED_VARS.filter((v) => v in env),
    });
    record.observed.spawnEnv = cleaned;
  }
  return peers;
}

/** The flat shape written by every daemon up to and including v0.10.21. */
interface LegacyPeerRecord {
  sessionId: string;
  name: string;
  hostDriver: PeerHostDriver;
  tmuxTarget: string | null;
  pid: number | null;
  status: PeerLifecycleStatus;
  stoppedCleanly?: boolean | null;
  team?: string;
  adopted?: boolean;
  cwd?: string;
  command?: string;
  spawnArgs?: string[];
  homeSession?: string;
  spawnEnv?: Record<string, string>;
  model: string | null;
  accountProfile: string | null;
  startedAt: string;
  lastUpdatedAt: string;
}

/**
 * v1 (flat) -> v2 (desired/observed), field for field.
 *
 * Every value is carried, none is invented. Where the flat record held one
 * field that served both roles, the migration puts it where it was actually
 * being USED, not where it reads best:
 *
 *   - `model` was written by measurement and replayed by restart, so it lands
 *     in BOTH — `observed.model` keeps the measurement, `desired.model` keeps
 *     the replay. That is the split doing its job on the one genuinely
 *     ambiguous field, rather than picking a side and quietly changing
 *     restart behaviour.
 *   - `spawnEnv` goes to `observed` only. Restart already stopped replaying it
 *     verbatim in v0.10.16; putting it in `desired` would undo that.
 *
 * `harvestedAt` is deliberately left undefined for migrated records. We do not
 * know when those values were sampled, and stamping them with the migration
 * time would manufacture a provenance that does not exist — the exact move
 * this whole release is meant to make impossible.
 */
/**
 * Does this peers dict hold flat records, whatever the version stamp claims?
 *
 * `loadState` used to trust `stateVersion` outright. That is fine while the
 * stamp and the content agree, and a crash loop the moment they do not: a
 * document labelled v2 holding v1 records made `repairHarvestedEnv` dereference
 * `record.observed` on undefined, which takes the daemon down for the entire
 * fleet at startup — the one moment nobody can intervene.
 *
 * A version stamp is a claim about content. Cheap to check, so check it.
 */
function looksLegacy(peers: Record<string, unknown>): boolean {
  const first = Object.values(peers)[0];
  if (!first || typeof first !== "object") return false;
  return !("observed" in first) && "name" in first;
}

export function migrateV1ToV2(legacyPeers: Record<string, LegacyPeerRecord>): {
  peers: Record<string, PeerRecord>;
  migrated: number;
} {
  const peers: Record<string, PeerRecord> = {};
  let migrated = 0;
  for (const [id, old] of Object.entries(legacyPeers)) {
    const desired: PeerDesired = {};
    if (old.team !== undefined) desired.team = old.team;
    if (old.model !== undefined) desired.model = old.model;
    if (old.accountProfile !== undefined) desired.accountProfile = old.accountProfile;
    if (old.cwd !== undefined) desired.cwd = old.cwd;
    if (old.command !== undefined) desired.command = old.command;
    if (old.spawnArgs !== undefined) desired.spawnArgs = old.spawnArgs;
    if (old.homeSession !== undefined) desired.homeSession = old.homeSession;

    const observed: PeerObserved = {
      name: old.name,
      hostDriver: old.hostDriver,
      tmuxTarget: old.tmuxTarget,
      pid: old.pid,
      status: old.status,
      model: old.model,
      startedAt: old.startedAt,
      lastUpdatedAt: old.lastUpdatedAt,
    };
    if (old.stoppedCleanly !== undefined) observed.stoppedCleanly = old.stoppedCleanly;
    if (old.adopted !== undefined) observed.adopted = old.adopted;
    if (old.spawnEnv !== undefined) observed.spawnEnv = old.spawnEnv;

    peers[id] = { sessionId: old.sessionId, desired, observed };
    migrated++;
  }
  return { peers, migrated };
}

export async function loadState(daemonVersion: string): Promise<StateDoc> {
  try {
    const raw = await readFile(stateFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StateDoc>;
    let onDisk = parsed.stateVersion ?? 0;
    if (onDisk > STATE_VERSION) throw new StateVersionMismatch(onDisk, STATE_VERSION);
    if (onDisk === STATE_VERSION && looksLegacy(parsed.peers ?? {})) {
      log.warn("state_version_stamp_disagrees_with_content", {
        stamped: onDisk,
        treatingAs: 1,
        hint: "records are flat; migrating on content rather than crashing on the stamp",
      });
      onDisk = 1;
    }
    if (onDisk < STATE_VERSION) {
      // Until v0.11.0 this branch called `emptyState()` — a version bump threw
      // the whole registry away. It had never fired in anger, so the cost was
      // invisible: raising the version today would have silently discarded 23
      // adopted peers, and the daemon would have come up looking healthy and
      // empty. A migration that cannot carry data is not a migration.
      if (onDisk !== 1) {
        throw new Error(
          `state.json stateVersion=${onDisk} has no migration path to ${STATE_VERSION}; ` +
            `refusing to start rather than discard ${Object.keys(parsed.peers ?? {}).length} peers`,
        );
      }
      const backup = `${stateFilePath()}.v${onDisk}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
      await writeFile(backup, raw, "utf-8");
      const { peers, migrated } = migrateV1ToV2(
        parsed.peers as unknown as Record<string, LegacyPeerRecord>,
      );
      log.warn("state_migrated", { from: onDisk, to: STATE_VERSION, peers: migrated, backup });
      return {
        stateVersion: STATE_VERSION,
        daemonVersion,
        daemonStartedAt: new Date().toISOString(),
        peers: repairHarvestedEnv(peers),
      };
    }
    const doc: StateDoc = {
      stateVersion: STATE_VERSION,
      daemonVersion,
      daemonStartedAt: new Date().toISOString(),
      peers: repairHarvestedEnv(parsed.peers ?? {}),
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

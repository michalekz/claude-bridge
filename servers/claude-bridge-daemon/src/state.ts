import { readFile, writeFile } from "node:fs/promises";
import { atomicWriteJson, makeLogger, stateFilePath } from "@claude-bridge/shared";
import { HOST_PROVIDED_VARS, stripHostProvided } from "./env-whitelist.ts";
import { type CanonicalTarget, trustCanonicalTarget } from "./hosts/driver.ts";

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

export const STATE_VERSION = 3;

export type PeerLifecycleStatus =
  | "unknown"
  | "starting"
  | "live"
  | "stopping"
  | "stopped"
  /**
   * A restart is underway (v0.11.18). Distinct from `stopping`: the peer is
   * meant to come BACK, so a reader must not treat it as leaving. Every
   * consumer of this enum has to answer for it — the `stopping` hole that
   * v0.11.17 closed with `stop_pending` existed because a status was added and
   * the readers were not.
   */
  | "restarting";
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
 * `handle` belongs to neither. It is the NAME OF THE RECORD — chosen before the
 * peer exists, by whoever wrote the team spec — and it is the key of
 * `state.peers`.
 */
export interface PeerRecord {
  /**
   * The registry key. Renamed from `sessionId` in R3 (v0.11.21).
   *
   * v0.11.16 fixed the BEHAVIOUR of defect N4 — the daemon stopped treating
   * this string as the peer's Claude Code session id and started measuring the
   * real one into `observed.sessionId`. The field kept its old name, so the
   * code was right and the record still said otherwise, and every reader had
   * to know which of the two `sessionId`s they were holding.
   *
   * After this rename the two words mean one thing each, everywhere:
   *
   *   handle    — addresses the RECORD. Ours to choose, valid before boot.
   *   sessionId — addresses the PEER. Only the peer can mint it, only after
   *               boot, and it lives on the measurement side.
   *
   * For adopted peers the two coincide, because adoption read the identity off
   * a running process in the first place — which is why 25 of 26 keys were
   * already genuine UUIDs and the v0.11.16 fix needed no data migration.
   *
   * ALWAYS EQUAL TO THE KEY. Measured 2026-08-08: 26 of 26. It is a third copy
   * of one truth — the same shape as the catalog entry that carried a stale sha
   * for three releases — so `loadState` checks the two agree instead of
   * trusting that they do.
   */
  handle: string;
  desired: PeerDesired;
  observed: PeerObserved;
}

/** Intent. Written by the config path and by spawn/adopt; replayed by restart. */
export interface PeerDesired {
  /** Team identifier from team_layout apply or team_adopt; undefined for ad-hoc peer_spawn. */
  team?: string;
  /**
   * What this peer is FOR, as declared — today only `velitel` means anything.
   *
   * It lives in `desired` because a role is an intent someone stated, not a
   * property anyone can measure. Before v0.11.13 it lived nowhere: `team_stop`
   * read a `role` field the registry did not have (so velitel-last silently
   * never happened) while `team_restart` guessed from a substring of the name
   * — one documented rule, two implementations, one of them dead.
   *
   * Undeclared peers still fall back to the name, because a fleet that has not
   * declared anything should not lose the ordering it had. Which source decided
   * is reported, so nobody has to guess whether the fallback fired.
   */
  role?: string;
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
   * inverted — intent passed off as observation. Asserting it is a wanted
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
  /**
   * The peer's address on the host — a tmux window id (`@42`) or a session
   * name, always in the form `parseHostTarget` produces.
   *
   * Branded since R3 (v0.11.21) because this field is COMPARED, not only
   * passed. The driver normalises everything handed to it, so a call was never
   * the risk; a stored value read back and matched against
   * `listWindows()`/`listSessions()` output was. A raw display name in here
   * matches nothing, and `team_reconcile` reads that as a peer whose pane is
   * gone.
   *
   * The brand makes the one path that could put a raw name here — `peer_spawn`
   * writing the record before the driver has answered — fail to compile
   * instead of failing on a fleet with an unlucky name.
   */
  tmuxTarget: CanonicalTarget | null;
  pid: number | null;
  status: PeerLifecycleStatus;
  /**
   * The Claude Code session UUID — MEASURED (v0.11.16, defect N4).
   *
   * The key of `state.peers` is a HANDLE: a string a person or a team spec
   * chose before the peer existed. That is legitimate and cannot be taken away
   * — a declarative layout has to name a peer that has not been started yet.
   * What was wrong is that the handle also passed itself off as the identity.
   *
   * Only the peer can mint its session id, and only after it boots. So it lives
   * here, on the measurement side, and `peer_spawn` reads it off the running
   * process instead of accepting it as an argument.
   *
   * For adopted peers the handle and this value coincide, because adoption read
   * identity off reality in the first place. That is why the fix needed no
   * migration: 25 of 26 keys were already genuine UUIDs.
   */
  sessionId?: string | null;
  /**
   * Whether `sessionId` above is knowledge.
   *
   * `unknown` means THE PROCESS IS RUNNING AND WE DO NOT KNOW WHO IT IS — a
   * different thing from a dead peer, and it must never be displayed as one.
   * `team_reconcile` can measure again later and complete it.
   */
  identity?: "measured" | "unknown";
  /** When the identity was measured. Absent while it is unknown. */
  identityAt?: string | null;
  /** How it was read — `sessions-json` is authoritative, `resume-arg` is a fallback. */
  identitySource?: "sessions-json" | "resume-arg" | null;
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
   * A stop that was ASKED FOR and has not resolved (v0.11.15).
   *
   * The intermediate state of a graceful stop, and the reason a retry is
   * idempotent rather than additive: a second `peer_stop` finds this, resumes
   * waiting on the SAME thread, and does not put a second request into an inbox
   * that already holds one. A peer that acks two minutes after the first call
   * timed out is answering a question that was asked once.
   *
   * It is also the honest record of a failure that changed nothing. Without it
   * the timeout would leave `status: "stopping"` with no trace of who asked or
   * when — a record claiming a transition nobody could verify, which is the
   * defect this release exists to stop making.
   *
   * Cleared when the stop completes, or when the peer comes back live.
   */
  stopRequest?: {
    threadId: string;
    msgId: string;
    requestedAt: string;
    timeoutMs: number;
  } | null;
  /**
   * A restart that is UNDERWAY (v0.11.18) — the same idea as `stopRequest`, one
   * level up, and it carries one field the stop does not need: `phase`.
   *
   * A restart is four operations, and abandoning it means something different
   * in each. Abandoned while waiting for the ready-ack, nothing has happened
   * and the peer is untouched. Abandoned during the spawn, a PROCESS MAY EXIST
   * THAT NO RECORD NAMES — the only phase that can leave an orphan. A drift
   * report that said only "a restart was abandoned" would put those two on the
   * same line, and the remedy for one is dangerous for the other: relaunching
   * over an orphan is how a fork happens.
   *
   * Which is also why this is written BEFORE the spawn rather than after. A
   * mark that appears once the action succeeded knows nothing about the action
   * that did not.
   *
   * `msgId` is null in the force branch: nobody was asked, and recording a
   * message id there would invent a conversation.
   *
   * Cleared when the restart finishes, when the peer is stopped, and when the
   * record is released. Never cleared by elapsed time — a timeout is not
   * evidence that nothing is happening.
   */
  restartRequest?: {
    threadId: string;
    msgId: string | null;
    requestedAt: string;
    timeoutMs: number;
    /** The request that owns this restart, so a second caller can name it. */
    requestId: string;
    phase: "ready-ack" | "stopping" | "spawning" | "verifying";
    /** What `--resume` will be given. Null when the peer starts fresh. */
    resumeSessionId?: string | null;
  } | null;
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
   * When `spawnEnv` was sampled from a live source.
   *
   * THE RULE, and it has exactly one exception, which is none:
   *
   *   A stamp is written ONLY by a fresh harvest from something live — a
   *   running process, a pane, `/proc`. Handing stored values from one record
   *   to the next is a COPY, and a copy never earns a stamp. An empty stamp
   *   stays empty across any number of restarts, because "we do not know when
   *   this was read" does not become knowledge by being carried further.
   *
   * Missing provenance is why the poisoning of 2026-08-04 took two readings
   * eight minutes apart to see at all: the record looked equally authoritative
   * before and after it went wrong. A harvested value without a timestamp
   * cannot be judged stale by anyone.
   *
   * The rule is spelled out because v0.11.0 broke it within hours of shipping
   * the field. `peer_spawn` stamped on every `envBase` it received, and
   * `peer_restart` passes one straight out of the record — so the v0.11.0 fleet
   * roll wrote "harvested at 17:06 today" onto 22 environments last sampled at
   * adoption the previous day. See `envHarvestedAt` in PeerSpawnArgsSchema.
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
  /**
   * Marks that the one-time revocation of pre-v0.11.1 harvest stamps has run.
   *
   * Superseded by `repairsApplied`; still read so a registry written by
   * v0.11.1 does not run that pass a second time.
   */
  harvestProvenanceRevokedAt?: string;
  /**
   * One-time data repairs already applied, by id.
   *
   * A list rather than a field per repair, because the second one arrived
   * within two hours of the first and there will be more. These are not
   * `stateVersion` migrations: the SHAPE is unchanged, what changes is whether
   * a value written by an older daemon can be believed. Version numbers answer
   * "can I read this"; these answer "should I trust this".
   */
  repairsApplied?: string[];
}

/** Ids of the one-time repairs. Never renamed — a rename re-runs the repair. */
export const REPAIR_HARVEST_PROVENANCE = "revoke-harvest-stamps-pre-0.11.1";
export const REPAIR_DERIVED_LABELS = "revoke-derived-labels-pre-0.11.2";

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
 * Clear every `harvestedAt` written before v0.11.1. Once.
 *
 * No daemon before v0.11.1 could tell a harvest from a copy — `peer_spawn`
 * stamped whenever it was handed an environment, and `peer_restart` hands it
 * one straight out of the record. So a stamp written by an older daemon carries
 * no information about when those values were actually read; it records when
 * they were last passed around. Measured on the live fleet 2026-08-06: 22 peers
 * claiming a harvest at 17:06–17:09, for environments sampled at adoption the
 * day before.
 *
 * The revocation is by DAEMON CAPABILITY, not by timestamp window. Clearing
 * "stamps written between 17:06 and 17:09" would fix this fleet and leave the
 * principle unstated; clearing everything an untrustworthy writer produced is
 * the actual rule, and it holds for anyone else's registry too.
 *
 * Empty is the honest value. We do not know when those environments were read,
 * and a wrong timestamp is worse than none — it invites exactly the "this looks
 * fresh" reasoning the field was added to prevent.
 */
export function revokeUntrustedHarvestStamps(doc: StateDoc): number {
  if (hasRepair(doc, REPAIR_HARVEST_PROVENANCE)) return 0;
  let cleared = 0;
  for (const rec of Object.values(doc.peers)) {
    if (rec.observed.harvestedAt === undefined) continue;
    // `undefined` rather than `delete`: JSON.stringify omits the key either
    // way, so the persisted record is identical, and every reader already
    // tests for undefined.
    rec.observed.harvestedAt = undefined;
    cleared++;
  }
  markRepair(doc, REPAIR_HARVEST_PROVENANCE);
  doc.harvestProvenanceRevokedAt = new Date().toISOString();
  if (cleared > 0) log.warn("harvest_stamps_revoked", { cleared, reason: "written_before_0_11_1" });
  return cleared;
}

function hasRepair(doc: StateDoc, id: string): boolean {
  if (doc.repairsApplied?.includes(id)) return true;
  // v0.11.1 recorded the harvest pass in its own field, before the list existed.
  return id === REPAIR_HARVEST_PROVENANCE && doc.harvestProvenanceRevokedAt !== undefined;
}

function markRepair(doc: StateDoc, id: string): void {
  doc.repairsApplied = [...(doc.repairsApplied ?? []), id];
}

/**
 * Clear `desired.label` values that no operator ever chose. Once.
 *
 * v0.11.0's `peer_restart` did not pass a team to `peer_spawn`, so every
 * relaunched peer stored the FULLY QUALIFIED name as its label — `mic-tester`
 * where the convention says `tester`. v0.11.1 fixed the computation and made an
 * explicit label win over the derived one, which is right in general and made
 * this case worse in particular: the stored garbage now outranked the correct
 * derivation, so the fix changed nothing on the fleet. Measured on the etl
 * canary at 17:24 — windows still `etl-dev`, `etl-velitel`.
 *
 * Correcting the code that writes a value does nothing about the values already
 * written. The two are separate jobs and it is easy to believe the first is
 * both.
 *
 * The signature is exact: a label identical to the fully qualified name of a
 * peer that HAS a team prefix is precisely what the broken path produced, and
 * precisely what the correct path never would. Anything else — a genuinely
 * chosen short name, a team-less peer, a name that does not carry its team
 * prefix — is left untouched.
 */
export function revokeDerivedLabels(doc: StateDoc): number {
  if (hasRepair(doc, REPAIR_DERIVED_LABELS)) return 0;
  let cleared = 0;
  for (const rec of Object.values(doc.peers)) {
    const { label, team } = rec.desired;
    if (label === undefined || team === undefined) continue;
    if (label !== rec.observed.name) continue;
    if (!label.startsWith(`${team}-`)) continue;
    rec.desired.label = undefined;
    cleared++;
  }
  markRepair(doc, REPAIR_DERIVED_LABELS);
  if (cleared > 0) log.warn("derived_labels_revoked", { cleared, reason: "written_before_0_11_2" });
  return cleared;
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
      sessionId: record.handle,
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
/**
 * v2 -> v3: `sessionId` becomes `handle` on every record (R3, v0.11.21).
 *
 * The value does not change — only the word does. Measured before writing this:
 * 26 of 26 records carried `sessionId` exactly equal to their key, so the field
 * was a third copy of one truth wearing the name of a different thing.
 *
 * The KEY wins where they disagree. Every lookup in the daemon goes through
 * `state.peers[<key>]`, so a record whose self-name differs from its key is
 * already unreachable under that name — taking the field's word for it would
 * mint a peer nothing can address. Disagreement is reported rather than quietly
 * accepted: it has never happened, and if it starts, somebody needs to know.
 *
 * THE VERSION IS BUMPED rather than repaired in place, deliberately. A daemon
 * older than v0.11.21 reading a v3 registry would find `sessionId: undefined`
 * on every record and carry on — a whole fleet keyed by `undefined`. `loadState`
 * refuses to start on a version from the future, so a rollback fails loudly at
 * the one moment somebody is watching instead of silently at 3am.
 */
export function migrateV2ToV3(v2Peers: Record<string, Record<string, unknown>>): {
  peers: Record<string, PeerRecord>;
  migrated: number;
  disagreed: string[];
} {
  const peers: Record<string, PeerRecord> = {};
  const disagreed: string[] = [];
  let migrated = 0;
  for (const [id, old] of Object.entries(v2Peers)) {
    const self = typeof old["sessionId"] === "string" ? (old["sessionId"] as string) : null;
    if (self !== null && self !== id) disagreed.push(`${id} (record said '${self}')`);
    const { sessionId: _dropped, ...rest } = old;
    peers[id] = { ...(rest as unknown as Omit<PeerRecord, "handle">), handle: id };
    migrated++;
  }
  return { peers, migrated, disagreed };
}

/** A v2 record names itself `sessionId`; a v3 record names itself `handle`. */
function looksV2(peers: Record<string, unknown>): boolean {
  const first = Object.values(peers)[0];
  if (!first || typeof first !== "object") return false;
  return "observed" in first && !("handle" in first);
}

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
      // TRUSTED, not sanitised — and that is a correction to my own first
      // instinct here (R3, v0.11.21). A v1 record predates the T1 fix, so it
      // COULD hold a raw display name; it could equally hold a genuine host
      // address with a space, which is what an adopted peer's target looks
      // like. Nothing distinguishes the two after the fact, and sanitising
      // would silently rename the second kind to close the first.
      //
      // So the migration carries the value as written and lets `team_reconcile`
      // say so if it matches nothing on the host. A drift entry a human can
      // read beats an address quietly rewritten during an upgrade.
      tmuxTarget: old.tmuxTarget === null ? null : trustCanonicalTarget(old.tmuxTarget),
      pid: old.pid,
      status: old.status,
      model: old.model,
      startedAt: old.startedAt,
      lastUpdatedAt: old.lastUpdatedAt,
    };
    if (old.stoppedCleanly !== undefined) observed.stoppedCleanly = old.stoppedCleanly;
    if (old.adopted !== undefined) observed.adopted = old.adopted;
    if (old.spawnEnv !== undefined) observed.spawnEnv = old.spawnEnv;

    peers[id] = { handle: old.sessionId, desired, observed };
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
    // A version stamp is a CLAIM about content. Cheap to check, so check the
    // content — and check it WHATEVER the stamp says, not only when the stamp
    // is current. Restricting this to `onDisk === STATE_VERSION` (which is how
    // it was first written in R3, and how it was written in v0.11.0 before
    // that) leaves the case that actually reached the daemon: a document
    // stamped 2 holding FLAT records went down the v2 path and had `handle`
    // grafted onto a record with no `observed` at all.
    //
    // Content wins over the stamp in both directions. There is no reading of a
    // flat record that makes it a v2 document.
    const contentSays = looksLegacy(parsed.peers ?? {})
      ? 1
      : looksV2(parsed.peers ?? {})
        ? 2
        : null;
    if (contentSays !== null && contentSays !== onDisk) {
      log.warn("state_version_stamp_disagrees_with_content", {
        stamped: onDisk,
        treatingAs: contentSays,
        hint:
          contentSays === 1
            ? "records are flat; migrating on content rather than crashing on the stamp"
            : "records name themselves `sessionId`; migrating on content rather than trusting the stamp",
      });
      onDisk = contentSays;
    }
    if (onDisk < STATE_VERSION) {
      // Until v0.11.0 this branch called `emptyState()` — a version bump threw
      // the whole registry away. It had never fired in anger, so the cost was
      // invisible: raising the version today would have silently discarded 23
      // adopted peers, and the daemon would have come up looking healthy and
      // empty. A migration that cannot carry data is not a migration.
      if (onDisk !== 1 && onDisk !== 2) {
        throw new Error(
          `state.json stateVersion=${onDisk} has no migration path to ${STATE_VERSION}; ` +
            `refusing to start rather than discard ${Object.keys(parsed.peers ?? {}).length} peers`,
        );
      }
      const backup = `${stateFilePath()}.v${onDisk}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
      await writeFile(backup, raw, "utf-8");
      // v1 documents go through BOTH steps. Chaining rather than writing a
      // direct v1->v3 path: one migration per shape change, each testable on
      // its own, and no third place to keep in step with the other two.
      const viaV2 =
        onDisk === 1
          ? migrateV1ToV2(parsed.peers as unknown as Record<string, LegacyPeerRecord>).peers
          : (parsed.peers as unknown as Record<string, Record<string, unknown>>);
      const { peers, migrated, disagreed } = migrateV2ToV3(
        viaV2 as unknown as Record<string, Record<string, unknown>>,
      );
      if (disagreed.length > 0) {
        // Never observed. If it ever is, the key was still the only reachable
        // name — this says so rather than letting the choice go unrecorded.
        log.warn("state_handle_disagreed_with_key", { peers: disagreed, resolvedAs: "key" });
      }
      log.warn("state_migrated", { from: onDisk, to: STATE_VERSION, peers: migrated, backup });
      const fresh: StateDoc = {
        stateVersion: STATE_VERSION,
        daemonVersion,
        daemonStartedAt: new Date().toISOString(),
        peers: repairHarvestedEnv(peers),
      };
      // A v1 document predates the harvest/copy distinction by definition, so
      // nothing it carried can be trusted — but the migration already declines
      // to invent stamps, which leaves nothing to revoke. Marking it done keeps
      // the pass one-time rather than something that runs on every boot.
      revokeUntrustedHarvestStamps(fresh);
      revokeDerivedLabels(fresh);
      return fresh;
    }
    const doc: StateDoc = {
      stateVersion: STATE_VERSION,
      daemonVersion,
      daemonStartedAt: new Date().toISOString(),
      peers: repairHarvestedEnv(parsed.peers ?? {}),
      // Carried forward, or the one-time pass would run on every start and
      // wipe stamps a v0.11.1 daemon had legitimately written.
      ...(parsed.harvestProvenanceRevokedAt !== undefined
        ? { harvestProvenanceRevokedAt: parsed.harvestProvenanceRevokedAt }
        : {}),
      ...(parsed.repairsApplied !== undefined ? { repairsApplied: parsed.repairsApplied } : {}),
    };
    revokeUntrustedHarvestStamps(doc);
    revokeDerivedLabels(doc);
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

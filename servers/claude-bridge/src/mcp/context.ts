import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type IdentityOptions,
  type ResolvedIdentity,
  resolvePeerIdentity,
  resolvePeerIdentityWithRetry,
} from "../identity.ts";
import {
  type InboxStore,
  type MessageEnvelope,
  createInboxStore,
  defaultBridgeRoot,
} from "../inbox/store.ts";
import { type InboxWatcherHandle, startInboxWatcher } from "../inbox/watcher.ts";
import { type HeartbeatHandle, type PeerRegistry, createPeerRegistry } from "../registry/peers.ts";
import { makeLogger } from "../util/logger.ts";
import {
  emitTerminalTitle,
  findParentTty,
  isTerminalTitleEnabled,
} from "../util/terminal-title.ts";
import { type ChannelSender, createChannelSender } from "./channel.ts";

const log = makeLogger("context");

/**
 * ServerContext — shared state passed to every tool handler.
 *
 * Built in two phases:
 * 1. `buildContext()` — identity, inbox, registry, heartbeat (no Server ref needed)
 * 2. `attachServer(ctx, server)` — channel sender + inbox watcher (needs Server)
 *
 * Display name refresh: a background timer re-resolves identity every N seconds
 * and updates the heartbeat payload. The `id` field stays fixed (sessionId), only
 * `name` and `source` can change as Claude Code populates ai-title in the JSONL.
 *
 * Stop order on shutdown:
 *   nameRefresh interval cleared → watcher.stop() → heartbeat.stop() → server.close()
 */

export interface ServerContext {
  /** Identity at boot — `id` is immutable. `name`/`source` may evolve via refresh. */
  self: ResolvedIdentity;
  inbox: InboxStore;
  registry: PeerRegistry;
  heartbeat: HeartbeatHandle | null;
  channel: ChannelSender | null;
  watcher: InboxWatcherHandle | null;
  version: string;
  baseDir?: string;
  /** Mutable mirror of self.name (updated by refreshIdentity). */
  nameRefreshTimer?: NodeJS.Timeout;
  /** In-memory set of msgIds already pushed via channel — prevents re-push on every watcher fire. */
  pushedMsgIds: Set<string>;
  /**
   * Parent process's controlling tty path (Linux/macOS only). When set, the
   * plugin writes OSC 2 sequences here so the terminal tab title reflects
   * the peer's displayName. Null when unavailable (Windows, Extension
   * scenarios, opted out).
   */
  parentTty: string | null;
}

export interface BuildContextOptions {
  /** Explicit identity (skip cascade) — for tests. */
  identity?: ResolvedIdentity;
  baseDir?: string;
  withHeartbeat?: boolean;
  version?: string;
  /** Pass through to resolvePeerIdentity (ppid/cwd/env/home overrides for tests). */
  identityOptions?: IdentityOptions;
  /** Identity refresh interval in ms (default 5_000). 0 disables. */
  nameRefreshIntervalMs?: number;
  /**
   * Emit OSC 2 escape sequences to the parent terminal so the tab title
   * tracks the peer's displayName. Default: respect env var (enabled unless
   * `CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE=0`). Tests should pass `false` so
   * they don't write OSC garbage to the test-runner tty.
   */
  emitTerminalTitle?: boolean;
}

/**
 * How often to re-resolve the peer's display name.
 *
 * Was 5 s. That polled for something that changes at most a couple of times in
 * a session — Claude Code writes `ai-title` once after the first user message,
 * and `custom-title` only on an explicit `/rename` — at 17 280 scans a day per
 * peer. Even with the incremental scan making each tick nearly free, the
 * cadence had no justification.
 *
 * Cost of the change: after a `/rename` the new name shows up in `peer_list`
 * within a minute instead of five seconds. Agreed as acceptable — the
 * compensation is procedural (poll after spawn, do not treat the first read as
 * the verdict) rather than technical.
 */
export const DEFAULT_NAME_REFRESH_MS = 60_000;

/**
 * The pid of the peer this bridge serves.
 *
 * The MCP server is spawned BY Claude Code, so our parent is the peer. Node
 * exposes it as `process.ppid`; if that is unavailable we fall back to our own
 * pid rather than reporting nothing, and say so in the log — a missing number
 * is harder for a caller to handle than a wrong-but-labelled one.
 */
export function peerPid(): number {
  const pp = process.ppid;
  if (typeof pp === "number" && pp > 1) return pp;
  log.warn("peer_pid_unresolved", { fallback: process.pid });
  return process.pid;
}

/**
 * Dohledání jména z transkriptu PO registraci.
 *
 * Běží na pozadí a nikdo na ni nečeká. Selže-li, nestane se nic: peer je
 * v registru pod prozatímním jménem (`session-json-name`, `env`, `cwd-slug`)
 * a je adresovatelný, což je to, na čem visí doručování zpráv celé flotile.
 *
 * ⚠ Jméno se přepíše jen tehdy, když se SKUTEČNĚ najde titulek. Prázdný
 * výsledek prozatímní jméno NEPŘEPISUJE — jinak by líná cesta uměla peera
 * přejmenovat na horší hodnotu, než jakou už měl.
 */
async function refreshNameFromTranscript(
  self: ResolvedIdentity,
  heartbeat: HeartbeatHandle,
  identityOptions: IdentityOptions,
): Promise<void> {
  try {
    const full = await resolvePeerIdentity({ ...identityOptions, resumedSessionId: self.id });
    if (full.source !== "jsonl-title" || full.name === self.name) return;
    heartbeat.update({ name: full.name, displayName: full.displayName, source: full.source });
    await heartbeat.flush();
    log.info("name_refreshed_from_transcript", {
      id: self.id,
      from: self.name,
      to: full.name,
    });
  } catch (e) {
    // Jméno je popisek. Peer je dosažitelný i bez něj a tohle selhání
    // nesmí být vidět jako porucha registrace — ta už proběhla.
    log.warn("name_refresh_failed", { id: self.id, err: e instanceof Error ? e.message : String(e) });
  }
}

export async function buildContext(opts: BuildContextOptions = {}): Promise<ServerContext> {
  // 🔴 LÍNÁ REGISTRACE (Zdeněk 23. 8. 2026: „předělej registraci na lazy").
  //
  // Do 23. 8. se před zápisem `status/<sid>.json` prošel CELÝ transkript,
  // aby se z něj vzal titulek pro jméno peera. Sken je lineární ve velikosti
  // — změřeno 8,6 ms/MB, tedy 2,49 s u 275 MB proti 0,16 s u malé session —
  // a byl na kritické cestě: dokud neskončil, peer NEEXISTOVAL pro nikoho.
  // `plt-velitel` (275 MB) byl takhle 10 hodin nedosažitelný.
  //
  // Pořadí je teď obrácené: nejdřív být adresovatelný, potom se jmenovat.
  // Jméno je popisek, adresovatelnost je funkce.
  //
  // ⚠ Není to zkrácení skenu ani delší timeout — obojí by tu závislost
  // nechalo. Tohle ji odstraňuje: registrace už netrvá déle proto, že je
  // co procházet.
  const self =
    opts.identity ??
    (await resolvePeerIdentityWithRetry({ ...(opts.identityOptions ?? {}), skipTitleScan: true }));
  log.info("identity_resolved", { id: self.id, name: self.name, source: self.source });

  const inbox = createInboxStore({ baseDir: opts.baseDir });
  const registry = createPeerRegistry({ baseDir: opts.baseDir });
  const version = opts.version ?? "0.0.1";

  let heartbeat: HeartbeatHandle | null = null;
  if (opts.withHeartbeat !== false) {
    heartbeat = await registry.startHeartbeat({
      id: self.id,
      name: self.name,
      displayName: self.displayName,
      // The PEER's pid, not ours: the bridge server is a child of `claude`, so
      // our parent IS the peer. Reporting process.pid pointed every consumer at
      // the wrong process, and at a dead one after a reconnect (v0.10.7).
      pid: peerPid(),
      mcpServerPid: process.pid,
      cwd: process.cwd(),
      source: self.source,
      version,
    });
    log.info("heartbeat_started", { id: self.id, name: self.name, pid: process.pid });
    // Teprve TEĎ, když je peer v registru a dosažitelný, se dohledá titulek.
    // Doběhne-li, jméno se v registru přepíše; nedoběhne-li, peer zůstane pod
    // prozatímním jménem — což je pořád nekonečně lepší než nebýt v registru.
    void refreshNameFromTranscript(self, heartbeat, opts.identityOptions ?? {});
  }

  // Resolve parent CC's controlling tty so we can write OSC 2 sequences for
  // terminal tab title. Null when not applicable (Extension scenarios where
  // CC has no tty; Windows; opted out via env/opt). Cached for the lifetime
  // of the session — ppid doesn't change.
  const titleAllowed = opts.emitTerminalTitle ?? isTerminalTitleEnabled();
  const parentTty = titleAllowed ? findParentTty(process.ppid) : null;
  if (parentTty) {
    log.info("terminal_title_emit_enabled", { tty: parentTty });
    emitTerminalTitle(parentTty, self.displayName);
  }

  const context: ServerContext = {
    self,
    inbox,
    registry,
    heartbeat,
    channel: null,
    watcher: null,
    version,
    pushedMsgIds: new Set<string>(),
    parentTty,
  };
  if (opts.baseDir) context.baseDir = opts.baseDir;

  // Display name refresh — re-resolve every N seconds, push to heartbeat if changed.
  // `id` is stable (sessionId), only `name`/`source` can change as Claude Code
  // populates the ai-title event in JSONL after the first user message.
  const refreshMs = opts.nameRefreshIntervalMs ?? DEFAULT_NAME_REFRESH_MS;
  if (refreshMs > 0 && heartbeat && !opts.identity) {
    // Guarded against overlap. The refresh used to be fired unconditionally,
    // and before the incremental scan landed a single tick took 2755 ms on a
    // 229 MB transcript — 55 % of the old 5 s interval before any disk
    // contention, so ticks could stack and each one pinned its own copy of the
    // file. The scan is nearly free now, but the guard stays: an interval that
    // can outrun itself is a pile-up waiting for a slow disk.
    //
    // Inlined rather than imported from @claude-bridge/shared (where the same
    // guard lives, with tests) because this package deliberately has no
    // dependency on it. `util/paths.ts` and `util/logger.ts` are already
    // duplicated the same way; consolidating all three is worth doing on
    // purpose, not as a side effect of a memory fix.
    let refreshInFlight = false;
    let refreshSkipped = 0;
    const guarded = async (): Promise<void> => {
      if (refreshInFlight) {
        refreshSkipped++;
        // Log on a doubling curve so a stall is visible without flooding.
        if ((refreshSkipped & (refreshSkipped - 1)) === 0) {
          log.warn("name_refresh_skipped_busy", { skipped: refreshSkipped });
        }
        return;
      }
      refreshInFlight = true;
      try {
        await refreshDisplayName(context, opts.identityOptions ?? {});
      } catch (e) {
        log.warn("name_refresh_failed", { err: e instanceof Error ? e.message : String(e) });
      } finally {
        refreshInFlight = false;
        refreshSkipped = 0;
      }
    };
    const timer = setInterval(() => void guarded(), refreshMs);
    timer.unref?.();
    context.nameRefreshTimer = timer;
  }

  return context;
}

/**
 * Re-resolve identity once and apply the change (name update OR full id migration).
 * Exposed for tests; production callers go through the setInterval inside buildContext.
 */
export async function refreshIdentityNow(
  ctx: ServerContext,
  identityOptions: IdentityOptions = {},
): Promise<void> {
  return refreshDisplayName(ctx, identityOptions);
}

async function refreshDisplayName(
  ctx: ServerContext,
  identityOptions: IdentityOptions,
): Promise<void> {
  let fresh: ResolvedIdentity;
  try {
    fresh = await resolvePeerIdentity(identityOptions);
  } catch {
    // session.json disappeared — keep current identity, don't crash.
    return;
  }

  if (fresh.id !== ctx.self.id) {
    await migrateIdentity(ctx, fresh);
    return;
  }
  if (
    fresh.name === ctx.self.name &&
    fresh.source === ctx.self.source &&
    fresh.displayName === ctx.self.displayName
  ) {
    return;
  }

  log.info("name_refreshed", {
    from: ctx.self.name,
    to: fresh.name,
    source: fresh.source,
  });
  const displayChanged = fresh.displayName !== ctx.self.displayName;
  ctx.self = fresh;
  ctx.heartbeat?.update({
    name: fresh.name,
    displayName: fresh.displayName,
    source: fresh.source,
  });
  // Re-emit OSC 2 only when the human-visible displayName actually changed
  // (e.g. cwd-slug → ai-title transition). Avoids spurious writes when the
  // slug-only `name` changed but displayName stayed the same.
  if (ctx.parentTty && displayChanged) {
    emitTerminalTitle(ctx.parentTty, fresh.displayName);
  }
}

/**
 * Identity id changed mid-life. This happens when session.json was unstable at
 * boot (e.g. VS Code Claude Code extension reparenting / --resume race) and
 * later settled on the authoritative sessionId. We need to:
 *
 * 1. Rename our inbox dir from <oldId> → <newId> so any messages already
 *    sent to us aren't orphaned (rare — boot race is typically <100ms with
 *    no peers aware of us yet, but defensive).
 * 2. Stop the old heartbeat (deletes status/<oldId>.json).
 * 3. Start a fresh heartbeat under newId.
 * 4. Restart the watcher to point at the new pending dir.
 * 5. Update ctx.self.
 */
async function migrateIdentity(ctx: ServerContext, fresh: ResolvedIdentity): Promise<void> {
  const oldId = ctx.self.id;
  log.info("identity_migrated", {
    from: oldId,
    to: fresh.id,
    newName: fresh.name,
    newSource: fresh.source,
  });

  // 1. Move inbox dir if it exists. Rename is atomic on POSIX (same fs).
  const root = ctx.baseDir ?? defaultBridgeRoot();
  const oldInbox = join(root, "inbox", oldId);
  const newInbox = join(root, "inbox", fresh.id);
  try {
    await mkdir(dirname(newInbox), { recursive: true });
    await rename(oldInbox, newInbox);
    log.info("inbox_dir_migrated", { from: oldInbox, to: newInbox });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.warn("inbox_dir_migrate_failed", { err: e instanceof Error ? e.message : String(e) });
    }
    // ENOENT = no messages received yet; benign.
  }

  // 2. Stop old heartbeat (deletes status/<oldId>.json).
  if (ctx.heartbeat) {
    await ctx.heartbeat.stop().catch(() => undefined);
  }

  // 3. Start fresh heartbeat under newId.
  ctx.heartbeat = await ctx.registry.startHeartbeat({
    id: fresh.id,
    name: fresh.name,
    displayName: fresh.displayName,
    pid: peerPid(),
    mcpServerPid: process.pid,
    cwd: process.cwd(),
    source: fresh.source,
    version: ctx.version,
  });

  // 4. Update ctx.self BEFORE restarting watcher so any pump call sees the
  //    new id. (Pump reads from ctx.self.id.)
  ctx.self = fresh;

  // 5. Restart watcher on the new pending dir. Await `ready` so the watcher
  //    is actively watching before we proceed.
  if (ctx.watcher) {
    await ctx.watcher.stop().catch(() => undefined);
    const newWatcher = startInboxWatcher(
      fresh.id,
      async () => {
        const { pushed } = await pumpInboxToChannel(ctx);
        if (pushed > 0) log.info("pump_pushed", { count: pushed });
      },
      ctx.baseDir ? { baseDir: ctx.baseDir } : {},
    );
    ctx.watcher = newWatcher;
    await newWatcher.ready;
  }

  // 6. Drain any messages that arrived in the new dir before watcher attached
  //    (race window: sender wrote to inbox/<newId>/ during the brief migration
  //    transition). Without this drain, those messages would never be pushed
  //    via channel and rely on piggyback fallback only.
  const { pushed } = await pumpInboxToChannel(ctx);
  if (pushed > 0) log.info("post_migrate_drain", { pushed });
}

/**
 * Push pending messages through the channel. DOES NOT consume — pending stays
 * pending so piggyback can still drain (and actually inject into agent context).
 *
 * Why not consume on `delivered: true`?
 * - `server.notification()` returning success means the MCP protocol layer
 *   accepted our payload. It does NOT mean Claude Code rendered the
 *   `<channel source="claude-bridge" ...>` tag into the agent's prompt.
 * - In research preview, custom (non-allowlisted) plugins typically have
 *   their channel notifications dropped silently — protocol OK, no render.
 * - If we consumed on protocol success, those messages would be lost: agent
 *   never saw them, but they're now in `done/` so piggyback can't drain.
 *
 * Strategy: push is best-effort. Piggyback (drains pending on every tool call)
 * is the source of truth for "agent saw it". Worst case: if Claude Code
 * actually renders the push tag, agent sees the message twice (channel tag +
 * piggyback block) — acceptable cost vs. lost messages.
 *
 * In-memory `pushedMsgIds` dedup prevents re-pushing the same file on every
 * watcher fire while it sits in pending. (Set is process-lifetime; restart
 * resets it, which is fine — boot drain re-pushes everything once.)
 */
export async function pumpInboxToChannel(ctx: ServerContext): Promise<{ pushed: number }> {
  if (!ctx.channel) return { pushed: 0 };
  const pending = await ctx.inbox.listPending(ctx.self.id);
  let pushed = 0;
  for (const env of pending) {
    if (ctx.pushedMsgIds.has(env.id)) continue; // already pushed in this process
    const { delivered } = await ctx.channel.push(env);
    if (!delivered) {
      log.debug("push_failed_left_in_pending", { msgId: env.id });
      continue;
    }
    ctx.pushedMsgIds.add(env.id);
    pushed++;
    // Note: NO consume here. Piggyback drains pending → moves to done.
    //
    // A note on disk that the push happened, though. `pushedMsgIds` is a Set
    // for the life of this process, so nothing outside it — an operator, a
    // later session, a diagnosis — could tell "pushed, not yet confirmed" from
    // "never left the outbox". Both looked like a file in `pending/`, and on
    // 2026-08-05 two of us separately spent hours calling healthy peers deaf.
    //
    // Recording it must not CHANGE anything: re-pushing after a restart stays
    // correct, because a push is still not evidence the agent saw it. This is
    // provenance, not a suppression flag.
    await ctx.inbox.markPushed(ctx.self.id, env.id);
  }
  return { pushed };
}

export interface AttachServerOptions {
  withWatcher?: boolean;
}

/**
 * Phase 2 of context construction — attach Server-dependent pieces.
 */
export async function attachServer(
  ctx: ServerContext,
  // biome-ignore lint/suspicious/noExplicitAny: SDK Server type
  server: any,
  opts: AttachServerOptions = {},
): Promise<void> {
  ctx.channel = createChannelSender(server);
  if (opts.withWatcher !== false) {
    ctx.watcher = startInboxWatcher(
      ctx.self.id,
      async () => {
        const { pushed } = await pumpInboxToChannel(ctx);
        if (pushed > 0) log.info("pump_pushed", { count: pushed });
      },
      ctx.baseDir ? { baseDir: ctx.baseDir } : {},
    );
    log.info("watcher_attached", { id: ctx.self.id, name: ctx.self.name });
  }
}

export async function shutdownContext(ctx: ServerContext): Promise<void> {
  if (ctx.nameRefreshTimer) clearInterval(ctx.nameRefreshTimer);
  if (ctx.watcher) {
    await ctx.watcher.stop().catch(() => undefined);
  }
  if (ctx.heartbeat) {
    await ctx.heartbeat.stop().catch(() => undefined);
  }
}

export type { MessageEnvelope };

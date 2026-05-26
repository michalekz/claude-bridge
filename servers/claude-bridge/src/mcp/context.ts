import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type IdentityOptions, type ResolvedIdentity, resolvePeerIdentity } from "../identity.ts";
import {
  type InboxStore,
  type MessageEnvelope,
  createInboxStore,
  defaultBridgeRoot,
} from "../inbox/store.ts";
import { type InboxWatcherHandle, startInboxWatcher } from "../inbox/watcher.ts";
import { type HeartbeatHandle, type PeerRegistry, createPeerRegistry } from "../registry/peers.ts";
import { makeLogger } from "../util/logger.ts";
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
}

export const DEFAULT_NAME_REFRESH_MS = 5_000;

export async function buildContext(opts: BuildContextOptions = {}): Promise<ServerContext> {
  const self = opts.identity ?? (await resolvePeerIdentity(opts.identityOptions ?? {}));
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
      pid: process.pid,
      cwd: process.cwd(),
      source: self.source,
      version,
    });
    log.info("heartbeat_started", { id: self.id, name: self.name, pid: process.pid });
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
  };
  if (opts.baseDir) context.baseDir = opts.baseDir;

  // Display name refresh — re-resolve every N seconds, push to heartbeat if changed.
  // `id` is stable (sessionId), only `name`/`source` can change as Claude Code
  // populates the ai-title event in JSONL after the first user message.
  const refreshMs = opts.nameRefreshIntervalMs ?? DEFAULT_NAME_REFRESH_MS;
  if (refreshMs > 0 && heartbeat && !opts.identity) {
    const timer = setInterval(() => {
      void refreshDisplayName(context, opts.identityOptions ?? {}).catch((e) => {
        log.warn("name_refresh_failed", { err: e instanceof Error ? e.message : String(e) });
      });
    }, refreshMs);
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
  ctx.self = fresh;
  ctx.heartbeat?.update({
    name: fresh.name,
    displayName: fresh.displayName,
    source: fresh.source,
  });
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
    pid: process.pid,
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

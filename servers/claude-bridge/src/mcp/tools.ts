import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isSyntheticSender } from "@claude-bridge/shared";
import { z } from "zod";
import { type MessageEnvelope, type MessageKind, generateMessageId } from "../inbox/store.ts";
import {
  type ContextLimitSource,
  type ContextUsage,
  noLiveDataStatus,
  readContextUsageForSession,
} from "../parser/context-usage.ts";
import type { ContextLimitCaveat } from "../parser/jsonl-context.ts";
import { countEventsByType, parseSessionFile, parseSessionFileRaw } from "../parser/jsonl.ts";
import {
  MODELS,
  MODEL_METADATA_SOURCE,
  effectivePricing,
  lookupModel,
} from "../parser/model-metadata.ts";
import { readLiveRateLimits } from "../parser/rate-limits.ts";
import type { AssistantEvent, ContentBlock, SessionEvent, UserEvent } from "../parser/schemas.ts";
import {
  type SessionRef,
  findSessions,
  listAllSessions,
  listProjects,
  listSessionsInProject,
  serializeSessionRef,
} from "../parser/session.ts";
import type { ActivePeer } from "../registry/peers.ts";
import { atomicWriteJson } from "../util/atomic-write.ts";
import { makeLogger } from "../util/logger.ts";
import { bridgeRoot, encodeProjectDir } from "../util/paths.ts";
import type { ServerContext } from "./context.ts";
import {
  ControlConfigArgs,
  ControlStatusArgs,
  PeerCompactArgs,
  PeerRestartArgs,
  PeerSpawnArgs,
  PeerStopArgs,
  TeamAdoptArgs,
  TeamLayoutArgs,
  TeamReconcileArgs,
  TeamReleaseArgs,
  TeamRestartArgs,
  TeamStatusArgs,
  TeamStopArgs,
  controlConfigTool,
  controlStatusTool,
  peerCompactTool,
  peerRestartTool,
  peerSpawnTool,
  peerStopTool,
  teamAdoptTool,
  teamLayoutTool,
  teamReconcileTool,
  teamReleaseTool,
  teamRestartTool,
  teamStatusTool,
  teamStopTool,
} from "./control-plane.ts";

const log = makeLogger("tools");

/**
 * Tool result shape — matches MCP SDK expected output for CallTool.
 */
export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...(data as object) }) }],
  };
}

function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(code: string, message?: string, details?: unknown): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, code, message, details }),
      },
    ],
  };
}

// ============================================================================
// Read-only tools (don't use ctx)
// ============================================================================

export const ListProjectsArgs = z.object({}).strict();

export async function listProjectsTool(): Promise<ToolResult> {
  try {
    const projects = await listProjects();
    return ok({
      count: projects.length,
      projects: projects.map((p) => ({ projectDir: p.projectDir, path: p.absolutePath })),
    });
  } catch (e) {
    log.error("list_projects_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("list_projects_failed", e instanceof Error ? e.message : "unknown");
  }
}

export const ListSessionsArgs = z
  .object({
    project: z.string().optional(),
    limit: z.number().int().positive().max(1000).default(50),
    includeActive: z.boolean().default(true),
    includeMeta: z.boolean().default(false),
  })
  .strict();

const HEARTBEAT_ACTIVE_THRESHOLD_MS = 30_000;

interface SessionExtras {
  active?: boolean;
  aiTitle?: string | null;
  userPrompts?: number;
  assistantReplies?: number;
}

async function isSessionActive(sessionId: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const hbPath = join(homedir(), ".claude-bridge", "status", `${sessionId}.json`);
  try {
    const s = await stat(hbPath);
    return Date.now() - s.mtimeMs <= HEARTBEAT_ACTIVE_THRESHOLD_MS;
  } catch {
    return false;
  }
}

/**
 * Single-pass streaming scan over a session JSONL — collects last ai-title
 * plus user/assistant counters in one read. Counters mirror the meaning a
 * human user expects:
 *   userPrompts        — real user inputs (excludes tool_result wrappers)
 *   assistantReplies   — assistant turns ending with stop_reason='end_turn'
 *                        (one per "agent finished, your turn" moment)
 */
async function scanSessionMeta(filePath: string): Promise<{
  aiTitle: string | null;
  userPrompts: number;
  assistantReplies: number;
}> {
  let aiTitle: string | null = null;
  let userPrompts = 0;
  let assistantReplies = 0;

  for await (const event of parseSessionFileRaw(filePath)) {
    const t = event.type;
    if (t === "ai-title" && typeof event.aiTitle === "string") {
      aiTitle = event.aiTitle;
    } else if (t === "custom-title" && typeof event.customTitle === "string") {
      aiTitle = event.customTitle;
    } else if (t === "user") {
      // Exclude tool_result wrappers — only real user prompts count
      const content = event.message?.content;
      const isToolResult =
        Array.isArray(content) &&
        content.some(
          (b): b is { type: string } =>
            typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result",
        );
      if (!isToolResult) userPrompts++;
    } else if (t === "assistant") {
      const msg = event.message as { stop_reason?: unknown } | undefined;
      if (msg && msg.stop_reason === "end_turn") assistantReplies++;
    }
  }

  return { aiTitle, userPrompts, assistantReplies };
}

export async function listSessionsTool(
  args: z.infer<typeof ListSessionsArgs>,
): Promise<ToolResult> {
  try {
    let sessions: SessionRef[] = await listAllSessions();
    if (args.project) {
      sessions = sessions.filter((s) => s.projectDir === args.project);
    }
    sessions = sessions.slice(0, args.limit);

    const enriched = await Promise.all(
      sessions.map(async (s) => {
        const extras: SessionExtras = {};
        if (args.includeActive) {
          extras.active = await isSessionActive(s.sessionId);
        }
        if (args.includeMeta) {
          try {
            const meta = await scanSessionMeta(s.filePath);
            extras.aiTitle = meta.aiTitle;
            extras.userPrompts = meta.userPrompts;
            extras.assistantReplies = meta.assistantReplies;
          } catch (e) {
            log.warn("list_sessions_meta_scan_failed", {
              file: s.filePath,
              err: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return { ...serializeSessionRef(s), ...extras };
      }),
    );

    return ok({ count: enriched.length, sessions: enriched });
  } catch (e) {
    log.error("list_sessions_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("list_sessions_failed", e instanceof Error ? e.message : "unknown");
  }
}

export const SessionStatsArgs = z
  .object({
    sessionId: z.string().uuid(),
    project: z.string().optional(),
  })
  .strict();

export async function sessionStatsTool(
  args: z.infer<typeof SessionStatsArgs>,
): Promise<ToolResult> {
  try {
    const matches = await findSessions(args.sessionId);
    const filtered = args.project ? matches.filter((m) => m.projectDir === args.project) : matches;

    if (filtered.length === 0) {
      return err("session_not_found", `No session ${args.sessionId} found`);
    }

    // Sequential, and streamed rather than materialised (fix, 2026-08-03).
    //
    // This used `readSessionFile`, which builds an array of every validated
    // event in the file — its own doc comment says "small files (< 100 MB)"
    // — and ran the sessions CONCURRENTLY through Promise.all, so several
    // whole transcripts could be resident at once. `countEventsByType` has
    // existed alongside it the whole time and does exactly this job by
    // streaming. Counting does not need the events kept.
    const results = [];
    for (const s of filtered) {
      const counts = await countEventsByType(s.filePath);
      results.push({
        ...serializeSessionRef(s),
        totalEvents: counts.total,
        eventsByType: counts.byType,
        // Types Claude Code writes that our schema does not model. Empty is the
        // normal case; non-empty says the schema is behind, not that the count
        // is short (fix, 2026-08-04 — the count used to silently omit these).
        unmodelledTypes: counts.unmodelledTypes,
        malformedLines: counts.malformedLines,
      });
    }

    return ok({ sessionId: args.sessionId, instances: results });
  } catch (e) {
    log.error("session_stats_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("session_stats_failed", e instanceof Error ? e.message : "unknown");
  }
}

// ============================================================================
// Peer tools (use ctx)
// ============================================================================

/**
 * Resolve a `to` parameter (peer id OR name) → ActivePeer.
 *
 * Returns:
 *   { ok: true, peer }                                   — exact id or unique name match
 *   { ok: false, code: 'peer_not_found', activePeers }   — no match; snapshot of who IS active
 *   { ok: false, code: 'ambiguous_peer', candidates }    — name matches >1 peer
 *
 * The `activePeers` snapshot is included on `peer_not_found` so callers can
 * surface diagnostic context to the user — heartbeat-based discovery can
 * drop peers between calls (e.g. a `peer_list` ~30s+ before this resolver
 * call), and the failing target name might genuinely not be present *now*.
 */
async function resolveTargetPeer(
  ctx: ServerContext,
  target: string,
): Promise<
  | { ok: true; peer: ActivePeer }
  | { ok: false; code: "peer_not_found"; activePeers: ActivePeer[] }
  | { ok: false; code: "ambiguous_peer"; candidates: ActivePeer[] }
> {
  const peers = await ctx.registry.listActivePeers();
  const byId = peers.find((p) => p.id === target);
  if (byId) return { ok: true, peer: byId };

  const byName = peers.filter((p) => p.name === target);
  if (byName.length === 1) return { ok: true, peer: byName[0] as ActivePeer };
  if (byName.length > 1) return { ok: false, code: "ambiguous_peer", candidates: byName };

  // Short form, resolved the way a hostname resolves in a search domain.
  //
  // The daemon learned this first, and for a while only the daemon had it:
  // `peer_restart velitel` refused with the three full names while
  // `peer_context_status velitel` still said peer_not_found. Half a convention
  // is worse than none, because which half you get depends on which tool you
  // reached for. Caught by running the tools rather than the tests, 2026-08-05.
  //
  // No new state: under the convention a peer's own team is the prefix of its
  // own name, so the caller carries its search domain in its identity. A fleet
  // that does not follow the convention has no short forms and loses nothing.
  const byShort = peers.filter((p) => shortFormOfName(p.name, teamOfName(p.name)) === target);
  if (byShort.length === 1) return { ok: true, peer: byShort[0] as ActivePeer };
  if (byShort.length > 1) {
    const ownTeam = teamOfName(ctx.self.name);
    const own = ownTeam ? byShort.filter((p) => teamOfName(p.name) === ownTeam) : [];
    if (own.length === 1) return { ok: true, peer: own[0] as ActivePeer };
    return { ok: false, code: "ambiguous_peer", candidates: byShort };
  }
  return { ok: false, code: "peer_not_found", activePeers: peers };
}

/** The team a fully qualified name belongs to — `ai-bridge-dev` → `ai`. */
function teamOfName(name: string): string | null {
  const i = name.indexOf("-");
  return i > 0 ? name.slice(0, i) : null;
}

/** The short form of a name within its own team, or null when it has none. */
function shortFormOfName(name: string, team: string | null): string | null {
  if (!team) return null;
  const short = name.slice(team.length + 1);
  return short.length > 0 ? short : null;
}

/**
 * Map ActivePeer → minimal diagnostic shape for error details.
 * Includes id (UUID, always unique), name (slug, can collide),
 * and displayName only if it differs from name.
 */
function peerDiagShape(p: ActivePeer): { id: string; name: string; displayName?: string } {
  return {
    id: p.id,
    name: p.name,
    ...(p.displayName && p.displayName !== p.name ? { displayName: p.displayName } : {}),
  };
}

const PEER_NOT_FOUND_HINT =
  "Heartbeat-based discovery can drop peers between calls (ONLINE_THRESHOLD_MS=30s). " +
  "Re-check via peer_list. For unstable names, address by id (UUID).";

function shortId(id: string): string {
  return id.slice(0, 8);
}

export const PeerListArgs = z.object({}).strict();

/**
 * Two numbers that answer "is this peer hearing me?" without a shell.
 *
 * `pending` alone cannot answer it. `pending/` means "not confirmed seen by the
 * agent", not "not delivered" — push is best-effort and only piggyback
 * consumes, deliberately, so a message Claude Code never rendered is not lost
 * (see `pumpInboxToChannel`). A file therefore sits there in two very different
 * situations, and on 2026-08-05 plt-designer and I each spent hours on the
 * wrong one: of nineteen decidable pending files across the fleet, seventeen
 * had been delivered and answered.
 *
 * `pendingNeverPushed` separates them. Non-zero is the one worth chasing.
 */
async function queueHealth(
  ctx: ServerContext,
  peerId: string,
): Promise<{ pending: number; pendingNeverPushed: number }> {
  try {
    const pending = await ctx.inbox.listPending(peerId);
    let neverPushed = 0;
    for (const env of pending) {
      if (!(await ctx.inbox.pushRecord(peerId, env.id))) neverPushed++;
    }
    return { pending: pending.length, pendingNeverPushed: neverPushed };
  } catch {
    // A peer whose inbox cannot be read is not a reason to fail the listing.
    return { pending: 0, pendingNeverPushed: 0 };
  }
}

export async function peerListTool(ctx: ServerContext): Promise<ToolResult> {
  try {
    const peers = await ctx.registry.listActivePeers();
    const queues = await Promise.all(peers.map((p) => queueHealth(ctx, p.id)));
    return ok({
      self: {
        id: ctx.self.id,
        name: ctx.self.name,
        displayName: ctx.self.displayName,
      },
      count: peers.length,
      peers: peers.map((p, i) => ({
        id: p.id,
        name: p.name,
        displayName: p.displayName ?? p.name,
        // The PEER's pid — the Claude Code process. Before v0.10.7 this was
        // the bridge server's own pid, so anyone acting on it reached the
        // bridge, and after a reconnect it could name a DEAD process.
        pid: p.pid,
        mcpServerPid: p.mcpServerPid ?? null,
        cwd: p.cwd,
        ageMs: p.ageMs,
        source: p.source,
        version: p.version,
        ...queues[i],
      })),
    });
  } catch (e) {
    log.error("peer_list_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("peer_list_failed", e instanceof Error ? e.message : "unknown");
  }
}

export const PeerAskArgs = z
  .object({
    to: z.string().min(1),
    content: z.string().min(1).max(64_000),
    threadId: z.string().optional(),
  })
  .strict();

export async function peerAskTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerAskArgs>,
): Promise<ToolResult> {
  if (args.to === ctx.self.id || args.to === ctx.self.name) {
    return err("self_send", `Cannot send to self (id=${ctx.self.id} name=${ctx.self.name})`);
  }

  const resolved = await resolveTargetPeer(ctx, args.to);
  if (!resolved.ok) {
    if (resolved.code === "ambiguous_peer") {
      return err(
        "ambiguous_peer",
        `Multiple peers match name "${args.to}". Send by id instead.`,
        resolved.candidates.map((c) => ({ id: c.id, name: c.name, cwd: c.cwd })),
      );
    }
    return err("peer_not_found", `No active peer with id or name "${args.to}"`, {
      activePeers: resolved.activePeers.map(peerDiagShape),
      hint: PEER_NOT_FOUND_HINT,
    });
  }

  const envelope: MessageEnvelope = {
    id: generateMessageId(),
    from: ctx.self.id,
    fromName: ctx.self.name,
    to: resolved.peer.id,
    toName: resolved.peer.name,
    kind: "ask" as MessageKind,
    sentAt: new Date().toISOString(),
    content: args.content,
    ...(args.threadId ? { threadId: args.threadId } : {}),
  };
  try {
    await ctx.inbox.send(envelope);
    log.info("peer_ask_sent", {
      to: resolved.peer.id,
      toName: resolved.peer.name,
      msgId: envelope.id,
    });
    return ok({
      msgId: envelope.id,
      to: { id: resolved.peer.id, name: resolved.peer.name },
    });
  } catch (e) {
    log.error("peer_ask_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("peer_ask_failed", e instanceof Error ? e.message : "unknown");
  }
}

export const PeerReplyArgs = z
  .object({
    inReplyTo: z.string().min(1),
    content: z.string().min(1).max(64_000),
  })
  .strict();

export async function peerReplyTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerReplyArgs>,
): Promise<ToolResult> {
  // Find the original in either done/ (already consumed) or pending/ (push-delivered
  // but not yet drained — without this, push → reply requires a manual peer_inbox_read).
  const found = await ctx.inbox.findMessage(ctx.self.id, args.inReplyTo);
  if (!found) {
    return err(
      "original_not_found",
      `No message ${args.inReplyTo} found in inbox/${shortId(ctx.self.id)}/{pending,done}/`,
      {
        hint:
          "msgId may be a typo, from a previous session (archive purged), " +
          "or the sender hasn't actually delivered yet. " +
          "Run peer_inbox_read to explicitly drain pending messages.",
      },
    );
  }
  const original = found.envelope;

  // A message injected from outside the fleet has no inbox to reply into.
  // Writing one would create `inbox/external:<label>/pending/`, a directory no
  // process drains — the reply would sit there looking delivered forever. Refuse
  // instead, and say where the answer has to go (v0.10.3).
  if (isSyntheticSender(original.from)) {
    return err(
      "sender_is_external",
      `Message ${args.inReplyTo} came from '${original.fromName ?? original.from}', which is not a peer — there is no inbox to reply into.`,
      {
        from: original.from,
        hint:
          "External messages are injected by `claude-bridge-daemon send` (a Teams relay, a cron job). " +
          "Replying would write to a directory nothing reads. Answer through whatever carried the message in.",
      },
    );
  }

  // If push delivered the message inline but piggyback hasn't drained yet,
  // archive it now so peer_reply has a consistent post-condition.
  if (found.location === "pending") {
    await ctx.inbox.consume(ctx.self.id, args.inReplyTo);
  }
  const reply: MessageEnvelope = {
    id: generateMessageId(),
    from: ctx.self.id,
    fromName: ctx.self.name,
    to: original.from,
    ...(original.fromName ? { toName: original.fromName } : {}),
    kind: "reply" as MessageKind,
    sentAt: new Date().toISOString(),
    content: args.content,
    inReplyTo: args.inReplyTo,
    ...(original.threadId ? { threadId: original.threadId } : {}),
  };
  try {
    await ctx.inbox.send(reply);
    log.info("peer_reply_sent", {
      to: original.from,
      toName: original.fromName,
      msgId: reply.id,
      inReplyTo: args.inReplyTo,
    });
    return ok({
      msgId: reply.id,
      to: { id: original.from, name: original.fromName ?? null },
      inReplyTo: args.inReplyTo,
    });
  } catch (e) {
    log.error("peer_reply_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("peer_reply_failed", e instanceof Error ? e.message : "unknown");
  }
}

export const PeerInboxReadArgs = z.object({}).strict();

export async function peerInboxReadTool(ctx: ServerContext): Promise<ToolResult> {
  try {
    const pending = await ctx.inbox.listPending(ctx.self.id);
    const consumed: MessageEnvelope[] = [];
    for (const p of pending) {
      const c = await ctx.inbox.consume(ctx.self.id, p.id);
      if (c) consumed.push(c);
    }
    return ok({ count: consumed.length, messages: consumed });
  } catch (e) {
    log.error("peer_inbox_read_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("peer_inbox_read_failed", e instanceof Error ? e.message : "unknown");
  }
}

// ============================================================================
// peer_chat_read — read messages from another peer's session JSONL
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PeerChatReadArgs = z
  .object({
    to: z.string().min(1),
    lastN: z.number().int().positive().max(500).optional(),
    sinceTimestamp: z.string().optional(),
    sinceLastUserPrompt: z.boolean().default(false),
    maxBytes: z.number().int().positive().max(1_000_000).default(30_000),
    includeToolCalls: z.boolean().default(false),
    includeThinking: z.boolean().default(false),
    rolesOnly: z.array(z.enum(["user", "assistant"])).optional(),
    crossProject: z.boolean().default(false),
    format: z.enum(["markdown", "json", "compact"]).default("markdown"),
    query: z.string().optional(),
    queryRegex: z.boolean().default(false),
    contextLines: z.number().int().min(0).max(10).default(0),
  })
  .strict();

interface ChatMessage {
  ts: string;
  uuid: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  toolResults?: Array<{ tool_use_id: string; content: unknown; is_error?: boolean }>;
}

// IDE-injected telemetry tags (VS Code / Claude Code wrappers) — pure noise for
// an agent reading the transcript. Stripped from user-visible text always.
const IDE_NOISE_RE =
  /<(ide_[a-z_]+|system-reminder|local-command-stdout|command-message|command-name|command-args)>[\s\S]*?<\/\1>/gi;

function stripIdeNoise(text: string): string {
  return text
    .replace(IDE_NOISE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TOOL_CONTENT_MAX = 500;

function truncateToolValue(v: unknown): unknown {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.length <= TOOL_CONTENT_MAX) return v;
  return `${s.slice(0, TOOL_CONTENT_MAX)}…(${s.length - TOOL_CONTENT_MAX} more chars)`;
}

function extractText(blocks: ContentBlock[] | string): string {
  if (typeof blocks === "string") return stripIdeNoise(blocks);
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
  }
  return stripIdeNoise(parts.join("\n"));
}

function extractThinking(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "thinking") parts.push(b.thinking);
  }
  return parts.join("\n");
}

function extractToolCalls(
  blocks: ContentBlock[],
): Array<{ id: string; name: string; input: unknown }> {
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  for (const b of blocks) {
    if (b.type === "tool_use")
      calls.push({ id: b.id, name: b.name, input: truncateToolValue(b.input) });
  }
  return calls;
}

function extractToolResults(
  blocks: ContentBlock[] | string,
): Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> {
  if (typeof blocks === "string") return [];
  const out: Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> = [];
  for (const b of blocks) {
    if (b.type === "tool_result") {
      out.push({
        tool_use_id: b.tool_use_id,
        content: truncateToolValue(b.content),
        ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
      });
    }
  }
  return out;
}

function eventToChatMessage(
  event: UserEvent | AssistantEvent,
  opts: { includeThinking: boolean; includeToolCalls: boolean },
): ChatMessage | null {
  const role: "user" | "assistant" = event.type;
  const content = event.message.content;
  const text = extractText(content);
  const message: ChatMessage = {
    ts: event.timestamp,
    uuid: event.uuid,
    role,
    text,
  };

  if (role === "assistant" && Array.isArray(content)) {
    if (opts.includeThinking) {
      const thinking = extractThinking(content);
      if (thinking) message.thinking = thinking;
    }
    if (opts.includeToolCalls) {
      const calls = extractToolCalls(content);
      if (calls.length > 0) message.toolCalls = calls;
    }
  }

  if (role === "user" && opts.includeToolCalls) {
    const results = extractToolResults(content);
    if (results.length > 0) message.toolResults = results;
  }

  const hasText = message.text.length > 0;
  const hasThinking = !!message.thinking;
  const hasCalls = !!message.toolCalls && message.toolCalls.length > 0;
  const hasResults = !!message.toolResults && message.toolResults.length > 0;
  if (!hasText && !hasThinking && !hasCalls && !hasResults) return null;
  return message;
}

/**
 * Resolve `to` (peer id, name, or UUID) → SessionRef list.
 *
 * Strategy:
 *  1. Try active-peer resolution (id or name).
 *  2. If not found AND crossProject AND `to` looks like UUID:
 *     search across all projects via findSessions(uuid).
 *  3. Otherwise: peer_not_found.
 */
async function resolveSessionForRead(
  ctx: ServerContext,
  to: string,
  crossProject: boolean,
): Promise<
  | { ok: true; sessionId: string; peerName: string | null; sessions: SessionRef[] }
  | { ok: false; result: ToolResult }
> {
  const resolved = await resolveTargetPeer(ctx, to);
  if (resolved.ok) {
    const sessions = await findSessions(resolved.peer.id);
    if (sessions.length === 0) {
      return {
        ok: false,
        result: err(
          "session_file_not_found",
          `Peer ${resolved.peer.name} (${shortId(resolved.peer.id)}) has no session JSONL on disk yet`,
        ),
      };
    }
    return {
      ok: true,
      sessionId: resolved.peer.id,
      peerName: resolved.peer.name,
      sessions,
    };
  }

  if (resolved.code === "ambiguous_peer") {
    return {
      ok: false,
      result: err(
        "ambiguous_peer",
        `Multiple peers match name "${to}". Use peer id instead.`,
        resolved.candidates.map((c) => ({ id: c.id, name: c.name, cwd: c.cwd })),
      ),
    };
  }

  // peer_not_found — try cross-project lookup
  if (crossProject && UUID_RE.test(to)) {
    const sessions = await findSessions(to);
    if (sessions.length > 0) {
      return { ok: true, sessionId: to, peerName: null, sessions };
    }
  }

  return {
    ok: false,
    result: err(
      "peer_not_found",
      crossProject
        ? `No active peer and no session JSONL found for "${to}"`
        : `No active peer "${to}". Use crossProject:true to read dead sessions by UUID.`,
      {
        activePeers: resolved.activePeers.map(peerDiagShape),
        hint: PEER_NOT_FOUND_HINT,
      },
    ),
  };
}

interface SessionMeta {
  aiTitle?: string;
  customTitle?: string;
}

interface ChatReadMeta {
  peer: { id: string; name: string | null; aiTitle?: string };
  session: { project: string; file: string; modifiedAt: string; sizeBytes: number };
  scanned: {
    /** Every line in the file, counted raw. */
    totalEvents: number;
    /** Of those, the ones the schema models and the sweep could read. */
    eventsParsed: number;
    unmodelledTypes?: Record<string, number>;
    matchedMessages: number;
    queryMatches?: number;
  };
  truncated: { byLastN: boolean; byBytes: boolean; bySinceLastUserPrompt: boolean };
  query?: { text: string; regex: boolean; contextLines: number };
  returnedCount: number;
  bytes: number;
}

type QueryMatcher = { match: (s: string) => boolean } | { error: string };

function buildQueryMatcher(query: string, regex: boolean): QueryMatcher {
  if (regex) {
    try {
      const re = new RegExp(query, "i");
      return { match: (s) => re.test(s) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "invalid regex" };
    }
  }
  const lower = query.toLowerCase();
  return { match: (s) => s.toLowerCase().includes(lower) };
}

function timeOfDay(iso: string): string {
  // "2026-05-25T15:31:52.769Z" → "15:31:52"
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

function roleLetter(role: "user" | "assistant"): "U" | "A" {
  return role === "user" ? "U" : "A";
}

function indentBlock(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? prefix + l : l))
    .join("\n");
}

function formatTruncationNote(t: ChatReadMeta["truncated"]): string {
  const parts: string[] = [];
  if (t.byLastN) parts.push("lastN");
  if (t.byBytes) parts.push("bytes");
  if (t.bySinceLastUserPrompt) parts.push("sinceLastUserPrompt");
  return parts.length > 0 ? parts.join("+") : "none";
}

function formatMarkdown(meta: ChatReadMeta, messages: ChatMessage[]): string {
  const lines: string[] = [];
  const peerLabel = meta.peer.name ?? meta.peer.aiTitle ?? "(no name)";
  const peerShort = shortId(meta.peer.id);
  lines.push(`# Peer chat: ${peerLabel} \`${peerShort}\``);
  lines.push(
    `**Session:** \`${meta.session.file}\` (${Math.round(meta.session.sizeBytes / 1024)} KB, mod ${meta.session.modifiedAt})`,
  );
  lines.push(
    `**Scanned:** ${meta.scanned.totalEvents} events in file (${meta.scanned.eventsParsed} readable) → ${meta.scanned.matchedMessages} matched → returned ${meta.returnedCount} (truncated: ${formatTruncationNote(meta.truncated)})`,
  );
  if (meta.query) {
    const flavour = meta.query.regex ? "regex" : "substring";
    const ctx = meta.query.contextLines > 0 ? `, ±${meta.query.contextLines} ctx` : "";
    lines.push(
      `**Query:** \`${meta.query.text}\` (${flavour}${ctx}) → ${meta.scanned.queryMatches ?? 0} matches`,
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const m of messages) {
    lines.push(`## [${timeOfDay(m.ts)}] ${m.role} \`${shortId(m.uuid)}\``);
    lines.push("");
    if (m.text) {
      lines.push(m.text);
      lines.push("");
    }
    if (m.thinking) {
      lines.push("### thinking");
      lines.push(m.thinking);
      lines.push("");
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      lines.push("### tool_calls");
      for (const c of m.toolCalls) {
        lines.push(`- **${c.name}** \`${shortId(c.id)}\``);
        lines.push("  ```json");
        lines.push(indentBlock(JSON.stringify(c.input), "  "));
        lines.push("  ```");
      }
      lines.push("");
    }
    if (m.toolResults && m.toolResults.length > 0) {
      lines.push("### tool_results");
      for (const r of m.toolResults) {
        const flag = r.is_error ? " ⚠️ error" : "";
        lines.push(`- \`${shortId(r.tool_use_id)}\`${flag}`);
        const body = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
        lines.push(indentBlock(body, "  "));
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

function formatCompact(meta: ChatReadMeta, messages: ChatMessage[]): string {
  const peerLabel = meta.peer.name ?? meta.peer.aiTitle ?? "(no name)";
  const queryPart = meta.query
    ? ` | query: "${meta.query.text}" → ${meta.scanned.queryMatches ?? 0} matches`
    : "";
  const header = `peer: ${peerLabel} [${shortId(meta.peer.id)}] | ${meta.scanned.totalEvents} events (${meta.scanned.eventsParsed} readable), ${meta.scanned.matchedMessages} matched, ${meta.returnedCount} returned (trunc: ${formatTruncationNote(meta.truncated)})${queryPart}`;
  const lines: string[] = [header, ""];
  for (const m of messages) {
    const t = timeOfDay(m.ts);
    const role = roleLetter(m.role);
    const id = shortId(m.uuid);
    const text = m.text.replace(/\s+/g, " ").trim();
    const preview = text.length > 180 ? `${text.slice(0, 180)}…` : text;
    lines.push(`[${t}] ${role} ${id}: ${preview}`);
  }
  return lines.join("\n");
}

export async function peerChatReadTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerChatReadArgs>,
): Promise<ToolResult> {
  // Reading own session is legitimate after autocompact / /clear / long sessions
  // where on-disk JSONL holds detail no longer in the in-memory context window.
  // The original self_read block assumed "agent always has full context" which
  // doesn't hold in those scenarios. Caller decides what's worth re-loading.

  let sinceMs: number | null = null;
  if (args.sinceTimestamp) {
    sinceMs = Date.parse(args.sinceTimestamp);
    if (Number.isNaN(sinceMs)) {
      return err("invalid_timestamp", `Cannot parse sinceTimestamp "${args.sinceTimestamp}"`);
    }
  }

  const resolution = await resolveSessionForRead(ctx, args.to, args.crossProject);
  if (!resolution.ok) return resolution.result;

  // If multiple project copies of the session exist (sessionId migrated across cwd),
  // pick the most-recently-modified one.
  const sessionFile = resolution.sessions[0] as SessionRef;
  const rolesFilter = args.rolesOnly ? new Set(args.rolesOnly) : null;
  const lastN = args.lastN ?? 10;

  const messages: ChatMessage[] = [];
  const sessionMeta: SessionMeta = {};
  let totalEventsScanned = 0;
  let lastUserPromptIndex = -1;

  // The reported event count came from the loop below, which streams through
  // `parseSessionFile` — the VALIDATING parser. It drops every line the schema
  // rejects, and the schema models nine of the fourteen `type` discriminants a
  // live transcript carries, so the number was ~13% short of the file and
  // disagreed with anything counted off disk (MCP test 2026-08-04, #6; same
  // root cause as the session_stats undercount).
  //
  // Counting is now separate from parsing: raw for the file total, parsed for
  // the messages actually rendered. Two different questions, two numbers.
  const rawCounts = await countEventsByType(sessionFile.filePath);

  try {
    for await (const event of parseSessionFile(sessionFile.filePath)) {
      totalEventsScanned++;

      // Capture session-level metadata regardless of role filter
      if (event.type === "ai-title") {
        sessionMeta.aiTitle = event.aiTitle;
        continue;
      }
      if (event.type === "custom-title") {
        sessionMeta.customTitle = event.customTitle;
        continue;
      }

      if (event.type !== "user" && event.type !== "assistant") continue;
      if (rolesFilter && !rolesFilter.has(event.type)) continue;

      const eventTyped = event as UserEvent | AssistantEvent;
      if (sinceMs !== null) {
        const eventMs = Date.parse(eventTyped.timestamp);
        if (!Number.isNaN(eventMs) && eventMs < sinceMs) continue;
      }

      const chatMsg = eventToChatMessage(eventTyped, {
        includeThinking: args.includeThinking,
        includeToolCalls: args.includeToolCalls,
      });
      if (chatMsg) {
        messages.push(chatMsg);
        // Track the most recent real user prompt (text content, not just tool_result)
        if (chatMsg.role === "user" && chatMsg.text.length > 0) {
          lastUserPromptIndex = messages.length - 1;
        }
      }
    }
  } catch (e) {
    log.error("peer_chat_read_parse_err", {
      file: sessionFile.filePath,
      err: e instanceof Error ? e.message : String(e),
    });
    return err("session_parse_failed", e instanceof Error ? e.message : "unknown");
  }

  // Apply sinceLastUserPrompt — semantic anchor, runs before lastN
  let sinceLastUserPromptTrimmed = false;
  let working = messages;
  if (args.sinceLastUserPrompt && lastUserPromptIndex >= 0 && lastUserPromptIndex > 0) {
    working = messages.slice(lastUserPromptIndex);
    sinceLastUserPromptTrimmed = true;
  }

  // Apply query filter + contextLines expansion (within current working set)
  let queryMatchCount: number | undefined;
  if (args.query) {
    const matcher = buildQueryMatcher(args.query, args.queryRegex);
    if ("error" in matcher) {
      return err("invalid_query_regex", `Cannot compile regex: ${matcher.error}`);
    }
    const matchIndices: number[] = [];
    for (let i = 0; i < working.length; i++) {
      const msg = working[i] as ChatMessage;
      if (matcher.match(msg.text)) matchIndices.push(i);
    }
    queryMatchCount = matchIndices.length;
    if (matchIndices.length === 0) {
      working = [];
    } else if (args.contextLines === 0) {
      working = matchIndices.map((i) => working[i] as ChatMessage);
    } else {
      const keep = new Set<number>();
      for (const idx of matchIndices) {
        const start = Math.max(0, idx - args.contextLines);
        const end = Math.min(working.length - 1, idx + args.contextLines);
        for (let j = start; j <= end; j++) keep.add(j);
      }
      const sortedIndices = [...keep].sort((a, b) => a - b);
      working = sortedIndices.map((i) => working[i] as ChatMessage);
    }
  }

  // Apply lastN (chronologically — JSONL is append-order)
  let lastNTrimmed = false;
  let selected = working;
  if (working.length > lastN) {
    selected = working.slice(-lastN);
    lastNTrimmed = true;
  }

  // Apply byte cap — drop oldest first
  let bytesTrimmed = false;
  let totalBytes = 0;
  const kept: ChatMessage[] = [];
  for (let i = selected.length - 1; i >= 0; i--) {
    const msg = selected[i] as ChatMessage;
    const msgBytes = Buffer.byteLength(JSON.stringify(msg), "utf-8");
    if (totalBytes + msgBytes > args.maxBytes && kept.length > 0) {
      bytesTrimmed = true;
      break;
    }
    totalBytes += msgBytes;
    kept.push(msg);
  }
  kept.reverse();

  const meta: ChatReadMeta = {
    peer: {
      id: resolution.sessionId,
      name: resolution.peerName,
      ...(sessionMeta.aiTitle ? { aiTitle: sessionMeta.aiTitle } : {}),
    },
    session: {
      project: sessionFile.projectDir,
      file: sessionFile.filePath,
      modifiedAt: sessionFile.modifiedAt.toISOString(),
      sizeBytes: sessionFile.sizeBytes,
    },
    scanned: {
      /** Every line in the file, counted raw — matches `wc -l`. */
      totalEvents: rawCounts.total,
      /** Of those, the ones this plugin's schema models and the sweep could read. */
      eventsParsed: totalEventsScanned,
      /** Types Claude Code writes that the schema does not model. Empty is normal. */
      unmodelledTypes: rawCounts.unmodelledTypes,
      matchedMessages: messages.length,
      ...(queryMatchCount !== undefined ? { queryMatches: queryMatchCount } : {}),
    },
    truncated: {
      byLastN: lastNTrimmed,
      byBytes: bytesTrimmed,
      bySinceLastUserPrompt: sinceLastUserPromptTrimmed,
    },
    ...(args.query
      ? {
          query: { text: args.query, regex: args.queryRegex, contextLines: args.contextLines },
        }
      : {}),
    returnedCount: kept.length,
    bytes: totalBytes,
  };

  if (args.format === "markdown") return okText(formatMarkdown(meta, kept));
  if (args.format === "compact") return okText(formatCompact(meta, kept));
  return ok({ ...meta, messages: kept });
}

// ============================================================================
// peer_chat_search — cross-session, in-project (and optionally cross-project)
// ============================================================================

const SEARCH_MAX_AGE_DAYS = 30;
const SEARCH_MAX_BYTES_SCANNED = 200 * 1024 * 1024; // 200 MB soft cap

export const PeerChatSearchArgs = z
  .object({
    query: z.string().min(1),
    queryRegex: z.boolean().default(false),
    scope: z.enum(["project", "all-projects"]).default("project"),
    contextLines: z.number().int().min(0).max(10).default(1),
    maxMatches: z.number().int().positive().max(500).default(30),
    maxBytes: z.number().int().positive().max(1_000_000).default(30_000),
    includeSelf: z.boolean().default(true),
  })
  .strict();

interface SearchMatchEntry {
  session: SessionRef;
  aiTitle?: string;
  message: { ts: string; uuid: string; role: "user" | "assistant"; text: string };
  context: Array<{ ts: string; uuid: string; role: "user" | "assistant"; text: string }>;
}

/**
 * Resolve sessions in scope, sort by mtime desc, drop ones older than maxAgeDays.
 *
 * The caller's own session IS included — after autocompact / /clear / long
 * sessions, the on-disk JSONL holds detail no longer in the in-memory context
 * window, and searching it is a legitimate recovery path.
 */
/**
 * Sessions in scope for a search.
 *
 * `selfId` is excluded only when the caller asks. Until 2026-08-04 the tool
 * description claimed "Self session is excluded (already in context)" and no
 * code anywhere did that — the claim was simply false. Rather than make the
 * code match the claim, the claim was dropped: the premise is wrong. After an
 * autocompact or a `/clear`, a peer's own transcript holds a great deal that is
 * no longer in its context, which is exactly why `peer_chat_read` allows
 * reading it. Searching it is the same case, so self is included by default and
 * labelled in the output, and `includeSelf: false` is there for callers who
 * genuinely want only other sessions.
 */
async function resolveSearchSessions(
  scope: "project" | "all-projects",
  selfId?: string,
): Promise<SessionRef[]> {
  const cutoffMs = Date.now() - SEARCH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  let sessions: SessionRef[];
  if (scope === "all-projects") {
    sessions = await listAllSessions();
  } else {
    // current project = encoded process.cwd()
    const currentProjectDir = encodeProjectDir(process.cwd());
    const allProjects = await listProjects();
    const matching = allProjects.find((p) => p.projectDir === currentProjectDir);
    sessions = matching ? await listSessionsInProject(matching) : [];
  }

  const fresh = sessions.filter((s) => s.modifiedAt.getTime() >= cutoffMs);
  return selfId ? fresh.filter((s) => s.sessionId !== selfId) : fresh;
}

const PREFILTER_CHUNK_BYTES = 256 * 1024;
/**
 * Characters carried between chunks so a match straddling the seam is still
 * found. Any query shorter than this behaves exactly as it did when the whole
 * file was one string — which is every realistic query; the substring matcher
 * is capped well below it by the tool's own arg schema.
 */
const PREFILTER_OVERLAP_CHARS = 1024;

/**
 * Stage-1 reject filter, streamed (fix, 2026-08-03).
 *
 * This used to read the entire transcript into one string and then call
 * `toLowerCase()` on it, which V8 cannot do in place — so a 200 MB session cost
 * two full copies. Measured on the real corpus: 454 MB after the read, 1317 MB
 * peak after the lowercase, for a single `peer_chat_search` call. The string
 * was also still reachable while stage 2 streamed the same file again, so both
 * representations were live at once. Nothing bounded concurrent calls, either.
 *
 * Now: fixed-size chunks, an overlap so seam matches survive, and an early
 * return the moment the matcher hits — a match in the first megabyte no longer
 * pays for the remaining 199. Memory is constant regardless of file size.
 *
 * Returns null on read error (file deleted mid-scan, permission denied), which
 * the caller treats as "skip this session" exactly as before.
 */
async function fileMatchesPrefilter(
  filePath: string,
  matcher: (text: string) => boolean,
): Promise<boolean | null> {
  const { open } = await import("node:fs/promises");
  const { StringDecoder } = await import("node:string_decoder");
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(filePath, "r");
  } catch {
    return null;
  }
  const decoder = new StringDecoder("utf8");
  try {
    const buf = Buffer.allocUnsafe(PREFILTER_CHUNK_BYTES);
    let carry = "";
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      const text = carry + decoder.write(buf.subarray(0, bytesRead));
      if (matcher(text)) return true;
      carry = text.length > PREFILTER_OVERLAP_CHARS ? text.slice(-PREFILTER_OVERLAP_CHARS) : text;
    }
    const tail = carry + decoder.end();
    return tail.length > 0 ? matcher(tail) : false;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

function buildPrefilter(query: string, regex: boolean): ((text: string) => boolean) | string {
  if (regex) {
    try {
      const re = new RegExp(query, "i");
      return (s: string) => re.test(s);
    } catch (e) {
      return e instanceof Error ? e.message : "invalid regex";
    }
  }
  const lower = query.toLowerCase();
  return (s: string) => s.toLowerCase().includes(lower);
}

export async function peerChatSearchTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerChatSearchArgs>,
): Promise<ToolResult> {
  // Compile query matcher early so we can reject bad regex up front.
  const prefilter = buildPrefilter(args.query, args.queryRegex);
  if (typeof prefilter === "string") {
    return err("invalid_query_regex", `Cannot compile regex: ${prefilter}`);
  }
  // Same matcher used per-event after JSON.parse (operates on extracted text).
  const eventMatcher = buildQueryMatcher(args.query, args.queryRegex);
  if ("error" in eventMatcher) {
    return err("invalid_query_regex", `Cannot compile regex: ${eventMatcher.error}`);
  }

  const sessions = await resolveSearchSessions(
    args.scope,
    args.includeSelf ? undefined : ctx.self.id,
  );
  if (sessions.length === 0) {
    return okText(
      `# Search: \`${args.query}\`\n\n**Scope:** ${args.scope}\n**Total matches:** 0 (no sessions in scope after maxAgeDays=${SEARCH_MAX_AGE_DAYS} filter)`,
    );
  }

  const totalBytesScope = sessions.reduce((sum, s) => sum + s.sizeBytes, 0);
  if (totalBytesScope > SEARCH_MAX_BYTES_SCANNED) {
    return err(
      "scope_too_large",
      // The advice has to depend on where the caller already is. Telling someone
      // on scope='project' to "use scope='project'" is the tool not reading its
      // own arguments (plt-designer, 2026-08-04 — /opt/hmh is 824 MB and the
      // project scope is already the narrow one).
      args.scope === "all-projects"
        ? `Filtered scope is ${Math.round(totalBytesScope / 1024 / 1024)} MB across ${sessions.length} sessions — over the ${Math.round(SEARCH_MAX_BYTES_SCANNED / 1024 / 1024)} MB cap. Narrow it with scope='project'.`
        : `This project alone is ${Math.round(totalBytesScope / 1024 / 1024)} MB across ${sessions.length} sessions — over the ${Math.round(SEARCH_MAX_BYTES_SCANNED / 1024 / 1024)} MB cap, and scope='project' is already the narrowest scope there is. Search one session with peer_chat_read instead (same query, no cap), or wait for the FTS5 backend.`,
    );
  }

  const startMs = Date.now();
  const matches: SearchMatchEntry[] = [];
  let sessionsExamined = 0;
  let sessionsHit = 0;
  let bytesScanned = 0;
  // Sessions never looked at because maxMatches was reached first. Reported,
  // because "0 matches in the rest" and "never opened the rest" are different
  // answers and the old output could not tell them apart (fix, 2026-08-04).
  let sessionsNotReached = 0;

  for (const session of sessions) {
    if (matches.length >= args.maxMatches) {
      sessionsNotReached++;
      continue;
    }
    sessionsExamined++;
    bytesScanned += session.sizeBytes;

    // Stage 1: streamed pre-filter — fast reject without JSON parsing, and
    // without ever holding the transcript in memory.
    const hit = await fileMatchesPrefilter(session.filePath, prefilter);
    if (hit === null || !hit) continue;
    sessionsHit++;

    // Stage 2: stream parse, collect text events + meta
    const sessionMessages: SearchMatchEntry["message"][] = [];
    let aiTitle: string | undefined;
    try {
      for await (const event of parseSessionFileRaw(session.filePath)) {
        if (event.type === "ai-title" && typeof event.aiTitle === "string") {
          aiTitle = event.aiTitle;
          continue;
        }
        if (event.type !== "user" && event.type !== "assistant") continue;
        if (!event.uuid || !event.timestamp) continue;

        const content = event.message?.content;
        // Extract text only — search ignores tool blocks (per architect review)
        const text = extractText(
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? (content as ContentBlock[])
              : "",
        );
        if (!text) continue;
        sessionMessages.push({
          ts: event.timestamp,
          uuid: event.uuid,
          role: event.type,
          text,
        });
      }
    } catch (e) {
      log.warn("peer_chat_search_parse_warning", {
        file: session.filePath,
        err: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    // Stage 3: find matching messages, expand with contextLines
    const matchIndices = sessionMessages
      .map((m, i) => (eventMatcher.match(m.text) ? i : -1))
      .filter((i) => i >= 0);

    for (const idx of matchIndices) {
      if (matches.length >= args.maxMatches) break;
      const start = Math.max(0, idx - args.contextLines);
      const end = Math.min(sessionMessages.length - 1, idx + args.contextLines);
      const context: SearchMatchEntry["context"] = [];
      for (let j = start; j <= end; j++) {
        if (j === idx) continue;
        const ctxMsg = sessionMessages[j];
        if (ctxMsg) context.push(ctxMsg);
      }
      const matchMsg = sessionMessages[idx];
      if (!matchMsg) continue;
      matches.push({
        session,
        ...(aiTitle ? { aiTitle } : {}),
        message: matchMsg,
        context,
      });
    }
  }

  const elapsedMs = Date.now() - startMs;
  const truncated = matches.length >= args.maxMatches;

  return okText(
    renderSearchMarkdown(args, matches, {
      sessionsInScope: sessions.length,
      sessionsExamined,
      sessionsNotReached,
      sessionsHit,
      bytesScanned,
      selfIncluded: args.includeSelf,
      selfId: ctx.self.id,
      elapsedMs,
      truncated,
      maxBytes: args.maxBytes,
    }),
  );
}

interface SearchRenderMeta {
  sessionsInScope: number;
  /** Sessions actually opened. Lower than `sessionsInScope` when maxMatches cut the sweep short. */
  sessionsExamined: number;
  /** Sessions in scope the sweep never opened, because maxMatches was already reached. */
  sessionsNotReached: number;
  /** Of those examined, how many contained the query at all. */
  sessionsHit: number;
  bytesScanned: number;
  selfIncluded: boolean;
  selfId: string;
  elapsedMs: number;
  truncated: boolean;
  maxBytes: number;
}

function renderSearchMarkdown(
  args: z.infer<typeof PeerChatSearchArgs>,
  matches: SearchMatchEntry[],
  meta: SearchRenderMeta,
): string {
  const lines: string[] = [];
  const flavour = args.queryRegex ? "regex" : "substring";
  lines.push(`# Search: \`${args.query}\` (${flavour}, scope=${args.scope})`);
  // `Hits: X/Y` used to leave the reader guessing what Y was — it was neither
  // the scope nor the sessions with a match, but however many the loop got
  // through before maxMatches stopped it. Each number is now named (2026-08-04).
  lines.push(
    `**Scope:** ${meta.sessionsInScope} sessions in scope, ${meta.sessionsExamined} examined (${Math.round(meta.bytesScanned / 1024 / 1024)} MB) in ${meta.elapsedMs} ms`,
  );
  lines.push(
    `**Hits:** ${matches.length} matches in ${meta.sessionsHit} of the ${meta.sessionsExamined} sessions examined${meta.truncated ? " (truncated at maxMatches)" : ""}`,
  );
  if (meta.sessionsNotReached > 0) {
    lines.push(
      `**⚠ Incomplete:** stopped at maxMatches=${args.maxMatches} — ${meta.sessionsNotReached} sessions in scope were never opened. Raise maxMatches or narrow the query to see the rest.`,
    );
  }
  lines.push(
    meta.selfIncluded
      ? "**Self:** this peer's own session is included and marked `(self)` below."
      : "**Self:** this peer's own session is excluded (`includeSelf: false`).",
  );
  lines.push("");

  if (matches.length === 0) {
    lines.push("---");
    lines.push("");
    lines.push("No matches found. Try a broader query or `scope='all-projects'`.");
    return lines.join("\n");
  }

  // Group by session, render in scan order
  const grouped = new Map<string, SearchMatchEntry[]>();
  for (const m of matches) {
    const key = m.session.sessionId;
    const list = grouped.get(key);
    if (list) list.push(m);
    else grouped.set(key, [m]);
  }

  let totalBytes = 0;
  let bytesTruncated = false;
  for (const [, sessionMatches] of grouped) {
    if (sessionMatches.length === 0) continue;
    const first = sessionMatches[0];
    if (!first) continue;
    const sess = first.session;
    const label = first.aiTitle ?? `session ${shortId(sess.sessionId)}`;
    // Mark the caller's own transcript. It is in scope by default and that is
    // deliberate, but a reader must be able to tell "I already knew this" from
    // "another peer said this" at a glance.
    const selfTag = sess.sessionId === meta.selfId ? " *(self)*" : "";
    const sessionLines: string[] = [];
    sessionLines.push("---");
    sessionLines.push("");
    sessionLines.push(
      `## ${label} \`${shortId(sess.sessionId)}\`${selfTag} — ${sessionMatches.length} match${sessionMatches.length === 1 ? "" : "es"}`,
    );
    sessionLines.push(`**Project:** \`${sess.projectDir}\` | mod ${sess.modifiedAt.toISOString()}`);
    sessionLines.push("");

    for (const m of sessionMatches) {
      // Render context messages (before)
      for (const c of m.context.filter((c) => c.ts < m.message.ts)) {
        sessionLines.push(`### [${timeOfDay(c.ts)}] ${c.role} \`${shortId(c.uuid)}\` _(context)_`);
        sessionLines.push(c.text);
        sessionLines.push("");
      }
      // Render match (highlighted)
      sessionLines.push(
        `### [${timeOfDay(m.message.ts)}] ${m.message.role} \`${shortId(m.message.uuid)}\` **← match**`,
      );
      sessionLines.push(m.message.text);
      sessionLines.push("");
      // Render context messages (after)
      for (const c of m.context.filter((c) => c.ts > m.message.ts)) {
        sessionLines.push(`### [${timeOfDay(c.ts)}] ${c.role} \`${shortId(c.uuid)}\` _(context)_`);
        sessionLines.push(c.text);
        sessionLines.push("");
      }
    }

    const sessionText = sessionLines.join("\n");
    const sessionBytes = Buffer.byteLength(sessionText, "utf-8");
    if (totalBytes + sessionBytes > meta.maxBytes && lines.length > 4) {
      bytesTruncated = true;
      break;
    }
    totalBytes += sessionBytes;
    lines.push(sessionText);
  }

  if (bytesTruncated) {
    lines.push("");
    lines.push(`_(output truncated at maxBytes=${meta.maxBytes}; refine query to see more)_`);
  }

  return lines.join("\n").trimEnd();
}

// ============================================================================
// Piggyback consumption
// ============================================================================

const PIGGYBACK_EXCLUDED = new Set(["peer_inbox_read"]);

function formatSender(m: MessageEnvelope): string {
  if (m.fromName) return `${m.fromName} (${shortId(m.from)})`;
  return shortId(m.from);
}

function formatInboxBlock(messages: MessageEnvelope[], echoed: Set<string> = new Set()): string {
  if (messages.length === 0) return "";
  const lines: string[] = [];
  lines.push(`─── 📬 INBOX (${messages.length} new) ───`);
  for (const m of messages) {
    const ts = m.sentAt.slice(11, 19); // HH:MM:SS
    lines.push("");
    const echo = echoed.has(m.id) ? " [already pushed to channel]" : "";
    lines.push(`[${m.id}] from ${formatSender(m)} (${m.kind}) at ${ts}${echo}:`);
    lines.push(`  ${m.content.split("\n").join("\n  ")}`);
    if (m.inReplyTo) lines.push(`  in_reply_to: ${m.inReplyTo}`);
    if (m.threadId) lines.push(`  thread: ${m.threadId}`);
  }
  lines.push("");
  lines.push("(use peer_reply with inReplyTo=<msg-id> to respond)");
  lines.push("─────────────────────────");
  return lines.join("\n");
}

/**
 * Piggyback consumption: after a successful tool call, drain own inbox.
 *
 * Two responsibilities, kept separate:
 *  1. State management — always move pending → done so inbox doesn't accumulate.
 *  2. Output dedup — only append to result block messages NOT already delivered
 *     via push channel (tracked in ctx.pushedMsgIds). Avoids the duplicate
 *     "<channel> tag in context + piggyback INBOX block" seen by the agent.
 */
export async function piggybackInbox(
  ctx: ServerContext,
  toolName: string,
  result: ToolResult,
): Promise<ToolResult> {
  if (PIGGYBACK_EXCLUDED.has(toolName)) return result;
  if (result.isError) return result;
  const pending = await ctx.inbox.listPending(ctx.self.id);
  if (pending.length === 0) return result;

  const consumedForBlock: MessageEnvelope[] = [];
  const echoed = new Set<string>();
  for (const p of pending) {
    const c = await ctx.inbox.consume(ctx.self.id, p.id);
    if (!c) continue;
    // v0.10.2 fix — a message that `pushedMsgIds` claims was delivered is
    // STILL shown here, just marked.
    //
    // The old code skipped it entirely, on the reasoning that the agent had
    // already seen it as a `<channel>` notification and a second copy is
    // noise. That reasoning rests on `channel.push()` returning
    // `delivered: true` — which only means the notification call did not
    // throw. It says nothing about whether Claude Code rendered anything.
    //
    // On 2026-08-04 it didn't: mid-migration, a peer on the renamed plugin
    // identity had its notifications dropped silently. Push "succeeded", the
    // id went into pushedMsgIds, piggyback then archived the message to
    // done/ and omitted it from the block. The message was gone — present on
    // disk, invisible to the agent, and `peer_inbox_read` answered count: 0.
    // Evidence: msg msdv3vmc, sent 23:30:24, ctime in done/ 23:34:04.
    //
    // The delivery test cannot belong to the component doing the delivering.
    // Until a receiver-side acknowledgement exists, the safe default is to
    // show it: a duplicate line is an annoyance, a lost message is data loss.
    if (ctx.pushedMsgIds.delete(c.id)) echoed.add(c.id);
    consumedForBlock.push(c);
  }

  const block = formatInboxBlock(consumedForBlock, echoed);
  if (!block) return result;
  return {
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    content: [...result.content, { type: "text", text: block }],
  };
}

// ============================================================================
// peer_context_status — read autocompact-relevant statistics from peer JSONL
// ============================================================================

export const PeerContextStatusArgs = z
  .object({
    to: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();

interface ContextStatusEntry {
  id: string;
  name: string | null;
  isSelf: boolean;
  /** True when any live source (statusLine capture OR JSONL scan) produced
   * data (v0.9.4+). When false, contextLimit/tokensUsed/percentUsed are
   * zero and `setupPointer` guides the user through setup. */
  hasLiveData: boolean;
  model: string | null;
  contextLimit: number;
  /** How the contextLimit was derived (v0.9.4+, three values):
   *  - "statusline-stdin"  — statusLine capture, autoritative from CC API mirror
   *  - "jsonl-canonical"   — JSONL last-assistant-event sum + canonical
   *                          model lookup (fallback path, deterministic when
   *                          model is known — see `contextLimitCaveat`)
   *  - "no-live-data"      — neither source available */
  contextLimitSource: ContextLimitSource;
  /** Caveat inside the `jsonl-canonical` branch — omitted for `statusline-stdin`
   * (authoritative). Values: `canonical-match` (trust full), `empirical-guess-1m`
   * (⚠ tokens>200k → assumed 1M), `unknown-model-default-200k` (⚠ percentUsed
   * may be inflated for a genuine 1M model). */
  contextLimitCaveat?: ContextLimitCaveat;
  tokensUsed: number;
  tokensRemaining: number;
  percentUsed: number;
  autocompactRisk: "low" | "medium" | "high" | "unknown";
  lastTurnAt: string | null;
  /** True when JSONL indicates an in-flight turn (last event is user
   * postdating last assistant); tokensUsed is a lower bound. Null in
   * statusLine path (statusLine reflects the request-time snapshot). */
  turnInProgress: boolean | null;
  /** Live-data extras from statusLine (v0.9.0+). Null in JSONL branch. */
  effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | null;
  claudeCodeVersion: string | null;
  /** Setup instruction pointer when hasLiveData=false. Omitted otherwise. */
  setupPointer?: string;
  guard?: ContextGuardConfig;
}

async function buildContextStatusEntry(
  ctx: ServerContext,
  peerId: string,
  peerName: string | null,
): Promise<ContextStatusEntry> {
  const isSelf = peerId === ctx.self.id;
  const guard = await readContextGuard(peerId);

  // v0.9.4: resolve SessionRef with filePath so JSONL fallback can scan
  // the actual JSONL when statusLine capture is missing. Uses findSessions
  // to locate the peer's session file on disk (may return multiple copies
  // across projects; use most-recently-modified — the ordering guarantee
  // of findSessions).
  const sessions = await findSessions(peerId);
  const usage: ContextUsage | null =
    sessions.length > 0
      ? await readContextUsageForSession(sessions)
      : // No session file yet, but statusLine capture might still exist —
        // try with a minimal SessionRef so at least the statusLine path runs.
        await readContextUsageForSession([{ sessionId: peerId, filePath: "" } as never]);

  if (!usage) {
    const placeholder = noLiveDataStatus();
    return {
      id: peerId,
      name: peerName,
      isSelf,
      hasLiveData: false,
      model: null,
      contextLimit: 0,
      contextLimitSource: "no-live-data",
      tokensUsed: 0,
      tokensRemaining: 0,
      percentUsed: 0,
      autocompactRisk: "unknown",
      lastTurnAt: null,
      turnInProgress: null,
      effortLevel: null,
      claudeCodeVersion: null,
      ...(placeholder.setupPointer ? { setupPointer: placeholder.setupPointer } : {}),
      ...(guard ? { guard } : {}),
    };
  }

  return {
    id: peerId,
    name: peerName,
    isSelf,
    hasLiveData: usage.hasLiveData,
    model: usage.model,
    contextLimit: usage.contextLimit,
    contextLimitSource: usage.contextLimitSource,
    ...(usage.contextLimitCaveat ? { contextLimitCaveat: usage.contextLimitCaveat } : {}),
    tokensUsed: usage.tokensUsed,
    tokensRemaining: usage.tokensRemaining,
    percentUsed: Math.round(usage.percentUsed * 1000) / 1000,
    autocompactRisk: usage.autocompactRisk,
    lastTurnAt: usage.lastTurnAt,
    turnInProgress: usage.turnInProgress,
    effortLevel: usage.effortLevel,
    claudeCodeVersion: usage.claudeCodeVersion,
    ...(usage.setupPointer ? { setupPointer: usage.setupPointer } : {}),
    ...(guard ? { guard } : {}),
  };
}

export async function peerContextStatusTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerContextStatusArgs>,
): Promise<ToolResult> {
  try {
    const targets: { id: string; name: string | null }[] = [];

    const toArg = args.to;
    if (toArg === undefined) {
      targets.push({ id: ctx.self.id, name: ctx.self.name });
    } else if (typeof toArg === "string" && toArg === "all") {
      const peers = await ctx.registry.listActivePeers();
      const seen = new Set<string>();
      for (const p of peers) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        targets.push({ id: p.id, name: p.name });
      }
      if (!seen.has(ctx.self.id)) {
        targets.push({ id: ctx.self.id, name: ctx.self.name });
      }
    } else {
      const list = Array.isArray(toArg) ? toArg : [toArg];
      const peers = await ctx.registry.listActivePeers();
      const activePeers: ActivePeer[] = peers;
      for (const item of list) {
        const normalized = item === "self" ? ctx.self.id : item;
        const byId = activePeers.find((p) => p.id === normalized);
        if (byId) {
          targets.push({ id: byId.id, name: byId.name });
          continue;
        }
        // Same resolution as every other tool — full name, then short form in
        // the caller's team, then a globally unique short form. This site used
        // to match only on the full name, so `velitel` answered `peer_not_found`
        // here while the daemon's tools answered `ambiguous_peer` with the three
        // candidates. One convention has to mean one thing whichever tool asks.
        const resolved = await resolveTargetPeer(ctx, normalized);
        if (resolved.ok) {
          targets.push({ id: resolved.peer.id, name: resolved.peer.name });
          continue;
        }
        if (resolved.code === "ambiguous_peer") {
          return err(
            "ambiguous_peer",
            `"${normalized}" matches ${resolved.candidates.length} peers — refusing to guess. Use the full name: ${resolved.candidates.map((c) => c.name).join(", ")}`,
            resolved.candidates.map((c) => ({ id: c.id, name: c.name, cwd: c.cwd })),
          );
        }
        // Allow UUID fallback even if not active (= dead session, JSONL may still exist)
        if (UUID_RE.test(normalized)) {
          targets.push({ id: normalized, name: null });
          continue;
        }
        return err("peer_not_found", `No active peer "${normalized}" and not a UUID`, {
          activePeers: activePeers.map(peerDiagShape),
          hint: PEER_NOT_FOUND_HINT,
        });
      }
    }

    const peers: ContextStatusEntry[] = [];
    for (const t of targets) {
      peers.push(await buildContextStatusEntry(ctx, t.id, t.name));
    }

    return ok({ count: peers.length, peers });
  } catch (e) {
    log.error("peer_context_status_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("peer_context_status_failed", e instanceof Error ? e.message : "unknown");
  }
}

// ============================================================================
// peer_set_context_guard — self-write guard config (thresholds + notify routes)
// ============================================================================

export interface ContextGuardConfig {
  enabled: boolean;
  warnAtPercent: number;
  criticalAtPercent: number;
  notifyPeerIds: string[];
  broadcastProject: boolean;
}

const DEFAULT_GUARD_CONFIG: ContextGuardConfig = {
  enabled: true,
  warnAtPercent: 0.85,
  criticalAtPercent: 0.95,
  notifyPeerIds: [],
  broadcastProject: false,
};

export const PeerSetContextGuardArgs = z
  .object({
    enabled: z.boolean().optional(),
    warnAtPercent: z.number().min(0).max(1).optional(),
    criticalAtPercent: z.number().min(0).max(1).optional(),
    notifyPeerIds: z.array(z.string()).optional(),
    broadcastProject: z.boolean().optional(),
  })
  .strict();

function guardConfigFile(peerId: string): string {
  return join(bridgeRoot(), "guard", `${peerId}.json`);
}

export async function readContextGuard(peerId: string): Promise<ContextGuardConfig | undefined> {
  try {
    const raw = await readFile(guardConfigFile(peerId), "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_GUARD_CONFIG, ...parsed };
  } catch {
    return undefined;
  }
}

async function writeContextGuard(peerId: string, cfg: ContextGuardConfig): Promise<void> {
  const file = guardConfigFile(peerId);
  await mkdir(join(bridgeRoot(), "guard"), { recursive: true });
  await atomicWriteJson(file, cfg);
}

export async function peerSetContextGuardTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerSetContextGuardArgs>,
): Promise<ToolResult> {
  try {
    const current = (await readContextGuard(ctx.self.id)) ?? DEFAULT_GUARD_CONFIG;
    const next: ContextGuardConfig = {
      enabled: args.enabled ?? current.enabled,
      warnAtPercent: args.warnAtPercent ?? current.warnAtPercent,
      criticalAtPercent: args.criticalAtPercent ?? current.criticalAtPercent,
      notifyPeerIds: args.notifyPeerIds ?? current.notifyPeerIds,
      broadcastProject: args.broadcastProject ?? current.broadcastProject,
    };

    if (next.warnAtPercent > next.criticalAtPercent) {
      return err(
        "invalid_thresholds",
        `warnAtPercent (${next.warnAtPercent}) must be <= criticalAtPercent (${next.criticalAtPercent})`,
      );
    }

    await writeContextGuard(ctx.self.id, next);
    return ok({ guard: next, sessionId: ctx.self.id });
  } catch (e) {
    log.error("peer_set_context_guard_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("peer_set_context_guard_failed", e instanceof Error ? e.message : "unknown");
  }
}

// ============================================================================
// peer_set_notification — self-write notification config (beep on idle)
// ============================================================================

export interface NotificationConfig {
  enabled: boolean;
  minIdleSeconds: number;
}

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: false,
  minIdleSeconds: 30,
};

export const PeerSetNotificationArgs = z
  .object({
    enabled: z.boolean().optional(),
    minIdleSeconds: z.number().int().min(5).max(3600).optional(),
  })
  .strict();

function notificationConfigFile(peerId: string): string {
  return join(bridgeRoot(), "notify", `${peerId}.json`);
}

export async function readNotificationConfig(
  peerId: string,
): Promise<NotificationConfig | undefined> {
  try {
    const raw = await readFile(notificationConfigFile(peerId), "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_NOTIFICATION_CONFIG, ...parsed };
  } catch {
    return undefined;
  }
}

async function writeNotificationConfig(peerId: string, cfg: NotificationConfig): Promise<void> {
  const file = notificationConfigFile(peerId);
  await mkdir(join(bridgeRoot(), "notify"), { recursive: true });
  await atomicWriteJson(file, cfg);
}

export async function peerSetNotificationTool(
  ctx: ServerContext,
  args: z.infer<typeof PeerSetNotificationArgs>,
): Promise<ToolResult> {
  try {
    const current = (await readNotificationConfig(ctx.self.id)) ?? DEFAULT_NOTIFICATION_CONFIG;
    const next: NotificationConfig = {
      enabled: args.enabled ?? current.enabled,
      minIdleSeconds: args.minIdleSeconds ?? current.minIdleSeconds,
    };

    await writeNotificationConfig(ctx.self.id, next);
    return ok({ notification: next, sessionId: ctx.self.id });
  } catch (e) {
    log.error("peer_set_notification_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("peer_set_notification_failed", e instanceof Error ? e.message : "unknown");
  }
}

// ============================================================================
// rate_limit_status — account-scoped rate limits (5h session + 7d weekly + spend)
// ============================================================================

export const RateLimitStatusArgs = z.object({}).strict();

export async function rateLimitStatusTool(): Promise<ToolResult> {
  try {
    const status = await readLiveRateLimits();
    const guard = await readRateLimitGuard();
    return ok({ ...status, ...(guard ? { guard } : {}) });
  } catch (e) {
    log.error("rate_limit_status_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("rate_limit_status_failed", e instanceof Error ? e.message : "unknown");
  }
}

// ============================================================================
// peer_set_rate_limit_guard — user-wide guard config (v0.9.0-beta+)
// Analog to peer_set_context_guard but for rate limits. Since rate limits
// are USER-scoped (all peers on the account share one), the guard config
// is stored in ~/.claude-bridge/guard-rate-limits.json (not per-session).
// ============================================================================

export interface RateLimitGuardConfig {
  enabled: boolean;
  /** Warn threshold for session (5h) utilization, 0-1. Default 0.85. */
  sessionWarnAtPercent: number;
  /** Critical threshold for session utilization, 0-1. Default 0.95. */
  sessionCriticalAtPercent: number;
  /** Warn threshold for week utilization, 0-1. Default 0.75. Weekly caps
   * hurt more (7-day recovery vs 5h) so bar for concern is lower. */
  weekWarnAtPercent: number;
  /** Critical threshold for week utilization, 0-1. Default 0.90. */
  weekCriticalAtPercent: number;
  /** Peer ids to notify on threshold crossing (broadcast to sibling chats). */
  notifyPeerIds: string[];
}

const DEFAULT_RATE_LIMIT_GUARD_CONFIG: RateLimitGuardConfig = {
  enabled: true,
  sessionWarnAtPercent: 0.85,
  sessionCriticalAtPercent: 0.95,
  weekWarnAtPercent: 0.75,
  weekCriticalAtPercent: 0.9,
  notifyPeerIds: [],
};

function rateLimitGuardFile(): string {
  return join(bridgeRoot(), "guard-rate-limits.json");
}

export async function readRateLimitGuard(): Promise<RateLimitGuardConfig | undefined> {
  try {
    const raw = await readFile(rateLimitGuardFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_RATE_LIMIT_GUARD_CONFIG, ...parsed };
  } catch {
    return undefined;
  }
}

async function writeRateLimitGuard(cfg: RateLimitGuardConfig): Promise<void> {
  const file = rateLimitGuardFile();
  await mkdir(bridgeRoot(), { recursive: true });
  await atomicWriteJson(file, cfg);
}

export const PeerSetRateLimitGuardArgs = z
  .object({
    enabled: z.boolean().optional(),
    sessionWarnAtPercent: z.number().min(0).max(1).optional(),
    sessionCriticalAtPercent: z.number().min(0).max(1).optional(),
    weekWarnAtPercent: z.number().min(0).max(1).optional(),
    weekCriticalAtPercent: z.number().min(0).max(1).optional(),
    notifyPeerIds: z.array(z.string()).optional(),
  })
  .strict();

export async function peerSetRateLimitGuardTool(
  _ctx: ServerContext,
  args: z.infer<typeof PeerSetRateLimitGuardArgs>,
): Promise<ToolResult> {
  try {
    const current = (await readRateLimitGuard()) ?? DEFAULT_RATE_LIMIT_GUARD_CONFIG;
    const next: RateLimitGuardConfig = {
      enabled: args.enabled ?? current.enabled,
      sessionWarnAtPercent: args.sessionWarnAtPercent ?? current.sessionWarnAtPercent,
      sessionCriticalAtPercent: args.sessionCriticalAtPercent ?? current.sessionCriticalAtPercent,
      weekWarnAtPercent: args.weekWarnAtPercent ?? current.weekWarnAtPercent,
      weekCriticalAtPercent: args.weekCriticalAtPercent ?? current.weekCriticalAtPercent,
      notifyPeerIds: args.notifyPeerIds ?? current.notifyPeerIds,
    };

    if (next.sessionWarnAtPercent > next.sessionCriticalAtPercent) {
      return err(
        "invalid_session_thresholds",
        `sessionWarnAtPercent (${next.sessionWarnAtPercent}) must be <= sessionCriticalAtPercent (${next.sessionCriticalAtPercent})`,
      );
    }
    if (next.weekWarnAtPercent > next.weekCriticalAtPercent) {
      return err(
        "invalid_week_thresholds",
        `weekWarnAtPercent (${next.weekWarnAtPercent}) must be <= weekCriticalAtPercent (${next.weekCriticalAtPercent})`,
      );
    }

    await writeRateLimitGuard(next);
    return ok({ guard: next });
  } catch (e) {
    log.error("peer_set_rate_limit_guard_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    return err("peer_set_rate_limit_guard_failed", e instanceof Error ? e.message : "unknown");
  }
}

// ============================================================================
// model_info — canonical Claude model metadata (static lookup, no JSONL scan)
// ============================================================================

export const ModelInfoArgs = z
  .object({
    model: z.string().optional(),
    generation: z.enum(["current", "legacy", "deprecated"]).optional(),
  })
  .strict();

export async function modelInfoTool(args: z.infer<typeof ModelInfoArgs>): Promise<ToolResult> {
  try {
    if (args.model) {
      const found = lookupModel(args.model);
      if (!found) {
        return err("model_not_found", `No metadata for model "${args.model}".`, {
          knownIds: MODELS.map((m) => m.id),
          hint: "Date suffix (-YYYYMMDD) and [1m] tag are stripped before lookup. If you believe this model should exist, file an issue.",
        });
      }
      return ok({
        source: MODEL_METADATA_SOURCE,
        // `pricing` may carry a published end date; this is what applies today.
        effectivePricing: effectivePricing(found),
        model: found,
      });
    }

    let list = MODELS;
    if (args.generation) {
      list = list.filter((m) => m.generation === args.generation);
    }

    return ok({
      source: MODEL_METADATA_SOURCE,
      modelsCount: list.length,
      models: list.map((m) => ({ ...m, effectivePricing: effectivePricing(m) })),
    });
  } catch (e) {
    log.error("model_info_failed", { err: e instanceof Error ? e.message : String(e) });
    return err("model_info_failed", e instanceof Error ? e.message : "unknown");
  }
}

// ============================================================================
// Tool registry
// ============================================================================

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>, ctx: ServerContext) => Promise<ToolResult>;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "list_projects",
    description:
      "List all Claude Code projects (encoded cwd dirs under ~/.claude/projects). Returns project dir names usable with list_sessions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => listProjectsTool(),
  },
  {
    name: "list_sessions",
    description:
      "List session JSONL files across all projects. Returns sessionId, file size, mtime, sorted most recent first. Optional enrichment: `active` flag (heartbeat-based, cheap) and `includeMeta` (one streaming pass per session — adds aiTitle, userPrompts count, assistantReplies count; expensive for many sessions).",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Optional: restrict to a specific project dir (e.g. '-opt-oxy-kb')",
        },
        limit: {
          type: "number",
          description: "Max sessions to return (default 50)",
          minimum: 1,
          maximum: 1000,
        },
        includeActive: {
          type: "boolean",
          description:
            "Include `active` boolean per session (true = recent heartbeat <30s). Default true. Cheap — single stat() per session.",
        },
        includeMeta: {
          type: "boolean",
          description:
            "Include `aiTitle`, `userPrompts`, `assistantReplies` per session. Default false. Streams each JSONL once — expensive (~50–200 ms per MB). Use when building a dashboard view; skip for quick metadata-only listing.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const parsed = ListSessionsArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return listSessionsTool(parsed.data);
    },
  },
  {
    name: "session_stats",
    description:
      "Read a session JSONL and return event counts by type. Useful for quick inspection of a session's content shape. Counts are raw — every line is counted by its `type` field as written, so `totalEvents` equals the file's line count (v0.10.2 fix; earlier versions validated while counting and silently dropped ~13% of a real transcript). `unmodelledTypes` lists types Claude Code writes that this plugin's schema does not model, with counts — empty is normal, non-empty means the schema is behind, not that the count is short. `malformedLines` counts lines that are not valid JSON.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session UUID" },
        project: { type: "string", description: "Optional: restrict to a specific project dir" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const parsed = SessionStatsArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return sessionStatsTool(parsed.data);
    },
  },
  {
    name: "peer_list",
    description:
      "List all active claude-bridge peers (other Claude Code chats reachable via shared filesystem). Each peer has stable `id` (sessionId UUID) and display `name` (may collide across peers in same cwd). `pid` is the PEER's process — the Claude Code process itself. Before v0.10.7 it was this bridge server's own pid, so acting on it reached the bridge rather than the peer, and after an MCP reconnect it could name a process that had already exited; a heartbeat written by an older version still carries the old meaning until that peer's server restarts. `mcpServerPid` is the bridge server, for diagnostics only — never a lifecycle target.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => peerListTool(ctx),
  },
  {
    name: "peer_ask",
    description:
      "Send a message to another claude-bridge peer. `to` accepts peer id (sessionId UUID, always unique) or display name (may be ambiguous — error returned if multiple peers share name). Use peer_list to discover peers.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient peer id (preferred) or name (see peer_list)",
        },
        content: { type: "string", description: "Message content (text)" },
        threadId: { type: "string", description: "Optional: correlation id for multi-turn dialog" },
      },
      required: ["to", "content"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerAskArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerAskTool(ctx, parsed.data);
    },
  },
  {
    name: "peer_reply",
    description:
      "Reply to a previously-received message by msg-id. The original must be in own done/ archive (i.e. already consumed via piggyback or peer_inbox_read).",
    inputSchema: {
      type: "object",
      properties: {
        inReplyTo: {
          type: "string",
          description: "msg-id of the original ask (from piggyback or peer_inbox_read)",
        },
        content: { type: "string", description: "Reply content (text)" },
      },
      required: ["inReplyTo", "content"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerReplyArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerReplyTool(ctx, parsed.data);
    },
  },
  {
    name: "peer_inbox_read",
    description:
      "Explicitly drain own inbox and return pending messages. Usually unnecessary — every tool call piggybacks inbox check. Use when you've been idle and want to check explicitly.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => peerInboxReadTool(ctx),
  },
  {
    name: "peer_chat_read",
    description:
      "Read the content of a peer's chat (their session JSONL) — INCLUDING your own, which is deliberate: after an autocompact or a /clear your on-disk transcript holds detail your context window no longer does, and re-reading it is the point. Earlier versions of this text said \"another peer's chat\" while the code allowed self, so the description was the part that was wrong. Returns last N user+assistant messages, or filtered by query. Default output is a markdown transcript (agent-friendly). Default: last 10 messages, text only (no tool_use, no thinking), 30KB cap. IDE-injected noise tags (<ide_*>, <system-reminder>) are always stripped. Tool_use inputs / tool_result content over 500 chars get truncated. Use `to` = peer id (UUID) or name (see peer_list). Set crossProject:true to read any session by UUID. sinceLastUserPrompt:true returns just the most recent user turn + its replies. query:'string' filters to messages containing the substring (case-insensitive); queryRegex:true treats query as a regex pattern; contextLines:N includes ±N neighbor messages around each match. format: 'markdown' (default), 'json' (structured), 'compact' (skim). For cross-project search use peer_chat_search — peer_chat_read is single-peer scope. Counts are reported as two numbers, not one: `totalEvents` is every line in the file (matches `wc -l`) and `eventsParsed` is how many this plugin's schema could read. They differ because Claude Code writes more event types than the schema models; `unmodelledTypes` names the difference. Before v0.10.6 only the parsed number was reported, labelled as the total, and it ran ~13% short of the file.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Peer id (UUID, preferred) or display name. Self not allowed.",
        },
        lastN: {
          type: "number",
          description: "Return last N matching messages (default 10, max 500)",
          minimum: 1,
          maximum: 500,
        },
        sinceTimestamp: {
          type: "string",
          description: "ISO 8601 timestamp — only messages at or after this time",
        },
        sinceLastUserPrompt: {
          type: "boolean",
          description:
            "Semantic anchor — return messages starting from the peer's most recent user prompt (inclusive). Replaces mechanical lastN guessing for the common 'what's new in their chat' use case.",
        },
        maxBytes: {
          type: "number",
          description: "Hard cap on output bytes (default 30000). Oldest dropped first.",
          minimum: 1,
          maximum: 1_000_000,
        },
        includeToolCalls: {
          type: "boolean",
          description:
            "Include tool_use (on assistant) + tool_result (on user) blocks. Default false — adds significant bulk.",
        },
        includeThinking: {
          type: "boolean",
          description: "Include assistant `thinking` blocks. Default false — often very large.",
        },
        rolesOnly: {
          type: "array",
          items: { type: "string", enum: ["user", "assistant"] },
          description: "Restrict to only these roles. E.g. ['user'] for prompt-only view.",
        },
        crossProject: {
          type: "boolean",
          description:
            "Allow reading any session by UUID, even if peer is inactive or in another project. Default false — only active same-project peers.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json", "compact"],
          description:
            "Output format. 'markdown' (default) — readable transcript with headers + body. 'json' — structured payload for programmatic use. 'compact' — one short line per message, ideal for skim of many messages.",
        },
        query: {
          type: "string",
          description:
            "Filter to messages containing this substring (case-insensitive). Combine with queryRegex:true for pattern match. Only matches message text (not thinking or tool_use blocks).",
        },
        queryRegex: {
          type: "boolean",
          description: "Treat `query` as a regex pattern (case-insensitive). Default false.",
        },
        contextLines: {
          type: "number",
          description:
            "Include ±N neighbor messages around each query match (like grep -C). Default 0. Max 10.",
          minimum: 0,
          maximum: 10,
        },
      },
      required: ["to"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerChatReadArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerChatReadTool(ctx, parsed.data);
    },
  },
  {
    name: "peer_chat_search",
    description:
      "Cross-session text search across the current project (default) or all projects. Returns matches with surrounding context. Single peer scope? Use peer_chat_read with query — that's the right tool for one session. peer_chat_search is for 'where in any of my chats did we talk about X'. Search matches only message text (not thinking, not tool blocks). Sessions older than 30 days are skipped. This peer's OWN session is included by default and tagged `(self)` in the output — earlier versions of this text claimed it was excluded, which was never true in the code, and the premise was wrong anyway: after an autocompact or /clear a peer's transcript holds plenty its context no longer does. Pass `includeSelf: false` to search only other sessions. Output names each count separately: sessions in scope, sessions examined, and sessions containing a match — and warns explicitly when maxMatches stopped the sweep before every session was opened. Hard scope cap at 200 MB scanned — large scopes return scope_too_large with a hint to narrow query or wait for FTS5 backend (v0.5+).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text or regex pattern to search for. Case-insensitive.",
        },
        queryRegex: {
          type: "boolean",
          description: "Treat `query` as a regex pattern. Default false (substring match).",
        },
        scope: {
          type: "string",
          enum: ["project", "all-projects"],
          description:
            "Search scope. 'project' (default) = current project only. 'all-projects' = every project under ~/.claude/projects/. No additional gate — same FS access as Read/Glob tools.",
        },
        contextLines: {
          type: "number",
          description: "Include ±N neighbor messages per match (default 1, max 10).",
          minimum: 0,
          maximum: 10,
        },
        maxMatches: {
          type: "number",
          description:
            "Stop scanning after N matches collected (default 30, max 500). Early termination saves time.",
          minimum: 1,
          maximum: 500,
        },
        maxBytes: {
          type: "number",
          description: "Hard cap on output bytes (default 30000). Sessions truncated last-first.",
          minimum: 1,
          maximum: 1_000_000,
        },
        includeSelf: {
          type: "boolean",
          description:
            "Search this peer's own session too (default true). Own transcript often holds what an autocompact dropped from context; matches in it are tagged `(self)`. Set false to search only other sessions.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerChatSearchArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerChatSearchTool(ctx, parsed.data);
    },
  },
  {
    name: "peer_context_status",
    description:
      "Read autocompact-relevant context statistics for self or other peer(s). v0.9.4 dual-source priority chain (no single point of failure per Zdeněk's requirement 23. 7. 2026 — telemetry must work independently of statusLine render-chain): (1) statusLine capture live/statusline/<sessionId>.json — autoritative when present, provides context_window_size + used_percentage + total_tokens directly from CC's API mirror; (2) JSONL scan fallback — sum of usage tokens on last assistant event + canonical model lookup for contextLimit (deterministic for known models via model_info table); (3) no-live-data — both sources dry, returns setupPointer. `contextLimitSource` enum: 'statusline-stdin' | 'jsonl-canonical' | 'no-live-data'. Inside jsonl-canonical branch, `contextLimitCaveat` field flags trust level: 'canonical-match' (full trust), 'empirical-guess-1m' (⚠ tokens>200k → assumed 1M), 'unknown-model-default-200k' (⚠ percentUsed may be inflated for a genuine 1M model). New `turnInProgress` boolean flags in-flight turn (JSONL last event is user postdating last assistant — tokensUsed is a lower bound). `effortLevel` + `claudeCodeVersion` set only when statusLine source is used. `to` omitted = self only. `to: 'all'` = all active peers + self. `to: ['alice', 'bob', 'self']` = specified peers. `to: 'alice'` = single peer. Includes `guard` config field if peer has one configured. Setup for autoritative statusLine data: see docs/SETUP-LIVE-DATA.md.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          oneOf: [
            { type: "string", description: "Peer id (UUID), name, 'self', or 'all'" },
            {
              type: "array",
              items: { type: "string" },
              description: "Array of peer ids/names/'self'",
            },
          ],
          description:
            "Target peer(s). Omit = self only. 'all' = all active peers + self. String = single peer (UUID/name/'self'). Array = bulk.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerContextStatusArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerContextStatusTool(ctx, parsed.data);
    },
  },
  {
    name: "peer_set_context_guard",
    description:
      "Configure own context-usage guard (self-write only). When peer's tokensUsed crosses warnAtPercent or criticalAtPercent, plugin can notify subscribers via push channel messages. Self-targeted — peer can only set its own guard, not other peer's. Defaults: enabled=true, warnAtPercent=0.85, criticalAtPercent=0.95, notifyPeerIds=[] (no external notify), broadcastProject=false. Returns updated config + sessionId.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Master toggle (default true).",
        },
        warnAtPercent: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "First threshold (default 0.85). Fires 'warn' level notification when crossed.",
        },
        criticalAtPercent: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Critical threshold (default 0.95). Fires 'critical' level notification when crossed. Must be >= warnAtPercent.",
        },
        notifyPeerIds: {
          type: "array",
          items: { type: "string" },
          description: "Peer IDs to notify on threshold crossing (default []).",
        },
        broadcastProject: {
          type: "boolean",
          description: "If true, notify all peers in same cwd (default false).",
        },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerSetContextGuardArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerSetContextGuardTool(ctx, parsed.data);
    },
  },
  {
    name: "rate_limit_status",
    description:
      "Read account-scoped rate limits (5-hour session + 7-day weekly + spend + extras) from LIVE data sources (v0.9.0+, BREAKING). USER-scoped — all peers on the same POSIX account share one set. Live source priority: (1) ~/.claude-bridge/live/statusline.json — written by plugin's chained statusLine wrapper per CC render (primary, per-turn); (2) ~/.claude-bridge/live/oauth-api.json — written by PostToolUse hook calling OAuth /api/oauth/usage endpoint, throttled ~1/min (secondary, richer fields incl. spend/extras/per-model/codenames); (3) neither → `hasLiveData: false` + `setupPointer`. When both are present the newer capture wins. Fossil ~/.claude/.usage_cache.json read from v0.8.x is REMOVED. When both captures exist the sources are COMBINED, not chosen between (v0.10.6 fix): utilization and reset times come from whichever is newer, while `scopedLimits` (including the `weekly_scoped` per-model budget), `spend`, `extraUsage`, `perModelWeekly`, `severity` and `isActive` come from the OAuth capture, which is the only one carrying them. `source` is then 'composed' and `secondary` states which fields were borrowed, from which capture, and how many seconds old it is — the two halves have different ages and the output says so. Before this, the newer capture simply won; statusLine is written every render, so it nearly always won and every richer field was silently dropped. Returns: hasLiveData, source ('statusline-stdin' | 'oauth-api' | 'composed' | 'no-live-data'), capturedAt, capturedAgeSeconds, staleness ('fresh'/'stale'/'expired-window'), session bucket, week bucket, scopedLimits, spend, extraUsage, perModelWeekly, rawExperimental, secondary. Each bucket has utilization (0-1), resetsAt, hoursUntilReset, severity, windowExpired, and isActive when known. `severity` is `'unknown'` and `isActive` is absent when the producing capture does not carry them — earlier versions reported 'normal' and true regardless, so a session at 88% was labelled normal while the API called it a warning. Includes `guard` config field if `peer_set_rate_limit_guard` was configured. See docs/SETUP-LIVE-DATA.md for install.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => rateLimitStatusTool(),
  },
  {
    name: "peer_set_rate_limit_guard",
    description:
      "Configure account-scoped rate-limit guard (v0.9.0-beta+). USER-scoped — one config shared across all peers on the account (unlike peer_set_context_guard which is per-session). Fires warn/critical when session (5h) or week (7d) utilization crosses configured thresholds. Weekly cap has lower default threshold (0.75/0.90) than session (0.85/0.95) because 7-day recovery hurts more than 5h. Notification delivery via push channel to notifyPeerIds. Defaults: enabled=true, sessionWarnAtPercent=0.85, sessionCriticalAtPercent=0.95, weekWarnAtPercent=0.75, weekCriticalAtPercent=0.90, notifyPeerIds=[]. Any field can be partially updated; unspecified fields keep current values. Returns updated config.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Master toggle (default true)." },
        sessionWarnAtPercent: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "First threshold for 5h session (default 0.85).",
        },
        sessionCriticalAtPercent: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Critical threshold for 5h session (default 0.95). Must be >= sessionWarnAtPercent.",
        },
        weekWarnAtPercent: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "First threshold for 7d weekly (default 0.75).",
        },
        weekCriticalAtPercent: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Critical threshold for 7d weekly (default 0.90). Must be >= weekWarnAtPercent.",
        },
        notifyPeerIds: {
          type: "array",
          items: { type: "string" },
          description: "Peer IDs to notify on threshold crossing (default []).",
        },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerSetRateLimitGuardArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerSetRateLimitGuardTool(ctx, parsed.data);
    },
  },
  {
    name: "model_info",
    description:
      "Return canonical Claude model metadata: context window, max output, pricing, capabilities (vision / extended thinking / adaptive thinking), knowledge cutoff, lifecycle status (current/legacy/deprecated). Static lookup — no JSONL scan, no network calls. Context window / max output / capabilities are checked against `GET /v1/models` by the test suite; price and lifecycle are hand-copied from the docs pages (https://platform.claude.com/docs/en/about-claude/pricing) and are not available from any API. Verified 2026-08-04 against 11 models. `effectivePricing` resolves published rate changes against today's date — Sonnet 5 is $2/$10 per MTok through 2026-08-31 and $3/$15 after, so read `effectivePricing`, not `model.pricing`. Pass `model` to query specific id (date suffix and [1m] tag are stripped automatically). Pass `generation` to filter (current/legacy/deprecated). No args = list all known models.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Optional: query specific model by id (e.g., 'claude-opus-4-7'). Date suffix and [1m] tag normalized. Returns model_not_found error if unknown.",
        },
        generation: {
          type: "string",
          enum: ["current", "legacy", "deprecated"],
          description:
            "Optional: filter listed models by lifecycle status. Ignored if `model` is set.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const parsed = ModelInfoArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return modelInfoTool(parsed.data);
    },
  },
  {
    name: "peer_set_notification",
    description:
      "Configure own idle-notification (terminal beep when stable-idle, self-write only). When enabled and peer is idle for `minIdleSeconds`, plugin emits terminal bell + visual notification. Self-targeted — peer can only set its own notification config. Defaults: enabled=false, minIdleSeconds=30.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Toggle idle notification (default false).",
        },
        minIdleSeconds: {
          type: "integer",
          minimum: 5,
          maximum: 3600,
          description:
            "Seconds of idle before first beep fires (default 30). Also gap between escalation beeps.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerSetNotificationArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerSetNotificationTool(ctx, parsed.data);
    },
  },
  {
    name: "control_config",
    description:
      "Read and DECLARE peer intent — the single configuration tool for the control plane (v0.11.0). No args: every peer's declared values plus any drift. `peer`: one peer (session id, full name, or short name inside your team). `team`: that team's peers. `set`: declare values — allowed keys are label, windowIndex, model, accountProfile. `unset: [\"windowIndex\"]` withdraws a declaration entirely, which is different from setting it empty. `team` is deliberately NOT settable: moving a peer between teams is lifecycle work (window, home session, label) and belongs to team_adopt/team_release. `dryRun:true` shows the change and writes nothing. IMPORTANT: this writes the DESIRED half of the record only; it changes nothing in the world. windowIndex is recorded and drift is reported, but no window is moved in v0.11.0 — asserting intent lands in v0.11.1 behind an explicit opt-in. Drift entries carry BOTH the declared and the measured value and BOTH ways out: `assert` (make the world match) and `adopt` (accept reality as the new intent). Destructive lifecycle operations are deliberately NOT here — see peer_stop / peer_restart / team_stop. The same function is reachable from a shell: `claude-bridge-daemon config --help`.",
    inputSchema: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "Session id, full name, or short name in the caller's team",
        },
        team: { type: "string", description: "Read every peer of this team (read-only)" },
        set: {
          type: "object",
          description: "Values to declare. Omit to read.",
          properties: {
            label: {
              type: "string",
              description: "Short display name — tmux window title and projections",
            },
            windowIndex: {
              type: "number",
              description: "Requested window position. Recorded only in v0.11.0.",
            },
            model: { type: ["string", "null"], description: "Model the peer SHOULD run" },
            accountProfile: { type: ["string", "null"], description: "Billing identity" },
          },
          additionalProperties: false,
        },
        unset: {
          type: "array",
          items: { type: "string", enum: ["label", "windowIndex", "model", "accountProfile"] },
          description:
            "Withdraw a declaration, returning the key to 'nobody has said'. NOT the same as setting it empty: an undeclared windowIndex reports no drift wherever the window sits, a declared one that disagrees does.",
        },
        dryRun: { type: "boolean", description: "Preview the change without writing" },
        reason: { type: "string", description: "Recorded in events.jsonl alongside the change" },
        wait: { type: "boolean" },
        timeoutMs: { type: "number" },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = ControlConfigArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return controlConfigTool(ctx, parsed.data);
    },
  },
  {
    name: "control_status",
    description:
      "Read-only: check the v0.10.0 control-plane daemon health (pid, lock, heartbeat freshness) and summarise its state.json. Returns `daemon_not_running` with a setupPointer when the daemon isn't installed — no crash, no auto-start. See docs/architecture.md ADR-008 and the SETUP-LIVE-DATA doc for install steps.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (args) => {
      const parsed = ControlStatusArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return controlStatusTool();
    },
  },
  {
    name: "peer_stop",
    description:
      "Ask the control-plane daemon to stop a peer. v0.10.0-alpha ships this as a fire-and-forget wire: the MCP tool writes a request envelope to the daemon inbox and returns `{ requestId, queuedAt }`. Full lifecycle (graceful signal + host-driver cleanup) lands in v0.10.0-beta — alpha handler currently returns `not_implemented_in_alpha` for known peers and `peer_not_found` for unknown ones. Pass `wait:true, timeoutMs:N` to poll for the result envelope before returning.",
    inputSchema: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "Peer sessionId (UUID) or display name. Prefer sessionId for uniqueness.",
        },
        reason: {
          type: "string",
          description: "Optional free-text reason recorded in events.jsonl for the audit trail.",
        },
        force: {
          type: "boolean",
          description:
            "Skip graceful signal, kill immediately. Not honoured in alpha (stub handler) — recorded for beta.",
        },
        wait: {
          type: "boolean",
          description:
            "If true, poll for `results/<id>.json` before returning. Default false = fire-and-forget.",
        },
        timeoutMs: {
          type: "number",
          minimum: 1,
          maximum: 60000,
          description: "Max ms to wait when wait=true (default 10000).",
        },
      },
      required: ["peer"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerStopArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerStopTool(ctx, parsed.data);
    },
  },
  {
    name: "peer_spawn",
    description:
      "Ask the control-plane daemon to spawn a new peer inside a supervised tmux session (v0.10.0-beta). Env is sanitized — ANTHROPIC_*/CLAUDE_* leaked from the caller's shell are stripped (regression fix for the 22. 7. 2026 contaminated spawn). Pass `resume:true` to reuse an existing sessionId — fork-guard refuses if it's already live. Fire-and-forget by default; opt in to `wait:true, timeoutMs:N` to receive the daemon's result envelope inline. Requires daemon installed (see docs/architecture.md ADR-008).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session UUID for --resume; a stable name for a fresh spawn.",
        },
        displayName: {
          type: "string",
          description: "Human name for the tmux session (used as the sessionKey).",
        },
        cwd: {
          type: "string",
          description: "Working directory the peer should start in.",
        },
        command: {
          type: "string",
          description: "Absolute path to the executable (typically `claude`).",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Additional CLI arguments for the executable.",
        },
        resume: {
          type: "boolean",
          description: "Append `--resume <sessionId>` to args. Fork-guard applies.",
        },
        model: {
          type: "string",
          description: "Optional --model override.",
        },
        accountProfile: {
          type: "string",
          description:
            "Name of the account profile under ~/.claude-bridge/control/accounts/. Sets CLAUDE_CONFIG_DIR — the one Claude-namespaced env var the daemon is allowed to inject.",
        },
        extraAllowEnv: {
          type: "array",
          items: { type: "string" },
          description:
            "Extra env variable NAMES from the caller's process to pass through in addition to the base whitelist. `ANTHROPIC_*`/`CLAUDE_*` are always stripped regardless.",
        },
        extraEnv: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Fully-formed env overrides applied last (bypass whitelist for those names, except the hard-strip prefixes).",
        },
        wait: {
          type: "boolean",
          description: "Poll for result envelope before returning. Default false.",
        },
        timeoutMs: {
          type: "number",
          minimum: 1,
          maximum: 60000,
          description: "Wait budget in ms (default 10000).",
        },
      },
      required: ["sessionId", "displayName", "cwd", "command"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerSpawnArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerSpawnTool(ctx, parsed.data);
    },
  },
  {
    name: "peer_restart",
    description:
      "Stop and re-spawn a peer via the daemon, carrying model + account profile from state.peers unless overridden. Uses `--resume` so the session id stays stable. Wait/timeout semantics identical to peer_spawn.",
    inputSchema: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "Peer sessionId (UUID) or display name.",
        },
        reason: {
          type: "string",
          description: "Free-text reason recorded in events.jsonl.",
        },
        force: {
          type: "boolean",
          description: "Kill immediately instead of graceful signal.",
        },
        model: {
          type: "string",
          description: "Override the model on the new instance (default: carry over from state).",
        },
        accountProfile: {
          type: "string",
          description: "Override account profile (default: carry over from state).",
        },
        wait: { type: "boolean" },
        timeoutMs: { type: "number", minimum: 1, maximum: 60000 },
      },
      required: ["peer"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerRestartArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerRestartTool(ctx, parsed.data);
    },
  },
  {
    name: "team_status",
    description:
      "Read-only view over the daemon's state.peers + host driver liveness. Returns per peer: sessionId, name, status, hostAlive (true when the driver still holds the sessionKey). `verbose:true` adds tmuxTarget, pid, model, account profile, timestamps. Default `wait:true` — this is a read query, callers expect data not an ack. Telemetry fields (context %, rate limits) land in F2.",
    inputSchema: {
      type: "object",
      properties: {
        team: {
          type: "string",
          description: "Optional team filter (unused in beta; reserved for F2 multi-team layout).",
        },
        verbose: {
          type: "boolean",
          description: "Include full per-peer fields (default false → compact view).",
        },
        wait: { type: "boolean", description: "Default true — read query expects data." },
        timeoutMs: { type: "number", minimum: 1, maximum: 60000 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = TeamStatusArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return teamStatusTool(ctx, parsed.data);
    },
  },
  {
    name: "peer_compact",
    description:
      "Ask the control-plane daemon to orchestrate `/compact` on a peer (v0.10.0-rc). Sequence: daemon writes a bridge inbox message to the peer requesting a compact anchor → peer writes `~/.claude-bridge/control/compact-ack/<sessionId>.json` when ready → daemon `send-keys /compact` into the tmux session → emits `peer_compacted`. Refuses with `anchor_timeout` if the ack file doesn't appear within `anchorTimeoutMs` (default 30 s). This is the ONLY send-keys path in the daemon (charter §8 amendment) — every inject is audit-logged via `peer_compact_inject`. The AUTO-watchdog framework is present but defaults OFF (`config.compactWatchdog.enabled = false`); operator must flip it explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", description: "Peer sessionId (UUID) or display name." },
        anchorTimeoutMs: {
          type: "number",
          minimum: 1,
          maximum: 300000,
          description: "Wait budget for the ack file (default 30000).",
        },
        ackPollMs: {
          type: "number",
          minimum: 1,
          maximum: 10000,
          description: "Ack file poll interval (default 500).",
        },
        skipAnchorRequest: {
          type: "boolean",
          description:
            "Skip the anchor request bridge message — assume the ack file is already present. For tests / operators who bypass the standard playbook.",
        },
        reason: { type: "string", description: "Free-text reason recorded in events.jsonl." },
        wait: { type: "boolean" },
        timeoutMs: { type: "number", minimum: 1, maximum: 120000 },
      },
      required: ["peer"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = PeerCompactArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return peerCompactTool(ctx, parsed.data);
    },
  },
  {
    name: "team_layout",
    description:
      "Declarative team reconcile against `~/.claude-bridge/control/teams/<team>.json` (or an inline spec). `apply:true` (default) spawns any peer in the spec that is not already in `state.peers`. `prune:true` also stops any peer in `state.peers` that is not in the spec — extras are KEPT by default (safe reconcile). Set `apply:false` to preview the diff without changing anything. Response includes spawnedOk / spawnedFailed / stoppedOk / stoppedFailed / keptExtras arrays. Team spec schema documented in docs/SETUP-DAEMON.md.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Team name — matches `teams/<team>.json`." },
        apply: {
          type: "boolean",
          description:
            "Actually reconcile (default true). Pass false for a preview (spawnedOk/stoppedOk stay empty; plannedSpawn/plannedStop populated).",
        },
        prune: {
          type: "boolean",
          description: "Stop peers not in the spec. Default false = safe (keep extras).",
        },
        inline: {
          type: "object",
          description:
            "Provide the team spec inline instead of reading from teams/<team>.json. Same schema — { team, peers[] }.",
        },
        wait: { type: "boolean", description: "Default true — reconcile is a query." },
        timeoutMs: { type: "number", minimum: 1, maximum: 60000 },
      },
      required: ["team"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = TeamLayoutArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return teamLayoutTool(ctx, parsed.data);
    },
  },
  {
    name: "team_stop",
    description:
      'Put a whole team to sleep, gracefully. NOT a mass kill: each peer first gets a `stop-request` in its inbox telling it to park its work, flush its anchor and memory, and touch `~/.claude-bridge/control/stop-ack/<sessionId>.json`. Only then is its session killed. A peer that does not ack within `anchorTimeoutMs` (default 120 s PER PEER) KEEPS RUNNING and is reported under `skipped` — pass `force:true` to kill it anyway (recorded as `stoppedCleanly:false`). Peers whose host session is already gone are cleaned up as `stoppedDead`. Order: members first, anyone marked `role:"velitel"` last. Stopped peers stay in `state.peers` with `status:"stopped"` so `team_layout apply` can resume the SAME session ids later. Use `dryRun:true` to see the order first. A real run can take minutes — the client timeout scales with the ack window automatically.',
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Team name — matches `teams/<team>.json`." },
        force: {
          type: "boolean",
          description:
            "Kill peers that never acked. Default false: unacked peers keep running rather than lose unparked work.",
        },
        anchorTimeoutMs: {
          type: "number",
          minimum: 1,
          maximum: 600000,
          description:
            "Ack window per peer. Default 120000 (4x the compact ack — a peer must write its anchor and memory).",
        },
        ackPollMs: { type: "number", minimum: 1, maximum: 10000 },
        dryRun: {
          type: "boolean",
          description: "Preview the stop order and parameters without touching any peer.",
        },
        inline: {
          type: "object",
          description:
            "Team spec inline instead of teams/<team>.json — { team, peers[{sessionId, displayName, role?}] }.",
        },
        wait: { type: "boolean", description: "Default true." },
        timeoutMs: { type: "number", minimum: 1, maximum: 900000 },
      },
      required: ["team"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = TeamStopArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return teamStopTool(ctx, parsed.data);
    },
  },
  {
    name: "team_adopt",
    description:
      'Bring peers the daemon did NOT spawn under its control, without restarting them. Fixes the case where a team was started by an external script (tmux + `claude --resume`) so `state.peers` is empty while `peer_list` shows the peers live — every lifecycle tool then fails with `peer_not_found`. `mode:"auto"` (default) walks the host\'s sessions, finds the Claude process inside each and reads its session id from `~/.claude/sessions/<pid>.json`. `mode:"manual"` takes an explicit `mapping` of host session key -> session id. **`dryRun` defaults to TRUE** — review the plan, then re-run with `dryRun:false` to actually take ownership. Two Claude processes under one pane are reported as `ambiguous` and never adopted, because that is the duplicate-identity failure mode and guessing would launder it. Peers the daemon already runs are skipped, never overwritten.',
    inputSchema: {
      type: "object",
      properties: {
        team: {
          type: "string",
          description: "Team the adopted peers are recorded under. Required — adoption stamps it.",
        },
        mode: {
          type: "string",
          enum: ["auto", "manual"],
          description:
            "auto (default) = discover from the process table. manual = use `mapping` (needed on hosts where /proc is unavailable).",
        },
        hostSession: {
          type: "string",
          description:
            "Adopt only peers whose tmux session matches — a plain name ('hmh') or a /regex/. Without it, auto mode sweeps every window on the host into one team, which makes adopting several families under separate team names impossible.",
        },
        mapping: {
          type: "object",
          description: 'manual mode only: { "<hostSessionKey>": "<sessionId>" }.',
        },
        dryRun: {
          type: "boolean",
          description:
            "DEFAULT TRUE. Returns the planned adoption and changes nothing. Pass false to actually adopt.",
        },
        wait: { type: "boolean", description: "Default true." },
        timeoutMs: { type: "number", minimum: 1, maximum: 60000 },
      },
      required: ["team"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = TeamAdoptArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return teamAdoptTool(ctx, parsed.data);
    },
  },
  {
    name: "team_release",
    description:
      "Drop a peer from daemon state WITHOUT touching its process — the undo for adoption. When team_adopt takes over the wrong peer (mismapped session id, a window that belonged to someone else), the only exit used to be peer_stop, which removes the record by killing the work: a running peer's life for a bookkeeping mistake. This is state-only and cannot signal anything; the peer carries on exactly as before the daemon noticed it. Pass either `peers` (ids or names) or `team`, never both. **`dryRun` defaults to TRUE** — the plan names what would be released, so 'I meant the other team' is caught before it happens. Unknown peers are reported in `notFound`, not silently skipped. The audit event records `processLeftRunning: true` so a later reader cannot mistake a release for a stop. To stop a peer use peer_stop; to restart it use peer_restart.",
    inputSchema: {
      type: "object",
      properties: {
        peers: {
          type: "array",
          items: { type: "string" },
          description: "Peer ids or names to release. Mutually exclusive with `team`.",
        },
        team: {
          type: "string",
          description: "Release every peer under this team. Mutually exclusive with `peers`.",
        },
        reason: { type: "string", description: "Recorded in the audit event." },
        dryRun: {
          type: "boolean",
          description: "DEFAULT TRUE. Returns the plan and changes nothing.",
        },
        wait: { type: "boolean", description: "Default true." },
        timeoutMs: { type: "number", minimum: 1, maximum: 60000 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = TeamReleaseArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return teamReleaseTool(ctx, parsed.data);
    },
  },
  {
    name: "team_reconcile",
    description:
      "Compare what the daemon believes against what is actually running, and report the gap. A record saying status 'live' is a belief about a pid, and it goes stale the moment a process dies without telling anyone — this is the tool that checks. Kinds of drift: `dead` (record says live, no process behind the pid — and it now says whether the peer's pane is still standing, with the exit status, or gone), `host_missing` (process alive, its tmux target gone), `pid_changed` (the target holds a DIFFERENT pid than the record — the dangerous one, because every lifecycle call would then act on a peer nobody meant), `unmanaged` (a Claude peer running with no record at all, always reported whole-host even when `team` filters the rest), `dead_pane` (a window held open after its process exited and belonging to no record — the graveyard, also whole-host). Deliberately stopped peers are state, not drift. **READ-ONLY by default.** `markDead: true` is the only write and only sets status 'unknown' on records whose process is gone — never 'stopped' (nobody asked them to stop), never deletes, never kills, never adopts. Deleting is team_release, killing is peer_stop, adopting is team_adopt.",
    inputSchema: {
      type: "object",
      properties: {
        team: {
          type: "string",
          description: "Restrict the record check to one team. Unmanaged peers are still listed.",
        },
        markDead: {
          type: "boolean",
          description:
            "DEFAULT FALSE. Sets status to 'unknown' on records whose process is gone. Writes nothing else, removes nothing.",
        },
        wait: { type: "boolean", description: "Default true." },
        timeoutMs: { type: "number", minimum: 1, maximum: 60000 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = TeamReconcileArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return teamReconcileTool(ctx, parsed.data);
    },
  },
  {
    name: "team_restart",
    description:
      "Restart a team one peer at a time, stopping at the first failure. A peer picks up an updated plugin bundle when its process restarts, so a rolling restart is how a new version reaches a fleet — the widest blast radius of any tool here, which is why the defaults are cautious. **`dryRun` defaults to TRUE** and the plan lists the order plus the launch parameters each peer would be relaunched with, so an operator can confirm they exist before anything stops. Peers with no recorded `command` are refused UP FRONT rather than discovered mid-roll — those relaunch as a bare `claude`, which resolves to nothing under nvm. **The roll stops at the first failure** (`continueOnError` defaults false): half a fleet running beats a whole one broken, and peers never attempted are named in `skipped`. A partial roll returns an ERROR, never ok — reporting success would leave the caller believing the roll-out finished. Order is array order, or state order for a team, with any peer named velitel deliberately LAST. `settleMs` (default 3000) is the pause after each peer so a rolling restart does not become a simultaneous one.",
    inputSchema: {
      type: "object",
      properties: {
        peers: {
          type: "array",
          items: { type: "string" },
          description: "Peer ids or names, in restart order. Mutually exclusive with `team`.",
        },
        team: {
          type: "string",
          description: "Restart a whole team. Mutually exclusive with `peers`.",
        },
        reason: { type: "string", description: "Recorded on each restart and in the audit event." },
        settleMs: {
          type: "number",
          minimum: 0,
          maximum: 120000,
          description: "Pause after each peer before the next (default 3000).",
        },
        continueOnError: {
          type: "boolean",
          description:
            "DEFAULT FALSE. Keep rolling after a peer fails. Leaving this off is what keeps a bad roll from reaching the whole fleet.",
        },
        dryRun: {
          type: "boolean",
          description: "DEFAULT TRUE. Returns the order and launch parameters, restarts nothing.",
        },
        wait: { type: "boolean", description: "Default true." },
        timeoutMs: { type: "number", minimum: 1, maximum: 600000 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = TeamRestartArgs.safeParse(args);
      if (!parsed.success) return err("invalid_args", "Schema validation failed", parsed.error);
      return teamRestartTool(ctx, parsed.data);
    },
  },
];

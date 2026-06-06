import { z } from "zod";
import { type MessageEnvelope, type MessageKind, generateMessageId } from "../inbox/store.ts";
import { parseSessionFile, parseSessionFileRaw, readSessionFile } from "../parser/jsonl.ts";
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
import { makeLogger } from "../util/logger.ts";
import { encodeProjectDir } from "../util/paths.ts";
import type { ServerContext } from "./context.ts";

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

    const results = await Promise.all(
      filtered.map(async (s) => {
        const events = await readSessionFile(s.filePath);
        const byType: Record<string, number> = {};
        for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
        return {
          ...serializeSessionRef(s),
          totalEvents: events.length,
          eventsByType: byType,
        };
      }),
    );

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
  if (byName.length === 0) return { ok: false, code: "peer_not_found", activePeers: peers };
  return { ok: false, code: "ambiguous_peer", candidates: byName };
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

export async function peerListTool(ctx: ServerContext): Promise<ToolResult> {
  try {
    const peers = await ctx.registry.listActivePeers();
    return ok({
      self: {
        id: ctx.self.id,
        name: ctx.self.name,
        displayName: ctx.self.displayName,
      },
      count: peers.length,
      peers: peers.map((p) => ({
        id: p.id,
        name: p.name,
        displayName: p.displayName ?? p.name,
        pid: p.pid,
        cwd: p.cwd,
        ageMs: p.ageMs,
        source: p.source,
        version: p.version,
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
  scanned: { totalEvents: number; matchedMessages: number; queryMatches?: number };
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
    `**Scanned:** ${meta.scanned.totalEvents} events → ${meta.scanned.matchedMessages} matched → returned ${meta.returnedCount} (truncated: ${formatTruncationNote(meta.truncated)})`,
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
  const header = `peer: ${peerLabel} [${shortId(meta.peer.id)}] | ${meta.scanned.totalEvents} events, ${meta.scanned.matchedMessages} matched, ${meta.returnedCount} returned (trunc: ${formatTruncationNote(meta.truncated)})${queryPart}`;
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
  if (args.to === ctx.self.id || args.to === ctx.self.name) {
    return err("self_read", "Cannot read own chat — your own context is already loaded");
  }

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
      totalEvents: totalEventsScanned,
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
  })
  .strict();

interface SearchMatchEntry {
  session: SessionRef;
  aiTitle?: string;
  message: { ts: string; uuid: string; role: "user" | "assistant"; text: string };
  context: Array<{ ts: string; uuid: string; role: "user" | "assistant"; text: string }>;
}

/**
 * Resolve sessions in scope, sort by mtime desc, drop ones older than maxAgeDays
 * and skip the caller's own session (already in agent context).
 */
async function resolveSearchSessions(
  scope: "project" | "all-projects",
  selfSessionId: string,
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

  return sessions
    .filter((s) => s.sessionId !== selfSessionId)
    .filter((s) => s.modifiedAt.getTime() >= cutoffMs);
}

/**
 * Read whole file as a single string for raw substring/regex pre-filter.
 * Returns null on read error (file deleted mid-scan, permission denied, etc.).
 */
async function readFileForPrefilter(filePath: string): Promise<string | null> {
  try {
    return await (await import("node:fs/promises")).readFile(filePath, "utf-8");
  } catch {
    return null;
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

  const sessions = await resolveSearchSessions(args.scope, ctx.self.id);
  if (sessions.length === 0) {
    return okText(
      `# Search: \`${args.query}\`\n\n**Scope:** ${args.scope}\n**Total matches:** 0 (no sessions in scope after maxAgeDays=${SEARCH_MAX_AGE_DAYS} filter)`,
    );
  }

  const totalBytesScope = sessions.reduce((sum, s) => sum + s.sizeBytes, 0);
  if (totalBytesScope > SEARCH_MAX_BYTES_SCANNED) {
    return err(
      "scope_too_large",
      `Filtered scope is ${Math.round(totalBytesScope / 1024 / 1024)} MB across ${sessions.length} sessions — over the ${Math.round(SEARCH_MAX_BYTES_SCANNED / 1024 / 1024)} MB cap. Reduce by using scope='project' or wait for FTS5 backend (v0.5+).`,
    );
  }

  const startMs = Date.now();
  const matches: SearchMatchEntry[] = [];
  let sessionsScanned = 0;
  let sessionsHit = 0;
  let bytesScanned = 0;

  for (const session of sessions) {
    if (matches.length >= args.maxMatches) break;
    sessionsScanned++;
    bytesScanned += session.sizeBytes;

    // Stage 1: raw buffer pre-filter — fast reject without JSON parsing
    const raw = await readFileForPrefilter(session.filePath);
    if (raw === null) continue;
    if (!prefilter(raw)) continue;
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
      sessionsScanned,
      sessionsHit,
      bytesScanned,
      elapsedMs,
      truncated,
      maxBytes: args.maxBytes,
    }),
  );
}

interface SearchRenderMeta {
  sessionsInScope: number;
  sessionsScanned: number;
  sessionsHit: number;
  bytesScanned: number;
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
  lines.push(
    `**Scope:** ${meta.sessionsInScope} sessions × ${Math.round(meta.bytesScanned / 1024 / 1024)} MB scanned in ${meta.elapsedMs} ms`,
  );
  lines.push(
    `**Hits:** ${meta.sessionsHit}/${meta.sessionsScanned} sessions, ${matches.length} matches${meta.truncated ? " (truncated at maxMatches)" : ""}`,
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
    const sessionLines: string[] = [];
    sessionLines.push("---");
    sessionLines.push("");
    sessionLines.push(
      `## ${label} \`${shortId(sess.sessionId)}\` — ${sessionMatches.length} match${sessionMatches.length === 1 ? "" : "es"}`,
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

function formatInboxBlock(messages: MessageEnvelope[]): string {
  if (messages.length === 0) return "";
  const lines: string[] = [];
  lines.push(`─── 📬 INBOX (${messages.length} new) ───`);
  for (const m of messages) {
    const ts = m.sentAt.slice(11, 19); // HH:MM:SS
    lines.push("");
    lines.push(`[${m.id}] from ${formatSender(m)} (${m.kind}) at ${ts}:`);
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
  for (const p of pending) {
    const c = await ctx.inbox.consume(ctx.self.id, p.id);
    if (!c) continue;
    // Skip in output block if already shown to agent via push channel.
    // The message has been archived (consume above), so peer_reply still works.
    if (ctx.pushedMsgIds.has(c.id)) {
      ctx.pushedMsgIds.delete(c.id);
      continue;
    }
    consumedForBlock.push(c);
  }

  const block = formatInboxBlock(consumedForBlock);
  if (!block) return result;
  return {
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    content: [...result.content, { type: "text", text: block }],
  };
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
      "Read a session JSONL and return event counts by type. Useful for quick inspection of a session's content shape.",
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
      "List all active claude-bridge peers (other Claude Code chats reachable via shared filesystem). Each peer has stable `id` (sessionId UUID) and display `name` (may collide across peers in same cwd).",
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
      "Read content of another peer's chat (their session JSONL). Returns last N user+assistant messages, or filtered by query. Default output is a markdown transcript (agent-friendly). Default: last 10 messages, text only (no tool_use, no thinking), 30KB cap. IDE-injected noise tags (<ide_*>, <system-reminder>) are always stripped. Tool_use inputs / tool_result content over 500 chars get truncated. Use `to` = peer id (UUID) or name (see peer_list). Set crossProject:true to read any session by UUID. sinceLastUserPrompt:true returns just the most recent user turn + its replies. query:'string' filters to messages containing the substring (case-insensitive); queryRegex:true treats query as a regex pattern; contextLines:N includes ±N neighbor messages around each match. format: 'markdown' (default), 'json' (structured), 'compact' (skim). For cross-project search use the upcoming peer_chat_search tool (v0.4+) — peer_chat_read is single-peer scope.",
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
      "Cross-session text search across the current project (default) or all projects. Returns matches with surrounding context. Single peer scope? Use peer_chat_read with query — that's the right tool for one session. peer_chat_search is for 'where in any of my chats did we talk about X'. Search matches only message text (not thinking, not tool blocks). Sessions older than 30 days are skipped. Self session is excluded (already in context). Hard scope cap at 200 MB scanned — large scopes return scope_too_large with a hint to narrow query or wait for FTS5 backend (v0.5+).",
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
];

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { IdentityError } from "../identity.ts";
import { makeLogger } from "../util/logger.ts";
import {
  type ServerContext,
  attachServer,
  buildContext,
  pumpInboxToChannel,
  shutdownContext,
} from "./context.ts";
import { TOOLS, type ToolResult, piggybackInbox } from "./tools.ts";

const log = makeLogger("mcp-server");

const SERVER_NAME = "claude-bridge";
const SERVER_VERSION = "0.8.0";

const INSTRUCTIONS = `
claude-bridge — MCP server for orchestration across Claude Code chats.

MCP tools:
- list_projects, list_sessions (with includeActive + includeMeta for aiTitle/event counts), session_stats — read-only access to JSONL history.
- peer_list, peer_ask, peer_reply, peer_inbox_read — file-based communication with other peers.
- peer_chat_read — view into another peer's session JSONL (last N messages, since timestamp, in-session query/regex).
- peer_chat_search — cross-session search within the current project (default) or all projects (CLAUDE_BRIDGE_ALLOW_ALL_PROJECTS=1).
- peer_context_status (v0.7.0+) — autocompact-relevant context %, model, risk bucket per peer (self / single / array / 'all').
- peer_set_context_guard (v0.7.0+) — own threshold-guard (warn/critical) + notify subscribers.
- peer_set_notification (v0.7.0+) — own idle-beep notification.
- model_info (v0.7.3+) — canonical Claude model metadata (context window, max output, pricing, capabilities, lifecycle).
- rate_limit_status (v0.8.0+) — account-scoped 5h session + 7d weekly usage from Claude Code's ~/.claude/.usage_cache.json (per-model breakdown, spend, extra credits).

Bundled skills (load detail via skill name):
- claude-bridge — overview / quick decision tree
- claude-bridge-role-manager — orchestrator of 2-N worker peers
- claude-bridge-role-memory-keeper — single-writer for shared memory

Peer identity (v0.2.0):
- Each peer has a stable id (Claude Code sessionId UUID) + a display name (which may collide).
- peer_list returns both. peer_ask { to } accepts an id or a name.
- If a name matches > 1 peer (typically 2 chats in the same cwd before the ai-title is set),
  it returns an ambiguous_peer error listing the ids — then send by id.

Message delivery:
- When a message arrives from a peer chat, it comes as a <channel source="claude-bridge" from="..." msgId="..." kind="ask|reply"> tag.
  If kind="ask", reply with peer_reply using inReplyTo=<msgId>. If kind="reply", just take note of it.
- Without the --channels flag (piggyback fallback): every successful tool call drains the inbox and appends pending messages to the output.

Layout:
- ~/.claude-bridge/inbox/<sessionId>/{pending,done}/<msg-id>.json
- ~/.claude-bridge/status/<sessionId>.json
- ~/.claude-bridge/guard/<sessionId>.json     (v0.7.0+)
- ~/.claude-bridge/notify/<sessionId>.json    (v0.7.0+)
`.trim();

export function createServer(): Server {
  return new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );
}

export function wireTools(server: Server, ctx: ServerContext): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // SDK 1.29+ has a stricter ServerResult union with an async-tool variant
  // that requires a `task` field; our synchronous tools return the legacy
  // shape. Cast through `any` to silence the false-positive narrowing.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const started = Date.now();
    log.debug("tool_call", { tool: toolName });

    const spec = TOOLS.find((t) => t.name === toolName);
    if (!spec) {
      log.warn("tool_not_found", { tool: toolName });
      const result: ToolResult = {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, code: "unknown_tool", tool: toolName }),
          },
        ],
      };
      // biome-ignore lint/suspicious/noExplicitAny: SDK 1.29 union narrowing
      return result as any;
    }

    try {
      let result = await spec.handler(args, ctx);
      result = await piggybackInbox(ctx, toolName, result);
      log.debug("tool_result", {
        tool: toolName,
        ok: !result.isError,
        duration_ms: Date.now() - started,
      });
      // biome-ignore lint/suspicious/noExplicitAny: SDK 1.29 union narrowing
      return result as any;
    } catch (e) {
      log.error("tool_call_err", {
        tool: toolName,
        err: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - started,
      });
      const result: ToolResult = {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              code: "tool_exception",
              message: e instanceof Error ? e.message : "unknown",
            }),
          },
        ],
      };
      // biome-ignore lint/suspicious/noExplicitAny: SDK 1.29 union narrowing
      return result as any;
    }
  });
}

export async function startStdioServer(): Promise<void> {
  let ctx: ServerContext;
  try {
    ctx = await buildContext({ version: SERVER_VERSION });
  } catch (e) {
    if (e instanceof IdentityError) {
      log.error("identity_unresolvable", { message: e.message, hint: e.hint });
      process.stderr.write(`\nclaude-bridge fatal: ${e.message}\nHint: ${e.hint}\n\n`);
    } else {
      log.error("boot_failed", { err: e instanceof Error ? e.message : String(e) });
    }
    process.exit(1);
  }

  const server = createServer();
  await attachServer(ctx, server);

  wireTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("started", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: TOOLS.length,
    selfId: ctx.self.id,
    selfName: ctx.self.name,
  });

  // Drain backlog: messages that arrived while we were offline
  const { pushed } = await pumpInboxToChannel(ctx);
  if (pushed > 0) log.info("backlog_drained", { pushed });

  const shutdown = async (signal: string) => {
    log.info("shutdown", { signal });
    await shutdownContext(ctx).catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

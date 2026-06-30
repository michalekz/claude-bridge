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
const SERVER_VERSION = "0.7.4";

const INSTRUCTIONS = `
claude-bridge — MCP server pro orchestraci napříč Claude Code chaty.

MCP tools:
- list_projects, list_sessions (with includeActive + includeMeta for aiTitle/event counts), session_stats — read-only přístup k JSONL historii.
- peer_list, peer_ask, peer_reply, peer_inbox_read — file-based komunikace s ostatními peery.
- peer_chat_read — náhled do session JSONL jiného peera (last N zpráv, since timestamp, in-session query/regex).
- peer_chat_search — cross-session search v rámci current project (default) nebo všech projektů (CLAUDE_BRIDGE_ALLOW_ALL_PROJECTS=1).
- peer_context_status (v0.7.0+) — autocompact-relevant context %, model, risk bucket per peer (self / single / array / 'all').
- peer_set_context_guard (v0.7.0+) — own threshold-guard (warn/critical) + notify subscribers.
- peer_set_notification (v0.7.0+) — own idle-beep notification.
- model_info (v0.7.3+) — canonical Claude model metadata (context window, max output, pricing, capabilities, lifecycle).

Bundled skills (load detail via skill name):
- claude-bridge — overview / quick decision tree
- claude-bridge-role-manager — orchestrator of 2-N worker peers
- claude-bridge-role-memory-keeper — single-writer for shared memory

Identita peerů (v0.2.0):
- Každý peer má stable id (Claude Code sessionId UUID) + display name (může kolidovat).
- peer_list vrací oba. peer_ask { to } přijímá id nebo name.
- Pokud name matchuje > 1 peera (typicky 2 chaty ve stejném cwd než se naplní ai-title),
  vrátí ambiguous_peer error s výčtem id — pošli pak by id.

Doručování zpráv:
- Když dorazí zpráva od peer chatu, přijde jako <channel source="claude-bridge" from="..." msgId="..." kind="ask|reply"> tag.
  Pokud kind="ask", odpověz pomocí peer_reply s inReplyTo=<msgId>. Pokud kind="reply", jen ji vezmi na vědomí.
- Bez --channels flagu (piggyback fallback): každý úspěšný tool call drainuje inbox a appendne pending zprávy do výstupu.

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

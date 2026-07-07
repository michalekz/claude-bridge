# Credits and acknowledgments

`claude-bridge` stands on the shoulders of several open source projects that explored cross-Claude-Code-chat coordination before us. We studied each, picked the patterns that worked, and made different trade-offs where ours led elsewhere. Below are the projects whose ideas directly shaped this one.

## Direct inspirations

### [cc2cc](https://github.com/non4me/cc2cc) by [@non4me](https://github.com/non4me) — MIT

File-based agent-to-agent messaging for Claude Code. We adopted:

- **Atomic write via `temp + rename`** pattern with Windows AV retry. Source of our `src/util/atomic-write.ts`.
- **Piggyback consumption** — drain the inbox at the end of every tool call. Source of `piggybackInbox` in `src/mcp/tools.ts`.
- The general **file-based daemonless architecture** — no background process, just filesystem + the running MCP server.

Where we diverged: cc2cc relies on auto-wake mechanisms we didn't pursue (we use heartbeat-based discovery instead) and doesn't expose cross-session search.

### [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by [@louislva](https://github.com/louislva) — MIT

Peer discovery and messaging via the MCP `notifications/claude/channel` capability. We adopted:

- **Push channel design** — `server.notification` with `method: "notifications/claude/channel"` to deliver messages inline as `<channel>` tags in the receiver's context.
- The pattern of declaring the experimental `claude/channel` capability in the MCP server.

Where we diverged: claude-peers-mcp treats push as primary; we treat it as opt-in (channels gated by org policy on most setups) and made piggyback the source of truth. Our `pump` never consumes — it only renders. Consumption stays with piggyback. This was the lesson from a render-drop bug we initially misdiagnosed but eventually traced to org policy gating channels.

### [claude-relay](https://github.com/innestic/claude-relay) by [innestic](https://github.com/innestic) — MIT

Peer-to-peer MCP server with in-memory message routing. We adopted:

- **Factory closure pattern** for MCP tool registration — tools constructed with injected dependencies via closures rather than singletons or DI containers. Visible in our `wireTools(server, ctx)` in `src/mcp/server.ts`.

Where we diverged: relay maintains a central hub daemon for routing; we kept everything daemonless and filesystem-mediated.

### [multiclaude](https://github.com/dlorenc/multiclaude) by [@dlorenc](https://github.com/dlorenc)

Multi-instance Claude Code orchestration with phased delivery. We adopted:

- **Phase planning approach** — feature delivery in explicit ordered phases (A: file-based inbox, C: push channel, B: search index). Helped us defer FTS5 work until real demand appeared.

### [claude-code-status-line](https://github.com/benabraham/claude-code-status-line) by [@benabraham](https://github.com/benabraham) — MIT

Personal-workflow status line for Claude Code (Python, statusLine hook). We adopted:

- **`~/.claude/.usage_cache.json` as data source** — Claude Code maintains this cache itself; the status-line project showed us the file exists and the field layout (five_hour / seven_day / limits[] / spend / extra_usage / experimental codenames). Source of our `src/parser/rate-limits.ts` field shape and the `rate_limit_status` MCP tool (v0.8.0+).

Where we diverged: status-line is human-facing (ANSI terminal, single-user, `stdin` JSON pipeline via CC's statusLine hook). Our tool is agent-facing (JSON output, cross-peer-aware, direct file read — no statusLine setup required). Complementary, not competing — both consume the same file, different consumers.

Bug-fix credit for `contextLimitSource`: **Zdeněk Michálek + jira-architect (HMH)** empirically caught the "Sonnet 5 missing from canonical table → percentUsed inflated 5×" incident on 2026-07-07 and drove the `unknown-model-fallback` flag design so the same bug surfaces as a visible caveat next time.

## Indirect references

- [Roo-Code](https://github.com/RooCodeInc/Roo-Code) — Apache 2.0. Studied as a VS Code chat extension reference (multi-mode chat UI, custom agent personas) for understanding the alternative-IDE-side of the multi-agent space. We didn't import code from it.
- **Anthropic's [`Claude Code`](https://github.com/anthropics/claude-code) extension and CLI** — the host environment this plugin extends. The MCP protocol, session JSONL format, and plugin marketplace are upstream.

## Engineering audit history

Each of the four direct-inspiration projects above received an engineering audit during the pre-implementation phase of `claude-bridge`. The audits informed which patterns to adopt and which to skip. The audits themselves were internal documents during development and aren't part of this public release, but the takeaways they produced live in the design of every component listed in [docs/USAGE.md](docs/USAGE.md).

## License compatibility

`claude-bridge` is MIT-licensed. All directly borrowed patterns come from MIT-licensed sources (cc2cc, claude-peers-mcp, claude-relay) or are general design ideas (multiclaude's phasing approach). No license incompatibility.

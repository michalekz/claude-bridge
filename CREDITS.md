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

- **Field layout of `~/.claude/.usage_cache.json`** — five_hour / seven_day / limits[] / spend / extra_usage / experimental codenames. The status-line project's parsing code was the reference for our `src/parser/rate-limits.ts` field shape.

**Factual correction to earlier CREDITS wording (v0.8.3):** The pre-v0.8.3 attribution described `.usage_cache.json` as "Claude Code's own cache." That was wrong. Static analysis of the benabraham source (v5.4.0) confirmed:

- `.usage_cache.json` is **written by the status-line project itself**, not by Claude Code.
- Writes happen only inside benabraham's `fetch_usage_data()` (line 731-735), which is a **deprecated fallback path** kept for Claude Code versions older than 2.1.80.
- CC 2.1.80+ sends `rate_limits` via **stdin JSON to the statusLine hook** directly per render — the file cache is bypassed entirely.

This makes our `rate_limit_status` tool (v0.8.0-v0.8.2) architecturally fragile: it reads a secondary cache belonging to a third-party project, which stops refreshing when CC uses the modern stdin path (i.e. always on any current CC install). The 36-hour-stale cache Zdeněk reported on 2026-07-07 was the surfacing of this design flaw.

**v0.9.0 changes the data source** to (1) a plugin-owned statusLine wrapper that dumps the CC-provided stdin JSON to `~/.claude-bridge/live/statusline.json` on every render, and (2) a PostToolUse hook that calls the OAuth `/api/oauth/usage` endpoint directly as a fallback. The `.usage_cache.json` fossil read is removed in v0.9.0 (breaking change).

Where we diverged from status-line at the tool level: status-line is human-facing (ANSI terminal, single-user, per-render statusLine rendering). Our tool is agent-facing (structured JSON output, cross-peer aware). v0.9.0's statusLine wrapper is designed to co-exist with an existing user statusLine (subprocess passthrough), not replace it.

Bug-fix credit for `contextLimitSource`: **Zdeněk Michálek + jira-architect (HMH)** empirically caught the "Sonnet 5 missing from canonical table → percentUsed inflated 5×" incident on 2026-07-07, drove the `unknown-model-fallback` flag design for v0.8.0-v0.8.2, and — through the follow-up rate_limit_status stale-cache report — drove the v0.8.3 factual correction and the v0.9.0 architecture pivot to live data.

## Indirect references

- [Roo-Code](https://github.com/RooCodeInc/Roo-Code) — Apache 2.0. Studied as a VS Code chat extension reference (multi-mode chat UI, custom agent personas) for understanding the alternative-IDE-side of the multi-agent space. We didn't import code from it.
- **Anthropic's [`Claude Code`](https://github.com/anthropics/claude-code) extension and CLI** — the host environment this plugin extends. The MCP protocol, session JSONL format, and plugin marketplace are upstream.

## Engineering audit history

Each of the four direct-inspiration projects above received an engineering audit during the pre-implementation phase of `claude-bridge`. The audits informed which patterns to adopt and which to skip. The audits themselves were internal documents during development and aren't part of this public release, but the takeaways they produced live in the design of every component listed in [docs/USAGE.md](docs/USAGE.md).

## License compatibility

`claude-bridge` is MIT-licensed. All directly borrowed patterns come from MIT-licensed sources (cc2cc, claude-peers-mcp, claude-relay) or are general design ideas (multiclaude's phasing approach). No license incompatibility.

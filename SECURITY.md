# Security and privacy

## What the plugin reads

`claude-bridge` operates entirely on your local machine. It reads:

- `~/.claude/projects/**/<sessionId>.jsonl` — Claude Code session transcripts (your own conversations with Claude Code).
- `~/.claude-bridge/inbox/<sessionId>/{pending,done}/*.json` — messages exchanged between your Claude Code chats.
- `~/.claude-bridge/status/<sessionId>.json` — heartbeat files of locally running Claude Code chats.

The plugin **never** sends any of this data over the network. There are no external API calls, no telemetry, no analytics endpoints. Everything stays on your filesystem.

## What the plugin writes

Only inside `~/.claude-bridge/` (its own namespace):

- Inbox files for messages it sends to other chats.
- Heartbeat files signalling its presence to other chats.
- No writes to `~/.claude/projects/` or any other Claude Code state.

## Cross-project search scope

`peer_chat_search { scope: 'all-projects' }` reads JSONL files across every project under `~/.claude/projects/`. This is the same filesystem access already available via Claude Code's built-in `Read`, `Glob`, and `Grep` tools — there is no escalation of privileges.

The 30-day age filter and 200 MB scope cap exist purely for performance, not security.

## Reporting vulnerabilities

If you discover a security issue, please email the maintainer at zdenek.michalek@oxyshop.cz with the subject `[SECURITY] claude-bridge: <short description>`.

Please **do not** open a public issue for security problems until a fix is shipped.

A response acknowledging the report should arrive within 5 business days. A fix or mitigation plan follows depending on severity.

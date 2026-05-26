---
name: claude-bridge
description: Use when orchestrating multiple Claude Code chats, reading other chats' history, sending messages between chats, or searching across chat sessions. Triggers on phrases like "peer chat", "sister chat", "other chat", "cross-chat", "what is the other agent doing", "find in chats", "manager agent", "worker agent", "agent-to-agent communication", and similar multi-chat coordination requests.
---

# claude-bridge — Multi-chat orchestration

The `claude-bridge` plugin gives you eight MCP tools to coordinate with other Claude Code chats running on the same machine: see them, message them, read their transcripts, search across them. All file-based, no servers, no API keys. Tools are exposed as `mcp__plugin_claude-bridge_claude-bridge__<tool>`.

## Decision tree — which tool to reach for

```
I want to…
├─ see what other chats are alive            → peer_list
├─ message another chat:
│  ├─ initiate                               → peer_ask
│  └─ respond to incoming message            → peer_reply (with inReplyTo=<msgId>)
├─ explicitly drain my own inbox             → peer_inbox_read (rarely needed — piggyback drains on every tool call)
├─ read another chat's transcript:
│  ├─ last N messages                        → peer_chat_read { lastN }
│  ├─ what they're doing right now           → peer_chat_read { sinceLastUserPrompt: true }
│  ├─ find a specific topic in one chat      → peer_chat_read { query, contextLines }
│  └─ read a dead/historical session by id   → peer_chat_read { to: <uuid>, crossProject: true }
├─ search across many chats:
│  ├─ within current project                 → peer_chat_search { query }
│  └─ across all projects                    → peer_chat_search { query, scope: 'all-projects' }
└─ navigate JSONL history:
   ├─ list all projects                      → list_projects
   ├─ list sessions (with active/title/counts) → list_sessions { includeMeta: true }
   └─ inspect one session's event mix        → session_stats { sessionId }
```

## Identity — `id` vs `name`

Every peer has two identifiers:

- **`id`** — Claude Code sessionId UUID. Always unique, never collides. Use this when you need certainty.
- **`name`** — display slug derived from ai-title or cwd. May collide if two chats share an ai-title. If `peer_ask { to: <name> }` returns `ambiguous_peer`, switch to `id`.

When in doubt, prefer `id`.

## Common workflows

### Workflow 1 — Manager dispatches to workers

You are the manager chat A coordinating workers B and C.

```jsonc
peer_list
// → see workers B, C
peer_ask { "to": "worker-b", "content": "Audit src/auth/* for regressions." }
peer_ask { "to": "worker-c", "content": "Run integration tests and report failures." }
// (workers act asynchronously; their replies arrive via piggyback or push)
peer_inbox_read   // optional — pulls explicit if you've been idle
```

Workers should respond with `peer_reply { inReplyTo: <msgId>, content: ... }`.

### Workflow 2 — Inspect a sister chat without disturbing it

```jsonc
// Just the latest exchange in their chat:
peer_chat_read { "to": "sister-chat", "sinceLastUserPrompt": true }

// Or last 5 messages regardless of structure:
peer_chat_read { "to": "sister-chat", "lastN": 5 }
```

`sinceLastUserPrompt: true` is the semantic anchor — it returns the most recent user prompt plus every assistant turn after it. Far better than guessing `lastN`.

### Workflow 3 — Find a specific decision or discussion

```jsonc
// In one specific chat:
peer_chat_read { "to": "expert-chat", "query": "auth migration", "contextLines": 1 }

// Across the current project (don't know which chat):
peer_chat_search { "query": "auth migration", "contextLines": 1 }

// Across every project on this machine:
peer_chat_search { "query": "auth migration", "scope": "all-projects" }
```

`contextLines: N` includes ±N neighbor messages around each match — useful for context.

### Workflow 4 — Read an archived chat that's no longer running

```jsonc
// Find it first:
list_sessions { "includeMeta": true, "limit": 20 }
// → pick a sessionId from the list (look at aiTitle + userPrompts)

peer_chat_read {
  "to": "<sessionId-uuid>",
  "crossProject": true,
  "lastN": 50
}
```

`crossProject: true` lifts the active-peer requirement — works for any JSONL session under `~/.claude/projects/`, dead or alive.

### Workflow 5 — Survey activity across the machine

```jsonc
list_sessions { "includeMeta": true, "limit": 100 }
// → group by project, sort by userPrompts to find busy chats
```

Each session returns `active`, `aiTitle`, `userPrompts`, `assistantReplies` — enough to pick where to dig deeper.

## Output formats for peer_chat_read

| Format | Best for |
|---|---|
| `markdown` (default) | Reading transcripts naturally — you or a human |
| `compact` | Skimming many messages (≤180 chars per line, ideal for `lastN: 50+`) |
| `json` | Programmatic consumption or further filtering |

Switch with `format: 'compact'` or `format: 'json'`.

## What gets searched, what doesn't

- **`peer_chat_read.query`** and **`peer_chat_search.query`** match **text content only** — not `thinking` blocks, not `tool_use` inputs, not `tool_result` contents. That keeps results signal-heavy.
- **IDE-injected noise** (`<ide_opened_file>`, `<ide_selection>`, `<system-reminder>`) is always stripped before display — never appears in transcripts.
- **Sessions older than 30 days** are excluded from `peer_chat_search` by default. No way to override yet (the 30-day cutoff is a deliberate relevance heuristic).
- **Self session** is excluded from `peer_chat_search` — your own context is already loaded, no point re-reading it.

## Counting messages — be precise

Naive `grep` counting `"type":"user"` + `"type":"assistant"` lines in a JSONL file overcounts dramatically. The real metrics in `list_sessions { includeMeta: true }`:

- **`userPrompts`** — real user inputs. Excludes tool_result wrappers (which are inflated by ~10× in tool-heavy sessions).
- **`assistantReplies`** — assistant events with `stop_reason='end_turn'`. One per "agent finished, your turn" moment.

A naive count of 2000 events might map to 90 actual prompts and 125 actual replies. When reporting activity, use these properly-scoped counts.

## Common errors and what they mean

| Error code | Meaning | Fix |
|---|---|---|
| `peer_not_found` | No active peer with that id/name | Run `peer_list` to see who's actually online. In VS Code Extension, the target chat must have been activated (clicked) since the last reload. |
| `ambiguous_peer` | Multiple peers share that name | Switch from `name` to `id` (UUID from `peer_list`). |
| `original_not_found` | `peer_reply` can't find the original | Since v0.3.1 checks both `pending/` and `done/` — if still missing, the msgId is wrong (typo). |
| `session_file_not_found` | Peer exists but its JSONL doesn't | Brand new chat without a first prompt — wait until they send something. |
| `invalid_query_regex` | `queryRegex: true` got an uncompilable pattern | Read the message's detail (it includes the regex compile error). |
| `scope_too_large` | `peer_chat_search` filtered scope > 200 MB | Narrow with `scope: 'project'` instead of `all-projects`, or refine `query` to be more selective. FTS5 backend planned for very large scopes. |
| `self_read` | Tried to read or search own session | The current chat is already in context — read from history instead. |
| `self_send` | Tried to `peer_ask` self | Use direct reasoning instead. |

## Delivery model — push vs piggyback

Messages are delivered in one of two modes:

- **Push channel** — if the user has `channelsEnabled: true` plus the plugin in `allowedChannelPlugins` (admin-controlled), messages arrive in real time as a `<channel>` tag in the receiver's context.
- **Piggyback fallback** — without push, messages wait in `pending/` and surface in the receiver's tool output on their next MCP call. Always reliable, just with latency tied to the receiver's activity.

You don't choose — the plugin uses push when available, piggyback otherwise. From the consumer side it's seamless. If push fires and shows you the message inline, the same message will NOT be re-rendered in the piggyback block on the next tool call (deduplicated since v0.3.2).

## Anti-patterns — don't do these

- **Don't poll `peer_inbox_read` in a loop.** Piggyback drains on every tool call. Polling adds nothing.
- **Don't use `peer_chat_search` when you know the peer.** Use `peer_chat_read { query }` — same matching, one session scope, faster, less noise.
- **Don't use `peer_chat_read` with `to: <self.id>`.** Returns `self_read`. Your own conversation history is already in your context.
- **Don't `peer_ask` and then immediately `peer_chat_read` to see the reply.** Wait for the reply to come back via piggyback or push; reading the peer's chat right after a send shows you their state from BEFORE they processed your message (race-prone).
- **Don't load `peer_chat_read` with `includeThinking: true` unless you specifically need chain-of-thought.** Thinking blocks are often 5–10× the size of the visible answer.
- **Don't gate `peer_chat_search` results without context.** If you get 50 matches, use `contextLines: 1` to surface enough surrounding text to judge relevance — bare matches without context are usually too thin to evaluate.

## Data layout (for debugging)

The plugin lives entirely in `~/.claude-bridge/` (its own namespace; never touches Claude Code internals):

```
~/.claude-bridge/
├── inbox/<sessionId>/
│   ├── pending/<msg-id>.json   ← incoming messages not yet drained
│   └── done/<msg-id>.json      ← already consumed, available for peer_reply
└── status/<sessionId>.json     ← heartbeat (refreshed every 5s)
```

If `peer_list` looks empty or wrong, `ls ~/.claude-bridge/status/` shows the raw heartbeat files — anything within 30 seconds of `now` is considered active.

## Performance characteristics

- `peer_list` — single directory scan, <10 ms.
- `peer_ask`, `peer_reply` — atomic file write, <50 ms.
- `peer_chat_read` — stream parse one JSONL, 50–200 ms per MB.
- `peer_chat_search` (current project, typical dev box) — ~350 ms across 30 sessions.
- `peer_chat_search` (all projects, large notebook) — may hit `scope_too_large` if >200 MB after 30-day filter.
- `list_sessions { includeMeta: true }` — streams every JSONL once. Several seconds for 50+ sessions.

When orchestrating, lean on cheap tools (`peer_list`, default `list_sessions`) before expensive ones (`includeMeta`, full search).

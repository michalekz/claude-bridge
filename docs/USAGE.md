# Detailed usage guide

This document is the reference for every tool the plugin ships — what each does, what arguments it takes, what the output looks like, and when to reach for it. Recommended reading order: start with "Peer chat identity", then skip to whichever tool is interesting. The end of the document has ready-made recipes for typical workflows.

## Peer chat identity

Before diving into specific tools, understand how the plugin tells chats apart. Every peer has two identity layers:

**`id`** is the Claude Code sessionId — a UUID like `09de67fe-2b3b-45d1-a576-aec89ffaf8c7`. Always unique, never collides. Use this when you need certainty. Plugin uses it as the stable key for the inbox directory and heartbeat file.

**`name`** is a human-readable slug — typically derived from the ai-title (`explore-mcp-server-claude-bridge`) or from the project name (`opt-claude-bridge`). The slug **can collide** if two chats share an ai-title. If that happens, the plugin returns an `ambiguous_peer` error listing the colliding `id`s.

**`displayName`** is the original raw title from the UI, without slugification (typically "Explore MCP server claude-bridge"). The plugin doesn't use it for routing — only for human-readable output.

Cascade for display name resolution, in priority order:

1. **`custom-title`** / **`ai-title`** event from the current JSONL (Claude Code emits one after the first user message).
2. **`session.json .name`** (if the user renamed the chat via `/name`).
3. **Env var** `CLAUDE_BRIDGE_PEER_NAME` (override for orchestrators).
4. **Slug from `basename(cwd)`** (fallback — collisions OK, `id` stays unique).

Refresh runs every 5 s — if a chat starts without an ai-title, it arrives shortly after.

## Tools — complete reference

Tools are exposed in Claude Code as `mcp__plugin_claude-bridge_claude-bridge__<tool>`. The plugin's pre-approval hook clears them automatically — no user confirmation needed.

---

### `peer_list`

Returns every active Claude Code chat on the same machine. No arguments.

**When to use:** the first tool you call in any workflow. Without it you don't know who's available.

**Output contains:**

- `self` — your own chat (id, name, displayName)
- `peers[]` — array of other active chats with metadata (id, name, displayName, pid, cwd, ageMs, source, version)

**Typical example:**

```jsonc
peer_list

// result (truncated)
{
  "self": { "id": "fb74…", "name": "restore-missing-chat", "displayName": "Restore missing chat" },
  "peers": [
    { "id": "09de…", "name": "explore-mcp-server", "ageMs": 3500, "version": "0.5.0" }
  ]
}
```

If a peer's `ageMs` is over 30,000 (30 s), it's probably offline — heartbeats should arrive every 5 s.

---

### `peer_ask`

Writes a message into another chat's inbox. Delivery is always reliable — even if the target chat is idle, the message waits in `pending/` and is delivered on the chat's next activity.

**Arguments:**

- `to` (required) — `id` (UUID) or `name` of the target chat. If `name` collides, returns `ambiguous_peer`.
- `content` (required) — message text. Max 64,000 characters.
- `threadId` (optional) — correlation ID for multi-turn dialog.

**Example:**

```jsonc
peer_ask {
  "to": "explore-mcp-server",
  "content": "Find every mention of agent teams in our history and summarize."
}
```

Returns `msgId`, which the other chat can use later in `peer_reply`. If `to` doesn't match any active peer, returns `peer_not_found`.

---

### `peer_reply`

Replies to a previously received message. The plugin looks up the original in the `done/` (or, since v0.3.1, also `pending/`) archive and routes the reply back to the original sender — you don't need to remember who it was.

**Arguments:**

- `inReplyTo` (required) — `msgId` of the message you're answering (from a piggyback block or `peer_inbox_read`).
- `content` (required) — reply text.

**Example:**

```jsonc
peer_reply {
  "inReplyTo": "mplr29k9-7e708b26",
  "content": "Twelve mentions total — main themes: experimental flag and lead/teammate hierarchy."
}
```

If `inReplyTo` doesn't match any message in your archive (typically because you haven't yet received/drained it), returns `original_not_found`.

---

### `peer_inbox_read`

Drains all `pending/` messages into your `done/` archive and returns them. You usually **don't need to call this** — the plugin automatically drains pending messages after every successful MCP tool call (piggyback consumption) and appends them to the output.

**Arguments:** none.

**When to use it anyway:** when you want to drain explicitly. For instance, at the start of a conversation to see what arrived while you were idle.

---

### `peer_chat_read`

The key tool of the plugin. Reads another chat's transcript — either the last N messages, messages from a specific timestamp onward, or messages matching a query.

While reading, the plugin automatically:

- **Strips IDE-noise tags** (`<ide_opened_file>`, `<system-reminder>`, etc.) — the agent sees clean content.
- **Finds the ai-title** of the target session and uses it as the peer name in the header (even for inactive chats).
- **Truncates** `tool_use` inputs and `tool_result` content over 500 characters (when `includeToolCalls: true`).

#### Arguments

| Arg | Default | Effect |
|---|---|---|
| `to` (required) | – | `id` (UUID) or `name` of the target chat |
| `lastN` | 10 | Return last N messages |
| `sinceTimestamp` | – | ISO 8601 — only messages at or after this time |
| `sinceLastUserPrompt` | `false` | Semantic anchor — return everything from the peer's most recent user prompt onward |
| `maxBytes` | 30 000 | Hard cap on output size; oldest dropped first |
| `includeToolCalls` | `false` | Include `tool_use` (assistant side) and `tool_result` (user side) blocks |
| `includeThinking` | `false` | Include assistant `thinking` blocks (often very large) |
| `rolesOnly` | both | Restrict to specific roles, e.g. `["user"]` for prompt-only view |
| `crossProject` | `false` | Allow reading any session by UUID, regardless of whether the peer is active or in another project |
| `format` | `"markdown"` | Output format: `markdown` (readable), `json` (structured), `compact` (one-line skim) |
| `query` | – | Filter to messages containing this substring (case-insensitive) |
| `queryRegex` | `false` | Treat `query` as a regex pattern |
| `contextLines` | 0 | When `query` is set, include ±N neighbour messages around each match |

#### Example 1: Recent messages

```jsonc
peer_chat_read { "to": "explore-mcp-server", "lastN": 5 }
```

Returns the 5 most recent user+assistant messages as markdown.

#### Example 2: What is the chat doing right now

```jsonc
peer_chat_read { "to": "explore-mcp-server", "sinceLastUserPrompt": true }
```

Returns the chat's last user prompt plus everything the agent has produced since. Better than guessing `lastN`.

#### Example 3: Searching

```jsonc
// substring (case-insensitive)
peer_chat_read {
  "to": "explore-mcp-server",
  "query": "agent teams"
}

// substring with context
peer_chat_read {
  "to": "explore-mcp-server",
  "query": "agent teams",
  "contextLines": 2
}

// regex pattern
peer_chat_read {
  "to": "explore-mcp-server",
  "query": "PID \\d+",
  "queryRegex": true
}
```

A malformed regex returns `invalid_query_regex` with a specific reason.

#### Example 4: Cross-project / dead session

```jsonc
peer_chat_read {
  "to": "09de67fe-2b3b-45d1-a576-aec89ffaf8c7",
  "crossProject": true,
  "lastN": 20
}
```

Works against any JSONL session in any of your projects — regardless of whether that chat is running. Useful when you want to look at history you no longer have access to in the UI.

#### Example 5: User prompts only

```jsonc
peer_chat_read {
  "to": "explore-mcp-server",
  "lastN": 30,
  "rolesOnly": ["user"]
}
```

Returns only user prompts (no assistant replies). Useful for the overview of "what was this chat all about".

#### Output formats

**`markdown`** (default) — readable transcript with a header. Use it when you want to show the output to a human or read it yourself.

**`json`** — structured data. Use it when post-processing the output programmatically.

**`compact`** — one short line per message, text trimmed to ~180 chars. Ideal for skimming larger numbers of messages (50–500).

---

### `peer_chat_search`

Cross-session text search across the current project (default) or all projects. While `peer_chat_read.query` searches inside a single session, `peer_chat_search` answers "where, in any of my chats, did we talk about X" — without needing to know the specific peer or session ID.

When searching, the plugin automatically:

- **Excludes your own session** (already in your context, nothing to find).
- **Skips sessions older than 30 days** (hardcoded — older history isn't in scope yet).
- **Matches only text content** of messages — not `thinking`, not `tool_use` inputs, not `tool_result` content. This dramatically reduces false positives and noise.

#### Arguments

| Arg | Default | Effect |
|---|---|---|
| `query` (required) | – | Text to search (substring) or regex pattern |
| `queryRegex` | `false` | Treat `query` as a regex pattern (case-insensitive) |
| `scope` | `"project"` | `"project"` = current project only; `"all-projects"` = every project |
| `contextLines` | 1 | Include ±N neighbour messages around each match |
| `maxMatches` | 30 | Stop scanning after N matches collected |
| `maxBytes` | 30 000 | Hard cap on output size (oldest dropped first) |

#### Example 1: Find a topic in the current project

```jsonc
peer_chat_search { "query": "agent teams" }
```

Returns markdown with a header (count of scanned sessions, hits, total matches) and sections per session with matches plus context.

#### Example 2: Regex across every project

```jsonc
peer_chat_search {
  "query": "version \\d+\\.\\d+\\.\\d+",
  "queryRegex": true,
  "scope": "all-projects",
  "maxMatches": 50,
  "contextLines": 2
}
```

#### Example 3: What "scope_too_large" looks like

```jsonc
{
  "ok": false,
  "code": "scope_too_large",
  "message": "Filtered scope is 540 MB across 89 sessions — over the 200 MB cap. Reduce by using scope='project' or wait for FTS5 backend (v0.5+)."
}
```

How to handle it:

- Narrow to `scope: 'project'` (default).
- Or wait for the FTS5 backend in a future release (lazy-built index, queries in tens of milliseconds even for 1 GB+ datasets).

#### Output format

Markdown with a header plus per-session sections:

```markdown
# Search: `agent teams` (substring, scope=project)
**Scope:** 12 sessions × 47 MB scanned in 1840 ms
**Hits:** 5/12 sessions, 18 matches

---

## Explore MCP server `09de67fe` — 8 matches
**Project:** `-opt-claude-bridge` | mod 2026-05-25T22:43:38.031Z

### [10:00:15] user `a4f067` _(context)_
previous prompt...

### [10:00:42] assistant `b9133f` **← match**
Reply mentioning agent teams...

### [10:01:08] user `c2e5d4` _(context)_
following message...
```

If the output exceeds `maxBytes`, the last session is trimmed and a note is added.

---

### `list_projects`

Lists every Claude Code project under `~/.claude/projects/`. No arguments.

**When to use:** when orienting in local history — which projects exist, where their session JSONL files live.

---

### `list_sessions`

Lists session JSONL files across every project, sorted newest first.

**Arguments:**

- `project` (optional) — restrict to a specific project dir (e.g. `-opt-claude-bridge`).
- `limit` (optional, default 50) — max number of sessions returned.
- `includeActive` (default `true`) — include `active` boolean per session (recent heartbeat <30 s). Cheap — single stat per session.
- `includeMeta` (default `false`) — include `aiTitle`, `userPrompts`, and `assistantReplies` per session. Streams each JSONL once — expensive (~50–200 ms per MB). Use when building a dashboard view; skip for a quick metadata-only listing.

**Output fields per session:**

| Field | Source |
|---|---|
| `project`, `sessionId`, `file`, `sizeKB`, `modifiedAt`, `filename` | Always |
| `active` | When `includeActive: true` (default) |
| `aiTitle` | When `includeMeta: true` |
| `userPrompts` | When `includeMeta: true` |
| `assistantReplies` | When `includeMeta: true` |

**On counting messages — be precise.** A naive grep of `"type":"user"` plus `"type":"assistant"` lines in a JSONL file overcounts dramatically (10× or more in tool-heavy sessions). The proper metrics used here:

- **`userPrompts`** — real user inputs. Excludes tool_result wrappers (where the assistant called a tool and its result came back as a `user` event).
- **`assistantReplies`** — assistant events with `stop_reason='end_turn'`. One per "agent finished, your turn" moment.

A naive count of 2000 events might map to 90 actual prompts and 125 actual replies. When reporting activity, use these properly-scoped counts.

**When to use:** typically before `peer_chat_read` with `crossProject: true` — you need to know which UUID session you want to read. Or as a dashboard query (with `includeMeta: true`).

---

### `session_stats`

For a specific session, returns event counts grouped by type (user, assistant, tool_use, etc.).

**Arguments:**

- `sessionId` (required) — session UUID.
- `project` (optional) — restrict to a specific project.

**When to use:** quick drill-down "what's in that session". Useful when you have a list of sessions from `list_sessions` and want to pick the one with the most activity.

---

## Ready-made recipes

Combinations of tools for typical workflows.

### Recipe 1: Manager dispatches to workers

Coordinator chat A managing worker chats B and C.

```jsonc
// A: see who's available
peer_list

// A: assign a task to B
peer_ask { "to": "worker-b", "content": "Find every TODO comment in the repo and classify them." }

// A: assign a task to C
peer_ask { "to": "worker-c", "content": "Run the tests and send me the failed list." }

// (B and C work asynchronously; they reply via peer_reply)
// A: check inbox after a few minutes (or messages will piggyback on any other tool call)
peer_inbox_read
```

### Recipe 2: Audit what a sister chat was doing

You want to understand what your other chat achieved over the last hour.

```jsonc
peer_chat_read {
  "to": "other-chat",
  "sinceTimestamp": "2026-05-25T20:00:00Z",
  "rolesOnly": ["user"],
  "format": "compact"
}
```

User prompts from the last hour as a one-line skim. When you spot an interesting prompt, focus on that section:

```jsonc
peer_chat_read {
  "to": "other-chat",
  "query": "specific topic from previous step",
  "contextLines": 2
}
```

### Recipe 3: Find a decision made somewhere

You suspect that you and the other agent discussed a decision a few hours ago — you just don't know in which chat or session.

```jsonc
// Easiest path: peer_chat_search across the current project
peer_chat_search {
  "query": "keyword",
  "contextLines": 2
}
```

If the current project isn't enough, opt into all-projects:

```jsonc
peer_chat_search {
  "query": "keyword",
  "scope": "all-projects",
  "contextLines": 2
}
```

If you want to walk individual sessions (e.g., before FTS5 era):

```jsonc
// List all sessions in this project
list_sessions { "project": "-opt-claude-bridge" }

// For each candidate, try searching
peer_chat_read {
  "to": "<sessionId-from-list>",
  "crossProject": true,
  "query": "keyword",
  "contextLines": 3,
  "format": "markdown"
}
```

### Recipe 4: Send a message, wait for reply

Synchronous workflow — send a question, wait for the response.

```jsonc
// Send
peer_ask { "to": "expert-chat", "content": "How do I solve X?", "threadId": "q-1" }
// → returns msgId

// The other chat answers via peer_reply with inReplyTo=<msgId>

// You then either see the answer immediately (with channel)
// or on your next tool call (piggyback)
peer_inbox_read
// → find the reply with inReplyTo == <your-original-msgId>
```

`threadId` enables multi-round dialog in one conversation — every message with the same threadId forms a logical group.

## When something doesn't work

Most problems are handled in [INSTALL — troubleshooting](INSTALL.md#common-problems-and-fixes). Specifically for tools:

- **`peer_ask` returns `peer_not_found`:** the other chat isn't in `peer_list`. In VS Code Extension, activate the second tab by clicking and wait 5–10 s. In the terminal CLI, the peer is visible immediately on startup.
- **`peer_reply` returns `original_not_found`:** the message isn't in `done/` or `pending/`. Since v0.3.1 the plugin checks both — if you still get this error, the msgId is genuinely unknown (typo). Before v0.3.1 the user had to call `peer_inbox_read` manually first.
- **`peer_chat_read` returns `session_file_not_found`:** the peer is in the heartbeat list, but its JSONL doesn't exist yet (typically a brand-new chat without a first prompt). Wait for the user to send something.
- **`peer_chat_read.query` / `peer_chat_search` regex throws `invalid_query_regex`:** the regex failed to compile. The error message contains the specific reason (unclosed group, unknown flag, etc.).
- **`peer_chat_search` returns `scope_too_large`:** the filtered scope (after 30-day cutoff) exceeded the 200 MB cap. Narrow to `scope: 'project'` or wait for the FTS5 backend (future release).

## See also

- **[Main README](../README.md)** — short plugin summary.
- **[Installation and configuration](INSTALL.md)** — how to add the plugin to Claude Code and configure real-time push.

# claude-bridge

🇬🇧 English · 🇨🇿 [Česky](README.cs.md)

> Claude Code plugin built primarily for VS Code — lets two or more chats/agents in VS Code talk to each other, look into each other's history, and use that history as a library accessible to both users and agents. No copy-paste between windows, no server, no API keys — everything goes through the local filesystem.

[![claude-bridge demo — one manager and three worker chats coordinating live in a single VS Code window](assets/hero.gif)](https://youtu.be/Oe_YQqUNnsg)

<sub>▶ **[Watch the full demo](https://youtu.be/Oe_YQqUNnsg)** — one manager fans tasks out to three workers in a single **VS Code** window, they reply in real time, and you can read or search across every chat.</sub>

Built by [Zed Michalek](https://github.com/michalekz) at [oXyShop](https://oxyshop.cz). MIT licensed.

**Built for the multi-chat workflow in VS Code** — keep several Claude Code chats open side by side in the integrated terminal and let them coordinate. It works just as well from the plain `claude` terminal; a few characteristics differ between the two — see [CLI vs VS Code](docs/INSTALL.md#cli-vs-vs-code-extension) in the install guide.

## Why this exists

If you keep two or more Claude Code chats open side by side in VS Code, you eventually hit the same friction: one chat is working on something the other already knows, or needs to ask it a question. Today the answer is usually "copy the message from one window into the other". Or you ask Claude to figure the same thing out twice.

`claude-bridge` changes that. Chats can message each other, read what the next-door chat is currently working on, or search across every transcript on the machine.

## What the plugin actually adds

After installation, each chat gets a set of new MCP tools opening five categories of workflow:

**See other chats.** `peer_list` shows every active Claude Code chat on the same machine — its name, sessionId, cwd, age of last activity. A coordinating chat learns who is available.

**Send a message.** `peer_ask` writes a message into another chat's inbox; `peer_reply` answers a previously received message. Delivery is reliable even when the target chat is idle — the message waits in its inbox and arrives on the chat's next activity (or in real time, if the push channel is enabled).

**Read another chat's content.** `peer_chat_read` returns a sister chat's transcript — the last few messages, everything since its most recent user prompt, or messages matching a query (substring or regex). Supporting tools `list_projects`, `list_sessions`, and `session_stats` expose JSONL history metadata across all your projects.

**Search across chats.** `peer_chat_search` looks for arbitrary text across every session in the current project (default) or every project on the machine. Useful when you don't remember which chat discussed something but know the topic.

**Monitor context window** *(v0.7.0+)*. `peer_context_status` reads autocompact-relevant statistics for self or any peer — tokens used, % of context window consumed, risk bucket (low/medium/high), model id. Data comes from `cache_read_input_tokens` in the JSONL — matches `/context` Total exactly. `peer_set_context_guard` lets a peer set its own warn/critical thresholds (default 85% / 95%). `peer_set_notification` toggles idle-beep notifications. `model_info` returns canonical Claude model metadata (context window, max output, pricing, capabilities, lifecycle status) — no JSONL scan, just an in-process table sourced from Anthropic platform docs.

### Bundled role playbooks *(v0.7.0+)*

For agents in specific orchestration roles, two practitioner-grounded skill playbooks ship with the plugin:

- **`claude-bridge-role-manager`** — playbook for an agent orchestrating 2-N worker peers. 11 load-bearing principles (Manager doesn't produce output — Manager produces trust in output; scale rigor to stakes; gating by reversibility × blast-radius × outward-facing; verify-don't-guess; worker output = data not authorization; hub-and-spoke contracts + mesh consult; async messages cross — thread via `inReplyTo`; FREEZE artifact at "ready-for-gate"; manage upward to the human). Detailed PLAYBOOK.md covers dispatch templates, multi-verification gates, pre-flight downstream isolation, anti-patterns, memory model, onboarding, incident response, cross-machine handoffs.

- **`claude-bridge-role-memory-keeper`** — LIGHT playbook for a dedicated memory-keeper peer in teams of 3+. 5 load-bearing principles (single-writer / route-to-keeper; pointer-not-duplicate; doc-wins-on-conflict + escalate-doc-error; verify-before-write + dedup-across-senders; reconcile-pass after every coordination round). 8-step write workflow + reconcile-pass workflow.

Both skills emerged from 3-way convergence across independent practitioner teams. See [USAGE.md](docs/USAGE.md) for invocation patterns.

## When it's useful

The situations where the plugin pays off most:

**Two agents disagreeing on something.** A coordinator chat dispatches tasks to worker chats, listens to their answers, and routes the next step. One user, three chats running in parallel.

**You need context that lives in the neighbouring window.** "Hey, tell me what you and the other agent figured out about agent teams." Instead of switching tabs and re-reading backlog, chat A pulls the relevant section directly from chat B.

**Finding when a decision was made.** `peer_chat_read` with `query` finds the place where a specific topic was discussed, with surrounding context. `peer_chat_search` does the same across many sessions when you don't know where to look.

**Auditing what agents did overnight.** Read-only access to JSONL history lets you walk through next morning's standup — what was assigned, how it evolved.

## How is this different from Agent Teams?

Claude Code's experimental Agent Teams let the model spawn and coordinate **ephemeral subagents** inside a session — great for "one prompt, fan out internally." claude-bridge solves a different problem: making **your own, real, persistent chats** cooperate.

| | Agent Teams (native) | claude-bridge |
|---|---|---|
| What the peers are | ephemeral subagents the model spawns | your real chats — you type into them too |
| Read **and** write as a human | — | ✅ in every peer chat |
| Reachable when idle | needs a live monitor | ✅ inbox waits, drains on next activity |
| Read another chat's transcript | — | ✅ `peer_chat_read`, on demand (doesn't pollute context) |
| Search across chats' history | — | ✅ `peer_chat_search` (project or all-projects) |
| Per-chat stats | — | ✅ `session_stats` breaks down any conversation |
| Survives a chat "deleted" in the UI | — | ✅ the JSONL stays on disk and is still readable |
| Cross-project / observability | — | ✅ search **and** read across every project, read-only |
| **Context-usage monitoring** | — | ✅ `peer_context_status` — see who's near autocompact (v0.7.0+) |
| **Role-specific playbooks** | — | ✅ bundled `claude-bridge-role-manager` + `claude-bridge-role-memory-keeper` (v0.7.0+) |

The deeper shift: your chats stop being closed, throwaway sessions and become an **open, queryable library** — one that both you and your agents can actually work with. That wasn't really possible before.

They're complementary, not competing, and both are still evolving. claude-bridge works today over the local filesystem, from the CLI and (mostly) the VS Code extension.

## A few first examples

### Who is available

```
peer_list
```

Returns a list of active chats. Each has an `id` (UUID, always unique) and a `name` (human-readable slug; may collide if two chats share an ai-title).

### Message a sister chat

```jsonc
peer_ask {
  "to": "explore-mcp-server",
  "content": "Find every mention of agent teams in our history and summarize."
}
```

The target chat sees it either immediately (with push channel enabled — see INSTALL) or on its next MCP tool call (piggyback fallback — always reliable, just with a small latency).

### See what another chat is doing right now

```jsonc
peer_chat_read {
  "to": "explore-mcp-server",
  "sinceLastUserPrompt": true
}
```

Returns the sister chat's most recent user prompt plus everything the agent has produced since. Better than guessing `lastN`.

### Find a specific mention in one chat

```jsonc
peer_chat_read {
  "to": "explore-mcp-server",
  "query": "agent teams",
  "contextLines": 1
}
```

Finds every message containing "agent teams" (case-insensitive) plus one neighbour message before and after for context. Add `"queryRegex": true` for pattern matching.

### Search across the whole project

```jsonc
peer_chat_search {
  "query": "agent teams",
  "contextLines": 1
}
```

Returns matches from every chat in the current project. Default skips sessions older than 30 days.

### Search across every project

```jsonc
peer_chat_search {
  "query": "auth decision",
  "scope": "all-projects"
}
```

Scans every chat under `~/.claude/projects/`. If the filtered scope exceeds 200 MB, returns `scope_too_large` with a hint to narrow the query.

### Read a closed session that's no longer in the UI

```jsonc
peer_chat_read {
  "to": "09de67fe-2b3b-45d1-a576-aec89ffaf8c7",
  "crossProject": true,
  "lastN": 20
}
```

Works against any JSONL session in any of your projects — `crossProject: true` lifts the active-peer requirement.

### See who's close to autocompact *(v0.7.0+)*

```jsonc
peer_context_status { "to": "all" }
```

Returns per-peer `tokensUsed`, `contextLimit`, `percentUsed`, `autocompactRisk` (low/medium/high), and `model`. Use it before dispatching a long task — pick a fresh worker rather than one already at 85%.

### Set your own context guard *(v0.7.0+)*

```jsonc
peer_set_context_guard {
  "warnAtPercent": 0.85,
  "criticalAtPercent": 0.95,
  "notifyPeerIds": ["<manager-uuid>"]
}
```

Persists to `~/.claude-bridge/guard/<sessionId>.json`. Future wake-time injection (v0.7.x) will fire warnings to subscribers when the threshold is crossed.

### Look up canonical model metadata *(v0.7.3+)*

```jsonc
model_info { "model": "claude-opus-4-7" }
```

Returns context window, max output, pricing, capabilities (vision / extended thinking / adaptive thinking), knowledge cutoff, lifecycle status (current/legacy/deprecated). Static lookup, no JSONL scan. Source: Anthropic platform docs.

## Things to keep in mind

The plugin runs **locally, on one machine**. Inbox traffic goes through the local filesystem, not over the network. Not yet suitable for distributed teams across machines.

**Out of the box: piggyback delivery works with zero setup.** Send a `peer_ask` and the recipient sees it on its next tool call. Guaranteed delivery, no configuration needed.

**Optional upgrade: real-time push channels.** For inline `<channel>` rendering the moment a message arrives, three pieces line up: `channelsEnabled: true` in user or managed settings, the plugin listed in `allowedChannelPlugins`, and `--channels plugin:claude-bridge@<marketplace>` at Claude Code launch. Teams/Enterprise accounts need the admin to set this in managed settings; Console accounts can opt-in at the user level. The basic setup is in [INSTALL](docs/INSTALL.md#real-time-push--why-and-how); [CHANNELS-TROUBLESHOOTING](docs/CHANNELS-TROUBLESHOOTING.md) is the deep guide when something doesn't connect.

**VS Code Extension has lazy tab activation.** After window reload, the MCP server inside a chat tab only starts after you click the tab. Until then, that chat isn't visible in `peer_list`. The terminal CLI doesn't have this limitation — the chat is visible immediately.

**Search is fast on a dev box, slower on a notebook with many projects.** With ~5–15 projects and <50 MB total, `peer_chat_search` answers in 1–2 seconds. On a notebook with 50+ projects, `scope: 'all-projects'` may return `scope_too_large` (>200 MB). An FTS5 backend for very large scopes is planned for a future release.

## Documentation

- **[Installation and configuration](docs/INSTALL.md)** — installation via marketplace, channels setup (two independent gates), CLI vs VS Code Extension comparison, cross-platform shell snippets, troubleshooting.
- **[Channels troubleshooting](docs/CHANNELS-TROUBLESHOOTING.md)** — deep reference when real-time push doesn't work. Three-gate model, OS-specific gotchas (Linux/macOS vs Windows), error-symptom catalog, filesystem-trace diagnostic procedure.
- **[Detailed usage guide](docs/USAGE.md)** — every tool with arguments, examples, output formats, and workflow recipes.
- **[Changelog](CHANGELOG.md)** — release history.
- **[Security and privacy](SECURITY.md)** — what the plugin reads, what it writes, vulnerability disclosure.
- **[Credits](CREDITS.md)** — open source projects whose patterns shaped this one.

## Questions & ideas

Have a question, a workflow to share, or a feature in mind? Open a thread in [GitHub Discussions](https://github.com/michalekz/claude-bridge/discussions):

- **[Show & tell](https://github.com/michalekz/claude-bridge/discussions/categories/show-and-tell)** — how you use claude-bridge, screenshots, workflows.
- **[Ideas](https://github.com/michalekz/claude-bridge/discussions/categories/ideas)** — what it should do next.
- **[Q&A](https://github.com/michalekz/claude-bridge/discussions/categories/q-a)** — "is it supposed to work this way?"

Found a bug? Open an [Issue](https://github.com/michalekz/claude-bridge/issues) instead.

## Credits

`claude-bridge` borrows specific patterns from earlier open-source explorations of Claude Code cross-chat coordination:
[cc2cc](https://github.com/non4me/cc2cc) (atomic write + piggyback),
[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) (push channel),
[claude-relay](https://github.com/innestic/claude-relay) (factory closure pattern),
[multiclaude](https://github.com/dlorenc/multiclaude) (phase planning).
Full attribution and design notes in [CREDITS.md](CREDITS.md).

## License

MIT — see [LICENSE](LICENSE).

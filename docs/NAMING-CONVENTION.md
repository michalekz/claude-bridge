# Naming convention — claude-bridge

Conventions for MCP tools and skills in the claude-bridge plugin. Verified by audit on 2026-06-29.

## MCP tools

Tools use **snake_case**.

### Categories by pattern

| pattern | usage | example |
|---|---|---|
| `list_<entities>` | read a collection | `list_projects`, `list_sessions` |
| `<entity>_<noun>` | statistics for a single entity | `session_stats`, `peer_context_status` |
| `peer_set_<noun>` | self-write (a peer sets its own config) | `peer_set_context_guard`, `peer_set_notification` |
| `peer_<noun>_read` | self-read | `peer_inbox_read` |
| `peer_<noun>_<read\|search>` | cross-peer read | `peer_chat_read`, `peer_chat_search` |
| `peer_<verb>` | communication action | `peer_ask`, `peer_reply` |

### Rules

- **Consistent verbs and nouns:** A tool name ends with a **noun**, not a verb. `peer_set_notification` ✓, ~~`peer_set_notify`~~ ✗.
- **`peer_set_*` = self-only:** Tools with the `peer_set_` prefix always operate on the peer's own session (you cannot set another peer's config). A tool with a `to` parameter may be cross-peer (`peer_context_status`).
- **`peer_*_read` / `peer_*_search` may be cross-peer:** These actions take a `to` parameter and read another peer's data.
- **Communication verbs:** `peer_ask` (new message), `peer_reply` (response). A future `peer_broadcast` follows the same pattern (`peer_<verb>`).

### Known exceptions (legacy)

| tool | why it doesn't fit | decision |
|---|---|---|
| `peer_list` | Should be `list_peers` to align with `list_projects`/`list_sessions`. | **Keep** — published API since v0.2.0, rename = breaking change. Consider an alias + deprecation in a MAJOR release (v1.0+). |

## Skills

Skills use **kebab-case** with the `claude-bridge-` prefix.

### Categories

| pattern | usage | example |
|---|---|---|
| `claude-bridge` | top-level intro / index skill | `claude-bridge` |
| `claude-bridge-role-<role-name>` | role-based playbook (= a peer's identity in the team) | `claude-bridge-role-manager`, `claude-bridge-role-memory-keeper` |
| `claude-bridge-<task>` | operational pattern / specific task | `claude-bridge-cleanup` |

### Decision rule

- **Role-based** = the skill describes **who the peer is** in the team (manager, memory-keeper, integration-dev, test-engineer, ...). Use the `claude-bridge-role-*` prefix.
- **Operational** = the skill describes **what the peer does** in a specific task (cleanup before compact, ...). Use `claude-bridge-*` without `-role-`.

### Rules

- **No "-agent" suffix:** All skills are for agents, so "-agent" is redundant. `claude-bridge-role-manager` ✓, ~~`claude-bridge-role-managing-agent`~~ ✗.
- **No skill without the `claude-bridge-` prefix:** The plugin's skills must carry the prefix so they don't clash in a multi-plugin marketplace.
- **Role-name = role in the team**, not a specialization. "manager" = generic orchestrator role; "memory-keeper" = specialist for shared memory. Avoid overly narrow names (don't use "ticket-tracker" — that is business-domain-specific, not a universal role).

## Process for adding a new tool / skill

1. **Name it according to the convention above.** If it's a new pattern (= none of the categories fit), first extend this convention.
2. **Audit existing names** — `grep -r "<proposed name>"` in `servers/` and `local/`, avoid collisions.
3. **For tools:** add to `servers/claude-bridge/src/mcp/tools.ts` + zod schema + handler.
4. **For skills:** add to `skills/<skill-name>/SKILL.md` + optionally `PLAYBOOK.md` (= on-demand detail).
5. **Update this convention** — if you introduce a new pattern (= a new category), document it.

## History

- **2026-06-29** — Counterpart audit (`peer_set_notify` → `peer_set_notification` rename before release; `claude-bridge-memory-delegate` dropped as redundant). Convention documented in this file.
- **2026-06-29** — Skill convention `claude-bridge-role-*` introduced.

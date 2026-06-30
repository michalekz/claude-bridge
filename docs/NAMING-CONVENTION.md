# Naming convention — claude-bridge

Konvence pro MCP tools a skills v claude-bridge pluginu. Verifikováno auditem 2026-06-29.

## MCP tools

Tools používají **snake_case**.

### Kategorie podle vzoru

| pattern | použití | příklad |
|---|---|---|
| `list_<entities>` | čtení kolekce | `list_projects`, `list_sessions` |
| `<entity>_<noun>` | statistika single entity | `session_stats`, `peer_context_status` |
| `peer_set_<noun>` | self-write (peer si nastavuje vlastní config) | `peer_set_context_guard`, `peer_set_notification` |
| `peer_<noun>_read` | self-read | `peer_inbox_read` |
| `peer_<noun>_<read\|search>` | cross-peer read | `peer_chat_read`, `peer_chat_search` |
| `peer_<verb>` | komunikační akce | `peer_ask`, `peer_reply` |

### Pravidla

- **Konsistence sloves a podstatných jmen:** Tool name končí **noun**, ne verbem. `peer_set_notification` ✓, ~~`peer_set_notify`~~ ✗.
- **`peer_set_*` = self-only:** Tools s prefixem `peer_set_` operují vždy na vlastní session peera (= nemůžeš nastavit konfiguraci cizího peera). Tool s parametrem `to` může cross-peer (`peer_context_status`).
- **`peer_*_read` / `peer_*_search` může být cross-peer:** Tyto akce mají `to` parametr a čtou jiný peer's data.
- **Komunikační verby:** `peer_ask` (nová zpráva), `peer_reply` (odpověď). Pro budoucí `peer_broadcast` platí stejný pattern (`peer_<verb>`).

### Známé výjimky (legacy)

| tool | proč nesedí | rozhodnutí |
|---|---|---|
| `peer_list` | Měl by být `list_peers` pro souznění s `list_projects`/`list_sessions`. | **Keep** — published API od v0.2.0, rename = breaking change. Zvážit alias + deprecation v MAJOR (v1.0+). |

## Skills

Skills používají **kebab-case** s prefixem `claude-bridge-`.

### Kategorie

| pattern | použití | příklad |
|---|---|---|
| `claude-bridge` | top-level intro / index skill | `claude-bridge` |
| `claude-bridge-role-<role-name>` | role-based playbook (= identita peera v týmu) | `claude-bridge-role-manager`, `claude-bridge-role-memory-keeper` |
| `claude-bridge-<task>` | operational pattern / specific task | `claude-bridge-cleanup` |

### Decision rule

- **Role-based** = skill popisuje **kdo peer je** v týmu (manager, memory-keeper, integration-dev, test-engineer, ...). Použij `claude-bridge-role-*` prefix.
- **Operational** = skill popisuje **co peer dělá** v konkrétní úloze (cleanup before compact, ...). Použij `claude-bridge-*` bez `-role-`.

### Pravidla

- **No "-agent" suffix:** Všechny skilly jsou pro agenty, "-agent" je redundantní. `claude-bridge-role-manager` ✓, ~~`claude-bridge-role-managing-agent`~~ ✗.
- **No skill bez prefix `claude-bridge-`:** Plugin's skills musí mít prefix, ať se v multi-plugin marketplace nepleta.
- **Role-name = role v týmu**, ne specializace. "manager" = generic orchestrator role; "memory-keeper" = specialista na shared memory. Ne příliš úzké názvy (nepoužívej "ticket-tracker" — to už je business-doménový, ne universal role).

## Proces přidání nového tool / skill

1. **Pojmenuj podle konvence výše.** Pokud nový pattern (= žádná z kategorií nesedí), nejdřív rozšiř tuto konvenci.
2. **Audit existující jména** — `grep -r "<navrhované jméno>"` v `servers/` a `local/`, vyhni se kolizi.
3. **Pro tools:** přidej do `servers/claude-bridge/src/mcp/tools.ts` + zod schéma + handler.
4. **Pro skills:** přidej do `skills/<skill-name>/SKILL.md` + případně `PLAYBOOK.md` (= on-demand detail).
5. **Update této konvence** — pokud zavádíš nový pattern (= nová kategorie), zdokumentuj.

## Historie

- **2026-06-29** — Counterpart audit (`peer_set_notify` → `peer_set_notification` rename před release; `claude-bridge-memory-delegate` dropped jako redundantní). Konvence dokumentována v tomto souboru.
- **2026-06-29** — Skill convention `claude-bridge-role-*` zavedena.

# claude-bridge — architecture

Architektonické záznamy (ADR) pro claude-bridge plugin. Kanonický repozitář rozhodnutí, která překračují rozsah jednotlivého release a která je třeba vysvětlit v kontextu nadřazených cílů.

Formát: **Context / Decision / Consequences / Alternatives considered / Status**. Historické záznamy se nemažou, aktualizují se pouze polem `Status`.

## Rozcestník

| ADR | Název | Stav |
|---|---|---|
| [ADR-007](#adr-007--agent-teams-pivot-placeholder) | Agent Teams pivot | Placeholder — draft až po experimentu |
| [ADR-008](#adr-008--control-plane-daemon-vedle-file-based-filozofie) | Control-plane daemon vedle file-based filozofie | Accepted (2026-07-23) |

Vazba na ostatní dokumenty:
- [`HOOKS-STATUSLINE-ARCHITECTURE.md`](HOOKS-STATUSLINE-ARCHITECTURE.md) — technický popis v0.9.0+ live-data pipeline; upraven v ADR-008.
- [`NAMING-CONVENTION.md`](NAMING-CONVENTION.md) — konvence pojmenování MCP nástrojů a skillů.
- [`SETUP-LIVE-DATA.md`](SETUP-LIVE-DATA.md) — uživatelský návod na zapojení live-data zdrojů.

---

## ADR-007 — Agent Teams pivot (placeholder)

**Stav:** placeholder / draft. Slot rezervovaný pro budoucí ADR o migraci intra-project peer-messaging na experimentální flag `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

Kontext žije v memory pod slugem `strategic-pivot-agent-teams` (viz `~/.claude/projects/-opt-claude-bridge/memory/strategic-pivot-agent-teams.md`). Před ratifikací ADR-007 je třeba dokončit uživatelský experiment a rozhodnout, zda pivotovat úplně, nebo držet oba mechanismy vedle sebe.

*Do vyplnění ADR-007 čtěte přímo memory zápis.*

---

## ADR-008 — Control-plane daemon vedle file-based filozofie

**Stav:** Accepted 2026-07-23. Ratifikováno spolu se zadáním `/opt/hmh/docs/agent-platform/control-plane-zadani-2026-07-23.md` (verze 3).

**Verze pluginu, kdy vstupuje v platnost:** v0.10.0-alpha (daemon core), plná funkcionalita v0.10.0 stable po dokončení fází beta a rc.

### Kontext

Plugin claude-bridge byl od v0.1.0 postaven na striktně **file-based** komunikačním modelu:

- žádný trvale běžící proces vedle Claude Code sessions,
- veškerá koordinace přes atomicky zapsané soubory pod `~/.claude-bridge/`,
- MCP servery žijí per-session (start / stop s CC procesem).

Toto rozhodnutí je zdokumentováno v [`HOOKS-STATUSLINE-ARCHITECTURE.md`](HOOKS-STATUSLINE-ARCHITECTURE.md) sekce **„Why not IPC / daemon / socket?"**. Motivace: cross-chat viditelnost, jednoduchá instalace, snadný `uninstall`.

Během provozu autonomního HMH týmu 22.–23. 7. 2026 se ukázalo, že **řízení životního cyklu Claude Code procesů** (spawn nových peerů, řízené zastavení, compact watchdog, dohled nad crashe) je kvalitativně jiný problém než ten, který file-based model řeší:

- procesy z podstaty potřebují správce, který žije déle než ony samy,
- CC hooks jsou event-driven a nedokážou spustit dlouhoběžící proces (potvrzeno recon poznámkami z v0.9.3),
- bez externího správce zůstává lifecycle na člověku (evidence: noční zánik 6 peerů, kontaminovaný spawn s API kredit billing, tichý zánik cronu, umřelá telemetrie, ruční orchestrace).

### Rozhodnutí

1. **Zavést separátní opt-in komponentu „control plane daemon"** distribuovanou jako pátý bundled artefakt claude-bridge pluginu (`servers/claude-bridge-daemon/dist/daemon.cjs`).
2. **Anti-daemon filozofie z `HOOKS-STATUSLINE-ARCHITECTURE.md` platí dál pro datovou/messaging vrstvu** — telemetrie, inbox, registry, guard soubory MUSÍ fungovat bez perzistentního procesu. Bridge v0.9.4 (JSONL fallback) tento invariant potvrzuje.
3. **Daemon komunikuje s MCP servery výhradně file-based RPC** (`~/.claude-bridge/control/requests/`, `results/`, `events.jsonl`). Žádné sockety, žádné pipes, žádná sdílená paměť — file-based princip se drží i uvnitř nové komponenty.
4. **Daemon není agent** — je infrastrukturní služba (systemd user unit / launchd / Task Scheduler), bez LLM, bez kontextu, deterministický. Charterová zásada „idle agent = 0 RAM" se ho netýká; sám je malý (~24 kB bundle), trvalý, poslušný.
5. **Bez daemonu plugin funguje beze změny.** Kdo `install-daemon --systemd` nespustí, má bridge jako v každé předchozí verzi — nulová regrese.

### Konsekvence

Pozitivní:
- Lifecycle akce (spawn, stop, restart, compact) mají jednoho autoritativního vlastníka místo skriptů, cronu a ručních zásahů.
- Auditovatelnost přes `events.jsonl` (append-only, `schemaVersion:1`, pinned pole `ts / level / pid / event / by / requestId / details`).
- Deterministické gating destruktivních operací přes GO-registr (`~/.claude-bridge/go/`, viz §11 zadání).
- Cross-platform strategie s abstrakcí `SessionHostDriver` — tmux driver v MVP (Linux/macOS/WSL2), Windows nativní driver on demand ve F3+.

Negativní / náklady:
- Nová komponenta k údržbě, nový bundle build (`build:daemon`).
- Uživatel musí explicitně `install-daemon --systemd` — extra krok navíc oproti dosavadnímu plug-and-play.
- **Uninstall příběh je vázán na daemon:** `daemon uninstall` musí zastavit službu a odstranit unit/plist/task; setup-check musí detekovat „služba běží, plugin pryč" a instruovat uživatele. Bez vyřešeného uninstallu se daemon neshipuje (podmínka ADR).

Migrace stávajících instalací:
- Existující claude-bridge do 0.9.4 zůstává funkční beze změny.
- Kdo chce nové lifecycle nástroje → doinstaluje daemon příkazem `node ~/.claude/claude-bridge-daemon.cjs install --systemd` (Linux MVP; macOS/Windows F3).
- Rollback = `uninstall --systemd` + downgrade pluginu.

### Zvažované alternativy

| Alternativa | Proč zavržena |
|---|---|
| Ponechat lifecycle na uživateli (status quo) | Evidence 22.–23. 7. — nočník zánik týmu, kontaminovaný spawn, umřelá telemetrie. Neudržitelné. |
| Spouštět dlouhoběžící proces z CC hooků | CC hooks jsou event-driven; hook s dlouhou výdrží blokuje CC. Nefunguje. |
| Použít socket-based IPC místo file-based RPC | Rozbíjí filozofii pluginu, komplikuje uninstall, ztěžuje cross-session debugging. File-based RPC funguje s běžnými nástroji (`cat`, `jq`, `tail -f events.jsonl`). |
| Integrovat daemon do MCP serveru | MCP server žije per-session, umřel by s CC. Životní cyklus musí přežít jednotlivé sessions. |
| Nasadit generic supervisor (systemd + shell script) | Neřeší GO-verifikaci, per-peer state, telemetrii ani auditní stopu. Znovu by se muselo napsat totéž, jen bez pluginového distribučního modelu. |

### Vztah k `HOOKS-STATUSLINE-ARCHITECTURE.md`

Sekce **„Why not IPC / daemon / socket?"** v `HOOKS-STATUSLINE-ARCHITECTURE.md` (řádky ~195–206) je rozšířena o disclaimer: anti-daemon rozhodnutí platí VÝHRADNĚ pro datovou/messaging vrstvu pluginu. Životní cyklus procesů řeší tento ADR-008.

Krátký odkaz z pasáže na tento dokument je součástí v0.10.0-alpha commitu — jinak by v repu zůstaly dva dokumenty v přímém rozporu (G3 zadání).

### Odkazy

- Zadání: `/opt/hmh/docs/agent-platform/control-plane-zadani-2026-07-23.md` (verze 3, ratified 2026-07-23)
- Memory anchor: `~/.claude/projects/-opt-claude-bridge/memory/v0.10.0-control-plane-anchor.md`
- Implementace daemonu: `servers/claude-bridge-daemon/`
- Shared knihovna: `packages/shared/` (paths, atomic-write, structured logger, control-paths helpery)
- CHANGELOG: `CHANGELOG.md` sekce v0.10.0-alpha

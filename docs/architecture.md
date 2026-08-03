# claude-bridge — architecture

Architektonické záznamy (ADR) pro claude-bridge plugin. Kanonický repozitář rozhodnutí, která překračují rozsah jednotlivého release a která je třeba vysvětlit v kontextu nadřazených cílů.

Formát: **Context / Decision / Consequences / Alternatives considered / Status**. Historické záznamy se nemažou, aktualizují se pouze polem `Status`.

## Rozcestník

| ADR | Název | Stav |
|---|---|---|
| [ADR-007](#adr-007--agent-teams-pivot-placeholder) | Agent Teams pivot | Placeholder — draft až po experimentu |
| [ADR-008](#adr-008--control-plane-daemon-vedle-file-based-filozofie) | Control-plane daemon vedle file-based filozofie | Accepted (2026-07-23) |
| [ADR-009](#adr-009--dva-vydávací-kanály-a-jeden-zdroj-pravdy-pro-verzi) | Dva vydávací kanály a jeden zdroj pravdy pro verzi | Accepted (2026-08-03) |

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

**Verze pluginu, kdy vstupuje v platnost:** v0.10.0-alpha (daemon core, kill-test acceptance), v0.10.0-beta (peer lifecycle + fork-guard + SessionHostDriver), v0.10.0-rc (peer_compact + team_layout + offline-subscriber delivery). Stable release do marketplace = samostatné rozhodnutí ownera po převzetí rc.

**Uživatelská setup dokumentace:** [`docs/SETUP-DAEMON.md`](SETUP-DAEMON.md) (od v0.10.0-rc).

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

---

## ADR-009 — Dva vydávací kanály a jeden zdroj pravdy pro verzi

**Status:** Accepted (2026-08-03), na pokyn ownera.

### Context

Repozitář používá víc lidí. Dosud existoval jediný kanál, takže předběžná vydání šla stejnou cestou jako ostrá — `v0.10.0-rc.1` i `rc.2` dostali všichni uživatelé tržiště. Zároveň `main` sloužil jako integrační i vydávací větev, takže na něm ležela nevydaná práce.

Verze žila na **šesti ručně editovaných místech** a už se rozešla třemi směry:

| místo | hodnota před opravou |
|---|---|
| `plugin.json`, `marketplace.json`, daemon | 0.10.0-rc.2 |
| `servers/claude-bridge/package.json` | 0.9.4 |
| `packages/shared/package.json` | 0.10.0-alpha.0 |
| `src/mcp/server.ts` — literál `SERVER_VERSION` | **0.9.4** |

Ten poslední byl vidět uživatelům: každý peer hlásil v `peer_list` verzi 0.9.4 a MCP server se tak představoval Claude Code — pět vydání po sobě.

### Decision

**1. Dva kanály, oba viditelně nabídnuté.** `marketplace.json` na `main` obsahuje dva záznamy nad týmž repozitářem:

| záznam | jméno | ukazuje na |
|---|---|---|
| stabilní (výchozí) | `claude-bridge` | poslední ostrou značku |
| vývojový | `claude-bridge-dev` | poslední předběžnou značku |

Volba je nabídnutá každému, kdo si tržiště otevře, ne skrytá za znalostí syntaxe.

**2. Větve.** `main` nese jen vydané. `develop` je integrace. Pracovní větve se slévají do `develop`.

**3. Připínání na `ref` **i** `sha`.** Značka se dá přepsat, commit ne. Odpovídá praxi Anthropicova katalogu (223 z 276 pluginů).

**4. Jméno pluginu se musí shodovat s `plugin.json`.** Ověřeno na 39 z 39 lokálních záznamů Anthropicova katalogu, bez výjimky. Proto `plugin.json` na `develop` nese `claude-bridge-dev` — jediná trvalá odchylka mezi větvemi, kterou vlastní vydávací skript.

**5. Jeden zdroj pravdy pro verzi.** `plugin.json` `version` je zdroj; `scripts/release.mjs` z něj zapisuje tři `package.json`; `src/mcp/server.ts` čte svůj `package.json` při sestavení (esbuild ho vloží dovnitř). Kód se tedy rozejít nemůže. `.githooks/pre-push` shodu ověřuje.

### Consequences

- Vývojový kanál je **jiná identita pluginu** → jiné předpony nástrojů a skillů, jiný identifikátor v allowlistech a v příznaku `--channels`. Pro člověka neviditelné, protože nástroje volá model.
- **Nesmí se instalovat oba naráz** — běžely by dva MCP servery nad týmž `~/.claude-bridge/`. Uvedeno v popisu obou záznamů i v `INSTALL.md`.
- Naše vlastní rodina peerů drží **jednu verzi napříč všemi** (rozhodnutí ownera 2026-08-03). Míchání kanálů uvnitř fleetu se zamítlo jako zbytečně složité.
- Vydání teď má rituál: `release.mjs set` na větvi → značka → `release.mjs catalog` na `main`. Ruční editace manifestů končí.
- Uživatel si verzi vybrat nemůže a aktualizaci odmítnout taky ne — kanál je jediná páka, kterou má.

### Alternatives considered

- **Dvě tržiště z jednoho repa** (`marketplace add owner/repo@develop`). Funguje a nechalo by `plugin.json` na obou větvích identický. Zamítnuto: vývojový kanál by viděl jen ten, kdo zná syntaxi — owner výslovně chtěl volbu nabídnutou všem.
- **Oddělený repozitář pro vydání.** Příliš těžké na jeden plugin, rozdělilo by hlášení chyb a hvězdy.
- **`strict: false` u vývojového záznamu**, aby `plugin.json` nemusel měnit jméno. Katalog by pak musel nést celou definici včetně `mcpServers` a rozcházel by se s kódem. Ponecháno jako záložní cesta.
- **Míchání kanálů po peerech** přes `claude --settings`. Ověřeno jako funkční (granularita až na jednotlivého peera), owner ale rozsah stáhl zpět.

### Odkazy

- `scripts/release.mjs` — nástroj na manifesty
- `docs/INSTALL.md` — sekce „Two release channels"
- `.githooks/pre-push` — kontrola shody verzí

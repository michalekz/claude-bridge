# Podrobný návod k použití

Tento dokument je referencí ke všem nástrojům pluginu — co umí, jaké berou argumenty, jak vypadá výstup a v jakých situacích každý použiješ. Doporučená cesta čtení: nejdřív sekce "Identita peer chatu", pak listuj k nástroji, který tě zajímá. Konec dokumentu obsahuje pár hotových receptů pro typické workflows.

## Identita peer chatu

Než se podíváš na konkrétní nástroje, je dobré rozumět tomu, jak plugin pozná jednotlivé chaty navzájem. Každý chat má dvě úrovně identity:

**`id`** je Claude Code sessionId — UUID typu `09de67fe-2b3b-45d1-a576-aec89ffaf8c7`. Je vždy jedinečné, nikdy nekoliduje. Plugin ho používá jako stabilní klíč pro inbox adresář a heartbeat soubor. Pokud chceš mít jistotu, vždycky posílej **by id**.

**`name`** je lidsky čitelný slug — typicky odvozený z ai-title (`explore-mcp-server-claude-bridge`) nebo z názvu projektu (`opt-claude-bridge`). Slug **může kolidovat**, pokud máš dva chaty se stejným ai-titlem. Pokud k tomu dojde, plugin vrátí `ambiguous_peer` chybu s výčtem konkurujících `id`.

**`displayName`** je původní raw titulek z UI, bez slugifikace (typicky "Explore MCP server claude-bridge"). Plugin ho nepoužívá k routování — slouží jen pro lidsky čitelný výstup.

Cascade, ze kterého plugin display name odvozuje, v pořadí priority:

1. **`custom-title`** / **`ai-title`** event z aktuálního JSONL (Claude Code automaticky doplní po prvním user msg).
2. **`session.json .name`** (pokud uživatel přejmenoval chat přes `/name`).
3. **Env proměnná** `CLAUDE_BRIDGE_PEER_NAME` (override pro orchestrátora).
4. **Slug z `basename(cwd)`** (fallback — kolize OK, `id` zůstává unikátní).

Refresh proběhne každých 5 s — když chat krátce po startu nemá ai-title, dorazí později.

## Doporučená topologie: Extension jako orchestrátor, terminály jako workers

Plugin funguje stejně ve VS Code Extension i v terminálovém Claude Code, ale doručovací charakteristiky se liší. Přirozený pattern pro multi-chat práci využívá obě strany — každá hraje na svoji silnou stránku.

| Role | Kde | Doručování | Proč právě tato strana |
|---|---|---|---|
| **Orchestrátor** | VS Code Extension chat tab | Piggyback (channels v Extension aktuálně nejsou podporovány) | Orchestrátor *řídí* — sám volá `peer_ask`, `peer_list`, `peer_chat_read`. Každý tool call piggyback-drainuje inbox, takže odpovědi přicházejí přirozeně bez push. Extension navíc poskytuje editor surface pro práci, kterou řídíš. |
| **Worker** | Terminálově spuštěný Claude s `--channels` | Real-time push | Workers *čekají* na úkoly. Bez push by viděli přicházející zprávy až při svém příštím self-initiated tool callu — což se nemusí nikdy stát, pokud worker leží idle. Push je probudí okamžitě, jakmile `ask` dorazí. |

Asymetrie je *záměrná*, není to defekt: strana, která řídí konverzaci, nepotřebuje budíček; strana, která čeká, ho potřebuje.

### Postup nasazení

1. **Strana orchestrátora** — otevři Claude Code ve VS Code Extension běžně. Žádné speciální flagy. Plugin funguje hned po instalaci.
2. **Strana worker** — otevři jeden nebo víc terminálů (separátní VS Code terminal taby, tmux panely, nebo platform-native terminal app) a spusť Claude s channelem: buď přes profil "Claude (channels)" (viz [INSTALL — VS Code terminal profile](INSTALL.md#vs-code-terminal-profile-všechny-os)), nebo napiš `claude --channels plugin:claude-bridge@oxyshop-plugins` přímo.
3. **Ověř push** — z orchestrátora pošli `peer_ask` na worker. Worker zareaguje okamžitě (vidí `<channel source="claude-bridge" …>` tag inline v kontextu, ne odložené na další tool call).

Pokud obě strany skončí ve stejném režimu (obě Extension nebo obě terminál-with-channels), nic se nerozbije — jen topologie neodpovídá latenčním charakteristikám tvého workflow.

## Tools — kompletní reference

Nástroje jsou v Claude Code dostupné jako `mcp__plugin_claude-bridge_claude-bridge__<tool>`. Pluginné hooky pluginu je předem schvalují, takže od uživatele nevyžadují potvrzování.

---

### `peer_list`

Vypíše všechny aktivní Claude Code chaty na stejném stroji. Žádné argumenty.

**Kdy použít:** první nástroj, který v každém workflow voláš. Bez něj nevíš, koho máš k dispozici.

**Výstup obsahuje:**

- `self` — tvůj vlastní chat (id, name, displayName)
- `peers[]` — pole aktivních ostatních chatů s metadaty (id, name, displayName, pid, cwd, ageMs, source, version)

**Typický příklad:**

```jsonc
// volání bez argumentů
peer_list

// výsledek (zkráceně)
{
  "self": { "id": "fb74…", "name": "restore-missing-chat", "displayName": "Restore missing chat" },
  "peers": [
    { "id": "09de…", "name": "explore-mcp-server", "ageMs": 3500, "version": "0.3.0" }
  ]
}
```

Pokud má peer `ageMs` přes 30 000 (30 s), je pravděpodobně offline — heartbeat by měl chodit každých 5 s.

---

### `peer_ask`

Pošle zprávu do inboxu jiného chatu. Doručení je vždy spolehlivé — i když cílový chat zrovna spí, zpráva čeká v `pending/` a doručí se při jeho další aktivitě.

**Argumenty:**

- `to` (povinný) — `id` (UUID) nebo `name` cílového chatu. Pokud `name` koliduje, vrátí `ambiguous_peer` chybu.
- `content` (povinný) — text zprávy. Max 64 000 znaků.
- `threadId` (volitelný) — korelační ID pro vícekolový dialog.

**Příklad:**

```jsonc
peer_ask {
  "to": "explore-mcp-server",
  "content": "Najdi v naší historii zmínky o agent teams a stručně shrň."
}
```

Vrátí `msgId`, který si potom druhý chat může uložit a použít v `peer_reply`. Pokud `to` neoznačuje žádného aktivního peera, vrátí `peer_not_found`.

---

### `peer_reply`

Odpoví na předtím přijatou zprávu. Plugin si dohledá originální zprávu v `done/` archivu a zpráva se pošle původnímu odesílateli — nemusíš pamatovat, kdo to byl.

**Argumenty:**

- `inReplyTo` (povinný) — `msgId` zprávy, na kterou odpovídáš (z piggyback bloku nebo `peer_inbox_read`).
- `content` (povinný) — text odpovědi.

**Příklad:**

```jsonc
peer_reply {
  "inReplyTo": "mplr29k9-7e708b26",
  "content": "Zmínek je dvanáct, hlavní téma: experimental flag a hierarchie lead/teammate."
}
```

Pokud `inReplyTo` neoznačuje žádnou zprávu v tvém `done/` archivu (typicky proto, že jsi ji ještě nepřijal/nedrainoval), vrátí `original_not_found`.

---

### `peer_inbox_read`

Vyžene všechny `pending/` zprávy do tvého `done/` archivu a vrátí je. Obvykle to **nemusíš volat** — plugin po každém úspěšném MCP tool callu sám drainuje pending zprávy a přidá je do výstupu (piggyback consumption).

**Argumenty:** žádné.

**Kdy ho přesto použít:** když chceš drainovat výslovně. Třeba na začátku konverzace, abys viděl, co dorazilo v mezičase.

---

### `peer_chat_read`

Klíčový nástroj pluginu. Přečte transcript jiného chatu — buď posledních N zpráv, nebo zprávy od konkrétního časového bodu, nebo zprávy odpovídající dotazu.

Plugin při čtení automaticky:

- **Odstraní IDE-noise tagy** (`<ide_opened_file>`, `<system-reminder>`, …) — agent vidí čistý obsah.
- **Najde ai-title** sousední session a použije ho jako jméno peera v hlavičce (i pro neaktivní chaty).
- **Stripuje** `tool_use` inputy a `tool_result` content nad 500 znaků (jen když je `includeToolCalls: true`).

#### Argumenty

| Arg | Default | Co dělá |
|---|---|---|
| `to` (povinný) | – | `id` (UUID) nebo `name` cílového chatu |
| `lastN` | 10 | Vrátí posledních N zpráv |
| `sinceTimestamp` | – | ISO 8601 — jen zprávy od tohoto času dál |
| `sinceLastUserPrompt` | `false` | Sémantická kotva — vrátí vše od posledního user promptu dál |
| `maxBytes` | 30 000 | Hard cap na velikost výstupu, oldest dropped first |
| `includeToolCalls` | `false` | Přidat `tool_use` (na assistant) a `tool_result` (na user) bloky |
| `includeThinking` | `false` | Přidat assistant `thinking` bloky (často velké) |
| `rolesOnly` | obě | Filtr na role, např. `["user"]` pro prompt-only view |
| `crossProject` | `false` | Povolit čtení libovolné session UUID, i neaktivní nebo z jiného projektu |
| `format` | `"markdown"` | Výstupní formát: `markdown` (čitelný), `json` (strukturovaný), `compact` (jednořádkový skim) |
| `query` | – | Filter na text zprávy (case-insensitive substring) |
| `queryRegex` | `false` | Zacházet s `query` jako s regex patternem |
| `contextLines` | 0 | Při query přidat ±N sousedních zpráv kolem každého matche |

#### Příklad 1: Posledních pár zpráv

```jsonc
peer_chat_read { "to": "explore-mcp-server", "lastN": 5 }
```

Vrátí 5 nejnovějších zpráv (user + assistant) v markdown formátu.

#### Příklad 2: Co druhý chat řeší zrovna teď

```jsonc
peer_chat_read { "to": "explore-mcp-server", "sinceLastUserPrompt": true }
```

Vrátí poslední user prompt sousedního chatu a všechno, co od něj agent stihl. Lepší než guessing s `lastN`.

#### Příklad 3: Vyhledávání

```jsonc
// substring (case-insensitive)
peer_chat_read {
  "to": "explore-mcp-server",
  "query": "agent teams"
}

// substring s kontextem
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

Špatně formulovaný regex vrátí `invalid_query_regex` s konkrétním důvodem.

#### Příklad 4: Cross-project / dead session

```jsonc
peer_chat_read {
  "to": "09de67fe-2b3b-45d1-a576-aec89ffaf8c7",
  "crossProject": true,
  "lastN": 20
}
```

Funguje na jakoukoli session JSONL ze všech tvých projektů — nezávisle na tom, jestli ten chat zrovna běží. Hodí se, když chceš mrknout do historie, ke které už v UI nemáš přístup.

#### Příklad 5: Jen user prompts

```jsonc
peer_chat_read {
  "to": "explore-mcp-server",
  "lastN": 30,
  "rolesOnly": ["user"]
}
```

Vrátí jen user prompts (ne assistant odpovědi). Užitečné pro overview "o čem se ten chat všechno bavil".

#### Výstupní formáty

**`markdown`** (default) — čitelný transcript s hlavičkou. Vhodný, když chceš výstup ukázat lidskému uživateli nebo přečíst sám.

**`json`** — strukturovaná data. Vhodný, když budeš výstup dál programově zpracovávat.

**`compact`** — jeden krátký řádek na zprávu, text se ořízne na ~180 znaků. Ideální pro skim většího počtu zpráv (50–500).

---

### `peer_chat_search`

Cross-session hledání napříč aktuálním projektem (default) nebo všemi projekty (s opt-in). Zatímco `peer_chat_read.query` hledá uvnitř konkrétní session, `peer_chat_search` se ptá "kde v jakémkoli z mých chatů se mluvilo o X" — bez nutnosti znát konkrétní peer nebo session ID.

Plugin při hledání automaticky:

- **Vyloučí vlastní session** (je už v agent kontextu, není co najít).
- **Přeskočí sessions starší 30 dní** (hardcoded — pro starší historii zatím není scope).
- **Vyhledává jen v text obsahu** zpráv — ne v `thinking`, ne v `tool_use` inputech, ne v `tool_result` content. To dramaticky redukuje false positives a šum.

#### Argumenty

| Arg | Default | Co dělá |
|---|---|---|
| `query` (povinný) | – | Text k vyhledání (substring) nebo regex pattern |
| `queryRegex` | `false` | Zacházet s `query` jako s regex patternem (case-insensitive) |
| `scope` | `"project"` | `"project"` = aktuální projekt; `"all-projects"` = všechny projekty (gated env) |
| `contextLines` | 1 | Přidat ±N sousedních zpráv kolem každého matche |
| `maxMatches` | 30 | Stop scanning po N nalezených matches |
| `maxBytes` | 30 000 | Hard cap na velikost outputu (oldest dropped first) |

#### Příklad 1: Najdi téma v aktuálním projektu

```jsonc
peer_chat_search { "query": "agent teams" }
```

Vrátí markdown s hlavičkou (počet scanned sessions, hits, total matches) a sekcemi per session s matches + kontextem.

#### Příklad 2: Regex přes všechny projekty

```jsonc
peer_chat_search {
  "query": "version \\d+\\.\\d+\\.\\d+",
  "queryRegex": true,
  "scope": "all-projects",
  "maxMatches": 50,
  "contextLines": 2
}
```

#### Příklad 3: Co reportuje "scope_too_large"

```jsonc
{
  "ok": false,
  "code": "scope_too_large",
  "message": "Filtered scope is 540 MB across 89 sessions — over the 200 MB cap. Reduce by using scope='project' or wait for FTS5 backend (v0.5+)."
}
```

Co s tím:

- Zužuj na `scope: 'project'` (default).
- Nebo počkej na FTS5 backend ve verzi v0.5+ (lazy-built index, queries v desítkách ms i pro 1 GB+ datasets).

#### Výstupní formát

Markdown s hlavičkou + sekcí per session:

```markdown
# Search: `agent teams` (substring, scope=project)
**Scope:** 12 sessions × 47 MB scanned in 1840 ms
**Hits:** 5/12 sessions, 18 matches

---

## Explore MCP server `09de67fe` — 8 matches
**Project:** `-opt-claude-bridge` | mod 2026-05-25T22:43:38.031Z

### [10:00:15] user `a4f067` _(context)_
předchozí prompt...

### [10:00:42] assistant `b9133f` **← match**
Odpověď zmiňující agent teams...

### [10:01:08] user `c2e5d4` _(context)_
následující zpráva...
```

Pokud output překročí `maxBytes`, poslední session se ořízne a přidá se note.

---

### `list_projects`

Vypíše všechny Claude Code projekty z `~/.claude/projects/`. Žádné argumenty.

**Kdy použít:** když chceš zorientovat v lokální historii — jaké projekty vůbec máš, kde leží jejich session JSONL soubory.

---

### `list_sessions`

Vypíše session JSONL soubory napříč všemi projekty, seřazené od nejnovějšího.

**Argumenty:**

- `project` (volitelný) — omez na konkrétní projekt dir (např. `-opt-claude-bridge`).
- `limit` (volitelný, default 50) — max počet vrácených sessions.

**Kdy použít:** typicky před `peer_chat_read` s `crossProject: true` — potřebuješ vědět, jakou UUID session chceš číst.

---

### `session_stats`

Pro konkrétní session vrátí počty eventů podle typu (user, assistant, tool_use, atd.).

**Argumenty:**

- `sessionId` (povinný) — UUID session.
- `project` (volitelný) — omezit na konkrétní projekt.

**Kdy použít:** rychlý drill-down "co je v té session". Užitečné, když máš seznam sessions z `list_sessions` a chceš si vybrat tu, která vypadá nejaktivněji.

---

## Nástroje pro monitoring context window *(v0.7.0+)*

### `peer_context_status`

Vrátí autocompact-relevantní statistiku pro sebe nebo libovolného peera. Zdroj dat: `usage.cache_read_input_tokens` na posledním assistant eventu v peer's JSONL — odpovídá přesně `/context` Total.

**Argumenty:**

- `to` (volitelný) — výběr cíle:
  - vynechané = jen self
  - `"all"` = všichni aktivní peeři + self
  - `"alice"` = jeden peer (jméno/UUID/`"self"`)
  - `["alice", "bob", "self"]` = bulk

**Output per peer:** `id`, `name`, `isSelf`, `model`, `contextLimit`, `tokensUsed`, `tokensRemaining`, `percentUsed` (0-1), `autocompactRisk` (`low`<60%, `medium`60-85%, `high`>85%), `lastTurnAt`, `hasSession`. Zahrnuje `guard` field, pokud peer nějakou guard config nastavený má.

**Kdy použít:** před zadáním dlouhé úlohy → vybrat čerstvého workera. Pro overnight monitoring týmu. Pro preempt autocompactu — handoff před překročením prahu.

**Příklad:**

```jsonc
peer_context_status { "to": "all" }
// → { count: 14, peers: [{ id, name, model, contextLimit, tokensUsed, percentUsed: 0.586, autocompactRisk: "low", ... }, ...] }
```

---

### `peer_set_context_guard`

Self-write: konfiguruje vlastní context-usage guard. Self-targeted (žádný `to` argument) — peer si nastavuje vlastní config. Persist do `~/.claude-bridge/guard/<sessionId>.json`.

**Argumenty (všechny volitelné):**

- `enabled` (default `true`) — master toggle.
- `warnAtPercent` (default `0.85`) — první práh.
- `criticalAtPercent` (default `0.95`) — kritický práh (musí být ≥ warnAtPercent).
- `notifyPeerIds` (default `[]`) — peer IDs k notifikaci při překročení.
- `broadcastProject` (default `false`) — pokud true, notify všichni peeři v same cwd.

**Kdy použít:** na začátku session pro subscribe manager peera. Wake-time auto-fire plánováno na v0.7.x; v0.7.0 jen persistuje config (= manager si ho přečte přes `peer_context_status`).

**Příklad:**

```jsonc
peer_set_context_guard {
  "warnAtPercent": 0.80,
  "criticalAtPercent": 0.92,
  "notifyPeerIds": ["56eca981-8434-4e29-9a57-bf7a41a051a9"]
}
```

---

### `peer_set_notification`

Self-write: konfiguruje idle-beep notifikaci. Self-targeted.

**Argumenty (všechny volitelné):**

- `enabled` (default `false`) — toggle.
- `minIdleSeconds` (default `30`, min 5, max 3600) — sekund idle před první beep.

**Kdy použít:** když chceš terminálový bell, když worker peer ztichne (= hotovo nebo se zasekl). Wake-time injection plánováno na v0.7.x.

---

### `model_info` *(v0.7.3+)*

Static lookup canonical Claude model metadata. Žádný JSONL scan, žádný network call — jen in-process tabulka z Anthropic platform docs.

**Argumenty (všechny volitelné):**

- `model` — dotaz na konkrétní id (např. `"claude-opus-4-7"`). Date suffix a `[1m]` tag normalizovány.
- `generation` — filter lifecycle: `"current"` | `"legacy"` | `"deprecated"`. Ignored if `model` is set.

**Output per model:** `id`, `displayName`, `family` (opus/sonnet/haiku/fable/mythos), `generation`, `contextWindow`, `maxOutputTokens`, `pricing.inputPerMTok`/`outputPerMTok`, `capabilities.vision`/`extendedThinking`/`adaptiveThinking`, `knowledgeCutoff`, `trainingDataCutoff`, `notes`.

**Příklad:**

```jsonc
model_info()
// → { source: { ... }, modelsCount: 10, models: [...] }

model_info { "model": "claude-haiku-4-5-20251001" }
// → { source: { ... }, model: { id: "claude-haiku-4-5", contextWindow: 200000, ... } }

model_info { "generation": "current" }
// → 5 aktuálních modelů (Fable 5, Mythos 5, Opus 4.8, Sonnet 4.6, Haiku 4.5)
```

---

## Bundled role skills *(v0.7.0+)*

Dva praktiky-grounded playbooky jsou součástí pluginu. Invoke přes jméno skillu v promptu nebo přes `/<skill>` příkaz.

### `claude-bridge-role-manager`

Playbook pro agenta orchestrujícího 2-N worker peerů. 11 load-bearing principů + tool quick-reference + minimal-viable-loop walkthrough + reference na PLAYBOOK.md pro detail (17 sekcí: dispatch šablony, gate workflow, pre-flight downstream isolation, scale-rigor, adversarial-refute, anti-patterny, memory model, onboarding, incident response, cross-machine handoff, peer death recovery).

**Triggery:** "managing agent role", "orchestruju tým peerů", "dispatch úkolu peerům", "gate workflow", multi-peer orchestrace.

### `claude-bridge-role-memory-keeper`

LIGHT playbook pro dedikovaného memory-keeper peera v týmech 3+. 5 load-bearing principů + 8-krok zápis workflow + reconcile-pass workflow. References `claude-bridge-role-manager` PLAYBOOK #10 (= single-source, žádná duplicita).

**Triggery:** "memory keeper", "memory hygiene", "shared memory", "reconcile memory", "single-writer keeper".

---

## Hotové recepty

Příklady kombinací nástrojů pro typické workflows.

### Recept 1: Manažér se ptá pracovních agentů

Manažující chat A koordinuje práci dvou pracovních chatů B a C.

```jsonc
// A: zjistit, koho máme
peer_list

// A: zadat úkol B
peer_ask { "to": "worker-b", "content": "Najdi v repo všechny TODO komentáře a klasifikuj je." }

// A: zadat úkol C
peer_ask { "to": "worker-c", "content": "Spusť testy a pošli mi failed list." }

// (B a C pracují, sami posílají reply přes peer_reply)
// A: zkontrolovat inbox po pár minutách (nebo se mu zprávy přilepí na jiný tool call)
peer_inbox_read
```

### Recept 2: Audit, co se v sousedním chatu řešilo

Chceš pochopit, čeho dosáhl tvůj druhý chat za poslední hodinu.

```jsonc
peer_chat_read {
  "to": "other-chat",
  "sinceTimestamp": "2026-05-25T20:00:00Z",
  "rolesOnly": ["user"],
  "format": "compact"
}
```

User prompts za poslední hodinu jako jednořádkový skim. Když uvidíš zajímavý prompt, můžeš se na konkrétní pasáž zaměřit:

```jsonc
peer_chat_read {
  "to": "other-chat",
  "query": "konkrétní téma z předchozího kroku",
  "contextLines": 2
}
```

### Recept 3: Najdi rozhodnutí, které někde padlo

Tušíš, že jste s druhým agentem před pár hodinami probrali nějaké rozhodnutí — jen nevíš v jakém chatu nebo session.

```jsonc
// Nejjednodušší cesta: peer_chat_search napříč aktuálním projektem
peer_chat_search {
  "query": "klíčové slovo",
  "contextLines": 2
}
```

Pokud nestačí current project, použij all-projects scope:

```jsonc
peer_chat_search {
  "query": "klíčové slovo",
  "scope": "all-projects",
  "contextLines": 2
}
```

Pokud chceš jít po jednotlivých sessions (např. v lookup před FTS5 érou):

```jsonc
// Vypiš všechny session v tomhle projektu
list_sessions { "project": "-opt-claude-bridge" }

// Pro každou kandidátku zkus vyhledat klíčové slovo
peer_chat_read {
  "to": "<sessionId-z-listu>",
  "crossProject": true,
  "query": "klíčové slovo",
  "contextLines": 3,
  "format": "markdown"
}
```

V budoucnu tohle nahradí dedikovaný `peer_chat_search` s cross-session scope a FTS — zatím to ale takhle manuálně funguje.

### Recept 4: Pošli zprávu, čekej odpověď

Synchronní workflow — pošleš dotaz, počkáš na reply.

```jsonc
// Pošli
peer_ask { "to": "expert-chat", "content": "Jak vyřešit X?", "threadId": "q-1" }
// → vrátí msgId

// Druhý chat odpoví přes peer_reply s inReplyTo=<msgId>

// Ty pak buď vidíš odpověď okamžitě (s channelem)
// nebo při příštím tool callu (piggyback)
peer_inbox_read
// → najdeš odpověď s inReplyTo == <tvůj-puvodní-msgId>
```

`threadId` umožní víc kol dialogu v jedné konverzaci — všechny zprávy stejného threadId tvoří logický celek.

## Když něco nefunguje

Většinu problémů řeší [INSTALL — troubleshooting sekce](INSTALL.md#časté-problémy-a-řešení). Specificky pro nástroje:

- **`peer_ask` vrací `peer_not_found`:** druhý chat není v `peer_list`. Pokud používáš VS Code Extension, aktivuj druhý tab kliknutím a počkej 5–10 s. V terminálu (CLI) je peer viditelný hned po startu.
- **`peer_reply` vrací `original_not_found`:** zpráva nebyla v `done/` ani `pending/`. Od v0.3.1 plugin hledá v obou — pokud chyba přesto padne, msgId je opravdu neznámý (zkontroluj překlep). Před v0.3.1 musel uživatel volat `peer_inbox_read` manuálně.
- **`peer_chat_read` vrací `session_file_not_found`:** peer je sice v heartbeat seznamu, ale JSONL ještě nevznikla (typicky úplně nový chat bez prvního promptu). Počkat až user pošle první zprávu.
- **`peer_chat_read.query` / `peer_chat_search` regex hází `invalid_query_regex`:** regex se nezkompiloval. Error message obsahuje konkrétní důvod (nezavřená skupina, neznámý flag, …).
- **`peer_chat_search` vrací `scope_too_large`:** filtrovaný scope (po 30-day cutoff) přesáhl 200 MB cap. Zužuj na `scope: 'project'` nebo počkej na FTS5 backend (v0.5+).

## Kam dál

- **[Hlavní README](../../README.cs.md)** — krátké shrnutí plugin.
- **[Instalace a konfigurace](INSTALL.md)** — jak plugin přidat do Claude Code a nastavit real-time push.

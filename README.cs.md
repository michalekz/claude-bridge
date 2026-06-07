# claude-bridge

🇨🇿 Česky · 🇬🇧 [English](README.md)

Plugin pro Claude Code, který umožňuje dvěma a více běžícím chatům spolu komunikovat a nahlížet si navzájem do historie. Bez copy-paste mezi okny, bez vlastního serveru, bez API klíčů — vše přes lokální filesystem.

[![claude-bridge demo — jeden manager a tři worker chaty spolupracují živě v jednom okně VS Code](assets/hero.gif)](https://youtu.be/Oe_YQqUNnsg)

<sub>▶ **[Celé demo](https://youtu.be/Oe_YQqUNnsg)** — jeden manager rozešle úkoly třem workerům v jednom okně **VS Code**, ti odpovídají v reálném čase, a ty můžeš číst nebo prohledávat napříč všemi chaty.</sub>

**Stavěné pro multi-chat workflow ve VS Code** — měj několik Claude Code chatů otevřených vedle sebe v integrovaném terminálu a nech je spolupracovat. Funguje stejně dobře i z čistého `claude` terminálu; některé vlastnosti se trochu liší — viz [CLI vs VS Code](docs/cs/INSTALL.md#cli-vs-vs-code-extension).

## Proč to vzniklo

Když pracuješ s několika Claude Code chaty otevřenými vedle sebe, narážíš dřív nebo později na stejnou věc: jeden chat řeší něco, co druhý už ví, nebo se ho potřebuje na něco zeptat. Dnes je řešení obvykle "zkopíruj zprávu z jednoho okna do druhého". Nebo si necháš stejnou věc vysvětlit znova.

`claude-bridge` to mění. Chaty si můžou navzájem poslat zprávu, přečíst si, co se v sousedním okně právě teď řeší, nebo prohledat všechny dosavadní transcripty napříč všemi projekty.

## Co plugin reálně přidá

Po instalaci uvidí každý chat sadu nových nástrojů (MCP tools), které mu otevřou čtyři druhy možností:

**Vidět ostatní chaty.** Nástroj `peer_list` ukáže všechny aktivní Claude Code chaty na stejném počítači — jejich jméno, sessionId, cwd, věk poslední aktivity.

**Poslat někomu zprávu.** `peer_ask` napíše zprávu do inboxu jiného chatu, `peer_reply` na předtím přijatou zprávu odpoví. Doručení je spolehlivé i když cílový chat zrovna spí — zpráva čeká v inboxu a doručí se při jeho další aktivitě (s reálným časem, pokud máš zapnuté channels — viz INSTALL).

**Nahlížet do cizího chatu.** `peer_chat_read` přečte transcript sousedního chatu — posledních pár zpráv, vše od jeho posledního user promptu, nebo zprávy odpovídající dotazu (substring i regex). Doplňkové nástroje `list_projects`, `list_sessions` a `session_stats` ukážou metadata historických sessions napříč všemi tvými projekty.

**Prohledávat napříč chaty.** `peer_chat_search` hledá zadaný text napříč všemi sessions v projektu (případně i napříč všemi projekty). Hodí se, když nevíš, ve kterém chatu se něco řešilo, ale víš, o čem to bylo.

## Kdy se to hodí

Nejčastější situace, kdy plugin přijde k chuti:

**Dva agenti se na něčem dohadují.** Manažující chat zadá pracovním chatům úkol, poslouchá jejich odpovědi a koordinuje další postup. Jeden uživatel, tři chaty pracují souběžně.

**Potřebuješ kontext, který je v sousedním okně.** "Kámo, řekni mi, co jsi tam s druhým agentem zjistil o agent teams." Místo přepínání tabů a čtení backloggu si chat A přímo vytáhne relevantní pasáž z chatu B.

**Hledáš, kdy padlo nějaké rozhodnutí.** `peer_chat_read` s `query` najde místo, kde se mluvilo o konkrétní věci, včetně okolního kontextu. `peer_chat_search` to udělá napříč všemi sessions, když nevíš, kde hledat.

**Audituješ, co dělali agenti v noci.** Read-only přístup k JSONL historii umožní druhého dne projít, jaký workflow proběhl, co bylo zadáno a jak se to vyvinulo.

## Jak se to liší od Agent Teams?

Experimentální Agent Teams v Claude Code nechají model **spawnnout a koordinovat efemérní subagenty** uvnitř jedné session — skvělé pro „jeden prompt, vnitřní fan-out". claude-bridge řeší jiný problém: aby spolu spolupracovaly **tvoje vlastní, reálné, trvalé chaty**.

| | Agent Teams (nativní) | claude-bridge |
|---|---|---|
| Co jsou peeři | efemérní subagenti spawnnutí modelem | tvoje reálné chaty — píšeš do nich i ty |
| Číst **i** psát jako člověk | — | ✅ v každém peer chatu |
| Dostupné i v nečinnosti | potřebuje živý monitor | ✅ inbox počká, doručí při další aktivitě |
| Číst transkript jiného chatu | — | ✅ `peer_chat_read`, on-demand (nešpiní kontext) |
| Hledat napříč historií chatů | — | ✅ `peer_chat_search` (projekt i všechny projekty) |
| Přežije „smazání" chatu v UI | — | ✅ JSONL zůstane na disku a jde dál číst |
| Cross-project / observabilita | — | ✅ read-only nad celou tvou JSONL historií |

Jsou komplementární, ne konkurenční — a obojí se ještě vyvíjí. claude-bridge funguje už teď přes lokální filesystem, z CLI i (většinově) z VS Code extension.

## Pár prvních příkladů

### Jak vůbec zjistím, koho mám k dispozici

```
peer_list
```

Vrátí seznam aktivních chatů. Každý má `id` (UUID, vždy jedinečné) a `name` (lidsky čitelný slug, který může kolidovat, pokud jsou dva chaty se stejným ai-titlem).

### Pošlu zprávu sousednímu chatu

```jsonc
peer_ask {
  "to": "explore-mcp-server",
  "content": "Najdi v naší historii zmínky o agent teams a stručně shrň závěry."
}
```

Cílový chat ji uvidí buď okamžitě (pokud máš zapnuté channels — viz INSTALL), nebo při svém příštím MCP tool callu (piggyback fallback — vždy spolehlivý, jen s drobnou latencí).

### Mrknu, co druhý chat zrovna řeší

```jsonc
peer_chat_read {
  "to": "explore-mcp-server",
  "sinceLastUserPrompt": true
}
```

Vrátí poslední user prompt sousedního chatu a všechno, co od něj agent stihl. Užitečné, když chceš zjistit "kde jsou zrovna teď" bez čtení celé historie.

### Najdu konkrétní zmínku v sousedním chatu

```jsonc
peer_chat_read {
  "to": "explore-mcp-server",
  "query": "agent teams",
  "contextLines": 1
}
```

Najde všechny zprávy obsahující "agent teams" (case-insensitive) plus jednu zprávu před a po jako kontext. Pro pattern match přidej `"queryRegex": true`.

### Prohledám napříč všemi chaty v projektu

```jsonc
peer_chat_search {
  "query": "agent teams",
  "contextLines": 1
}
```

Najde všechny zmínky napříč všemi tvými chaty v aktuálním projektu, s kontextem. Defaultně přeskakuje sessions starší 30 dní.

### Prohledám napříč všemi projekty

```jsonc
peer_chat_search {
  "query": "rozhodnutí o auth",
  "scope": "all-projects"
}
```

Funguje napříč všemi tvými chaty pod `~/.claude/projects/`. Pokud je scope příliš velký (>200 MB po 30-day filter), vrátí `scope_too_large` s návodem zúžit dotaz.

### Přečtu uzavřenou session, kterou už v UI nevidím

```jsonc
peer_chat_read {
  "to": "09de67fe-2b3b-45d1-a576-aec89ffaf8c7",
  "crossProject": true,
  "lastN": 20
}
```

Funguje na jakoukoli JSONL session ze všech tvých projektů — `crossProject: true` zpřístupní i ty, jejichž chat už neběží.

## Na co je dobré dát pozor

Plugin běží **lokálně, na jednom stroji**. Inbox jde přes filesystem, ne přes síť. Pro distribuované týmy přes víc strojů zatím nepoužitelné.

**Real-time push vyžaduje admin enable.** Channels (push notifikace) jsou ve výchozím stavu vypnuté na úrovni org policy. Bez nich plugin funguje jen v piggyback fallback režimu — zpráva se doručí cílovému chatu až při jeho příštím tool callu. Pro reaktivní workflow je potřeba admin nastavit `channelsEnabled: true` **a zároveň** přidat plugin do `allowedChannelPlugins` allowlistu. Detail v [INSTALL](docs/cs/INSTALL.md#real-time-push--proč-a-jak).

**VS Code Extension má lazy tab activation.** Po reload window se MCP server v chat tabu spustí teprve při prvním kliknutí na záložku. Než klikneš, chat není v `peer_list` vidět. V terminálu (CLI) tento limit není — chat je viditelný hned po startu.

**Search na hodně velkých datech zatím není rychlý.** Při typickém dev box scope (5–15 projektů, do 50 MB) zvládne `peer_chat_search` odpovědět do 1–2 sekund. Při notebook se 50+ projekty se `scope: 'all-projects'` může protáhnout na desítky sekund nebo vrátit `scope_too_large`. Pro velký scope se připravuje FTS5 backend ve verzi v0.5+.

## Co kde najdeš dál

- **[Instalace a konfigurace](docs/cs/INSTALL.md)** — instalace, channels nastavení (dva nezávislé gaty), CLI vs VS Code Extension srovnání, cross-platform shell snippety, troubleshooting.
- **[Podrobný návod k použití](docs/cs/USAGE.md)** — všechny nástroje včetně argumentů, příkladů a workflow vzorů.

## Licence

MIT.

---
status: verified
verified_at: 2026-08-13
verified_by: ai-bridge-dev
purpose: Změřené chování PreCompact / PostCompact / SessionStart:compact hooků a dvou proměnných prostředí, které posouvají bod autocompactu.
sources:
  - Claude Code 2.1.226, binárka node_modules/@anthropic-ai/claude-code-linux-x64/claude
  - pískoviště scratchpad/compact-lab (vlastní cwd, vlastní projektová settings.json)
invalidates_when: >
  Vyměněná binárka Claude Code. Dvě ze šesti zjištění stojí na nedokumentovaném
  chování; binárka se na tomto stroji vyměnila 499× za pět týdnů.
---

# Měření compact hooků — 13. 8. 2026

Podklad k otázce, jestli řízení komprese patří do hooků místo do orchestrace přes `send-keys`.
Navazuje na úlohy #99 a #107.

## Uspořádání zkoušky

- Vlastní adresář `scratchpad/compact-lab`, vlastní **projektová** `.claude/settings.json`.
  Sdílený `~/.claude/settings.json` zůstal nedotčen — týká se celé flotily.
- Jeden hook `probe.py` pro všechny události. Zapisuje vstup do `log/hooks.jsonl`,
  chování bere ze souboru `mode.json`, takže se dá měnit bez sahání do nastavení.
- Model `haiku-4-5` (okno 200k), aby zkouška byla levná.
- Žádný peer v registru, žádný zásah do flotily, `tst-c` nedotčen.

## Výsledky

| # | co se ověřovalo | výsledek | doklad |
|---|---|---|---|
| T1 | PreCompact se spustí při `/compact` | **ANO** | `trigger=manual`, 08:09:35 |
| T2a | `{"decision":"block"}` kompresi zastaví | **ANO** | `Compaction blocked by PreCompact hook`, počet compactů 1 → 1 |
| T2b | návratový kód 2 kompresi zastaví | **ANO** | tatáž hláška, počet compactů 1 → 1 |
| T3 | stdout hooku řídí souhrn | **ANO** | souhrn začíná `ZZQ-MARKER-7`, řádek s `isCompactSummary` |
| T4 | práh autocompactu jde posunout | **ANO, ale podmíněně** | viz níže |
| T5 | `SessionStart:compact` doručí kontext | **ANO** | příloha `hook_additional_context` ve 3 ze 3 běhů |
| T6 | `initialUserMessage` po kompresi vyvolá tah | **NE** | řetězec jen v odrazu `hook_success`, nikdy jako zpráva |

### T4 — dva knoflíky, funguje jen jejich kombinace

```
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1    sám        → ŽÁDNÝ ÚČINEK
                                                  (32k tokenů proti prahu 1 800, nic)
CLAUDE_CODE_AUTO_COMPACT_WINDOW=100k
  + CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40         → VYSTŘELIL na preTokens 32 507
```

Rozhodující číslo je `preTokens 32 507`. Práh ze samotného okna by byl `80 000 − 13 000 = 67 000`;
skutečnost sedí na `floor(80 000 × 0,40) = 32 000`. **Procento tedy rozhodlo — ale jen ve chvíli,
kdy bylo okno nastaveno výslovně.**

Ověřeno, že proměnná v procesu skutečně byla (`/proc/<pid>/environ`), takže první selhání není
o špatném předání. Mechanismus té podmíněnosti **není potvrzený**, jen odvozený z kódu.

### Vzorec prahů, čtený z binárky

```
efektivní okno = okno − min(max_output, 20 000)
autocompact    = efektivní okno − 13 000                  ← výchozí
s přepínačem   = min(⌊efektivní okno × N/100⌋, výchozí)   ← jen dopředu, nikdy později
tvrdá zeď      = efektivní okno − 3 000                   ← dál sezení odmítne pokračovat
```

Pro okno 1 M: autocompact **96,7 %**, zeď **97,7 %**. Mezi nimi je 10 000 tokenů.
Blokovat autocompact u zdi tedy znamená koupit si deset tisíc tokenů a pak mrtvé sezení.

## Kontrakty hooků

**PreCompact**
- vstup: `session_id`, `transcript_path`, `cwd`, `trigger`, `custom_instructions`, `prompt_id`
- blokuje: `{"decision":"block"}` **nebo návratový kód 2**. `continue:false` v kontraktu **není**.
- stdout (neblokující, neprázdný) se stane pokyny pro sumarizátor

**PostCompact**
- vstup: navíc `compact_summary`
- výstup: jen hláška uživateli. Do kontextu modelu mluvit neumí.

**SessionStart, matcher `compact`**
- spustí se po dokončení komprese
- `hookSpecificOutput.additionalContext` dorazí jako příloha `hook_additional_context` — **funguje**
- `hookSpecificOutput.initialUserMessage` **tah nevyvolá** (ověřeno neinteraktivně i v tmuxu)

⚠ Pro subagenty a teammates se PostCompact ani SessionStart:compact nespouští.

## Co z toho plyne pro návrh

- **Měkký práh** postavit lze: buď dvojicí proměnných při spuštění peera, nebo — spolehlivěji —
  tím, že kompresi nadále spouští démon a hook jen odmítá vše pod prahem.
- **Pokyny pro souhrn per role** jsou hotová věc. Stačí hook, který podle `session_id` vybere text.
- **Probuzení po kompresi zůstává na nás.** Nativní cesta doručí kontext, ale nerozjede tah;
  peer pokračuje sám jen tehdy, má-li ve frontě nevyzvednutou položku.
- **Brána v démonovi se neruší.** Dvě ze šesti zjištění stojí na nedokumentovaném chování cizí
  binárky, která se mění stokrát týdně.

## Chyba, kterou zkouška odhalila v mém vlastním postupu

První kontrola hledala v přepisu řetězec `compactMetadata` a našla dva výskyty — jenže to byl
zdroják `peer-compact.ts`, který jsem si sám vložil do kontextu jako balast. **Podruhé v tomtéž
týdnu jsem hledal podle řetězce, který sám produkuji.** Správné měření počítá `compactMetadata`
jako *objekt na řádku JSONL*, ne jako podřetězec souboru.

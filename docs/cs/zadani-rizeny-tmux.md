---
status: proposal
verified_at: 2026-08-15
verified_by: ai-bridge-dev — po revizích F0.5 (tmux expert, skeptik, provoz, kb-ops; všechny zapracovány)
purpose: Zadání zpevnění vstupní cesty démon→peer — MINIMÁLNÍ verze po revizích. Původní návrh (automat S0–S6, restrikční vrstva, nová doprava) z většiny ŠKRTNUT s doloženými spouštěči pro návrat.
sources:
  - docs/cs/analyza-rizeny-tmux-2026-08-14.md (44 měření)
  - revize F0.5 — 4 nezávislé posudky (výstupy v tasks/, nálezy shrnuty níže)
triggers: [rizeny-tmux, pane-state, sendkeys]
invalidates_when: první výskyt škrtnutého stavu v events.jsonl (spouštěče níže) nebo změna verze tmuxu (pin 3.4).
---

# Zadání: zpevnění vstupní cesty (po revizích)

Revize F0.5 vyvrátila premisu původního návrhu: produkční data (346/351 doručení v pořádku,
všech 5 selhání má známou příčinu a nasazenou opravu) ukazují, že dnešní cesta
`sendKeys` — kontrakt vstupní řádky + verify + busy-probe — **není křehká**. Skutečné incidenty
týdne (fronta `/compact`, drafty, rozsypaná jména) mají opravy nasazené, nebo (jména) příčinu
jinde (`swap/move` nese jméno s oknem; `allow-rename off` UŽ BĚŽÍ v ~/.tmux.conf).

Z původního zadání zůstává to, co má doloženou bolest nebo nulovou cenu. Zbytek je škrtnut
se spouštěči.

## Rozsah (KEEP)

### 1. Snímek stavu panelu — měřit vše, léčit jen doložené

Rozšířit existující `display-message` dotaz v `sendKeys` o pole:
`pane_dead`, `pane_pid`, `pane_current_command`, `window_id`, `pane_synchronized`,
`pane_input_off`, `window_panes`, `window_zoomed_flag`, `pane_marked`, `alternate_on`.

- Oddělovač **tabulátor** (0x1f tmux escapuje do textu `\037` — změřeno na F0).
- **S-1 (nález experta 5):** prázdná odpověď snímku (cíl neexistuje; exit 0!) → před verdiktem
  „mrtvý" hledat registrovaný `pane_id` globálně (`list-panes -a`) — pane_id přežívá přesuny.
  Nenalezen → HANDOFF lifecycle.
- **S0:** `pane_dead=1` → HANDOFF lifecycle, žádný injekt. Primární signál pid+dead;
  `pane_current_command` jen sekundární (jméno je náhoda distribuce — nález 6).
- **Příslušnost k oknu (nález experta 2):** `window_id` snímku ≠ registrované → HANDOFF, nikdy
  kill. (join/move/swap/break nemají v tmux 3.4 hooky — změřeno; přesunutý peer nesmí být
  prohlášen za mrtvého ani „vyčištěn".)
- **Ostatní predikáty (sync, input_off, extra panely, zoom): DETEKCE BEZ NÁPRAVY.**
  Ne-čistý snímek → událost `pane_state_dirty` s celým snímkem. Kánon kb-ops: „kontrola,
  u které jsem neviděl selhat, není kontrola, je to zvyk" — nápravy se napíšou při prvním
  doloženém výskytu, do té doby by to byl netestovatelný kód. Výskyty: dnes 0 v celé historii.

### 2. Oprava existující nápravy copy-mode (nález experta 1 — jediný nový BUG nalezený revizí)

Dnešní `sendKeys` ruší copy-mode přes `send-keys -X cancel` — to v clock/choose módech
selže (`not in a mode`) a mód zůstane. **Náhrada: `copy-mode -q`** — změřeno, ukončuje všechny
módy a funguje i při `input_off` (server-side). Malá, měřená oprava skutečné vady.

### 2b. R3 podruhé — pane id je adresa (přibylo z živého testu 15. 8.)

Mimo původní rozsah, ale **táž vada, která už jednou položila flotilu**: v0.11.21 opravila
`@1011` → `_1011` (23 peerů nedosažitelných pro `peer_compact`); `%` zůstalo v
`UNSAFE_TARGET_CHARS`, takže `%1` se měnilo na `_1` — **věrohodné jméno session**, tedy tiché
zamíření jinam místo chyby. Odhaleno vlastním živým testem pár minut po jeho napsání.

- `parseHostTarget` zná třetí druh adresy: `{kind:"pane"}`.
- `hasSession` se u pane id ptá `list-panes -a`, ne `has-session` (jiný objekt, jiná odpověď).
- Kompilátor při té změně sám našel dvě místa, která předpokládala „když ne okno, tak session".
- Souvislost: revize doporučila hledat přesunutého peera přes `pane_id` (jediná identita, která
  přežije `move-window`/`join-pane`) — bez tohoto by ten budoucí kód adresu neuměl použít.

### 3. Hygiena s doloženou bolestí

- **`history-limit` pro flotilní sessions**: čte se PŘI VZNIKU panelu (změřeno 2×: `-g` i `-w`
  na existující panel nedosáhne) ⇒ nastavit na cílové session před `new-window` ve `spawn()`.
  Hodnota 2000 (capture čte ≤ ~50 řádků; pravda je v JSONL). Dnešních 500 MiB scrollbacku
  klesne až s respawny — říct vlastníkovi.
- **Úklid osiřelých bufferů při startu démona** (nález provozu 2): `list-buffers`, smazat
  `claude-bridge-*` cizích pidů; jedna událost s počtem. Pád mezi paste a delete dnes nechává
  kopii zprávy v serveru neomezeně.
- **Kanárek verze tmuxu** při startu: `tmux -V` ≠ 3.4 → warn událost (ne degradace).
- **Lint-test zákazu `pipe-pane -o`** (přepínačová sémantika — změřený footgun).

### 4. Observabilita (zúžená z nálezu provozu 6)

Události `pane_state_dirty`, `inject_refused` (HANDOFF případy) nesou: `injectId`, `requestId`,
`phase`, snímek. Čistý průchod jen `snapshotClean:true` na stávajícím logu — žádná záplava.

## Škrtnuto — se spouštěči návratu

| co | proč škrtnuto | spouštěč návratu |
|---|---|---|
| restrikční vrstva (whitelist vazeb, split-kill hook, mouse off) | 0 výskytů; vazby jsou JEN serverové (změřeno — zasáhly by `tst-c` i kokpit); join/move hooky neexistují | první `pane_state_dirty` se splitem/sync |
| automat S1–S5 s nápravami | nápravy bez doloženého výskytu = netestovatelné; S5 toggle umí predikát zavést | první výskyt v events |
| doprava paste pro jednořádkové | atomicita `send-keys -l` je táž (1 příkaz, 1vláknový server); 0 interleave v historii; nezměřeno chování Enter nad vloženým `/` | první zalogovaný interleave verify→Enter |
| intent záznam (WAL) + úklid uvíznutého payloadu | podmiňoval novou dopravu; u dnešní víceřádkové cesty 0 výskytů | s návratem dopravy, nebo první uvíznutý payload |
| kanárek s throwaway CC panelem | drahé při častých restartech; rozbití kontraktu se ohlásí samo první verify | — |
| GUI-tester fáze v plné šíři | jev má funkční ochranu (2 správné refusaly živě) | zúženo, viz plán |

## Nezměněná tvrdá pravidla

Doručený ≠ vykonaný (ověření z JSONL zůstává) · žádné `-g` na produkčním serveru · `tst-c`
nedotknutelná · nasazení = brána vlastníka · vlastnictví: návrh bridge-dev, aplikace na produkci
kb-ops, GO Zdeněk.

## Akceptační kritéria

1. S-1/S0/window-membership: mrtvý panel, neexistující cíl, přesunutý panel (`move-window` na labu)
   → HANDOFF s korektní událostí; ŽÁDNÝ kill, žádný falešný restart.
2. Detekce: sync/zoom/split vyvolané na labu → `pane_state_dirty` se správným snímkem; doprava
   přesto proběhne (detekce neblokuje).
3. `copy-mode -q`: clock-mode i choose-tree na labu → mód ukončen, injekt doručen (dnešní
   `-X cancel` na týchž scénářích prokazatelně selhává — regresní dvojice).
4. Payload matice: `/`, `:`, `.`, mezery, diakritika, **emoji a CJK** (wide znaky — nález 12).
5. `history-limit`: panel založený démonem po změně má limit 2000; existující panel nedotčen
   (doloženo snímkem `history_limit`).
6. Kill-test úklidu bufferů: vyrobit osiřelý buffer, restart démona (na labu), buffer pryč, událost sedí.
7. Regresní scénáře týdne (zpráva během streamování, draft, dialog) — beze změny chování.
8. Pane id `%N` projde parsováním nedotčené (regrese R3 „druhý znak").

⚠ **Oprava kritéria 7 po G4 (15. 8.):** rozepsaný draft má DVA výsledky a zadání je nesmí slévat —
GUI tester ohlásil FAIL proti mé chybně napsané formulaci a měl pravdu o zadání, ne o kódu:

| stav draftu | chování | doklad |
|---|---|---|
| clearable (≤ 40 úderů) | `displaced` — draft uložen do auditu, vratný přes `C-y`, oznámen v panelu, payload doručen | živě 15. 8. (`clearStrokes: 4`, `restorable: true`) |
| stuck | `refused-input-not-clear` — NIC se neodešle | produkce 9. 8., 2 výskyty |

**Zadání testu, které lže o očekávaném chování, je horší než žádné** — a autor kódu si ho proti
vlastní představě odškrtne. Proto G4 dělá nezávislý operátor.

Souvisí: [[plan-rizeny-tmux]], [[analyza-rizeny-tmux-2026-08-14]].

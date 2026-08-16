---
status: verified
verified_at: 2026-08-14
verified_by: expert-subagent (44 experimentů, izolovaný server `tmux -L cbtest`), zadal ai-bridge-dev
purpose: Empirická revize návrhu „řízený tmux" — verdikty k 8 hypotézám, 2 funkční varianty, 10 footgunů, provozní nálezy k paměti tmux serveru.
sources:
  - tmux 3.4, jádro 6.8.0-136-generic, glibc malloc
  - plný protokol: výstup subagenta z 14. 8. 2026 (transcript v tasks/)
invalidates_when: Změna verze tmuxu (zejména varianta A stojí na nedokumentovaném chování pipe-pane -I).
---

# Analýza: řízený tmux — verdikt měření

Revize návrhu, kdy démon řídí vstup a výstup peerů branami tmuxu místo emulace kláves.
Kontext: [[plan-pluginu]], úlohy #87, #92, #96. Rozhodnutí Zdeňka 14. 8.: tmux se nenahrazuje,
Claude Code je nenahraditelný (subscription billing), nic vlastního se nepíše.

## Verdikty

| # | hypotéza | verdikt |
|---|---|---|
| 1 | `select-pane -d` blokuje jen klávesnici klientů | **VYVRÁCENO** — zahazuje VŠECHEN vstup vč. `send-keys` a `paste-buffer`, tiše, exit 0 |
| 2 | `paste-buffer -p` = doslovné byty s markery | s výhradou — markery jen když aplikace zapnula režim 2004; fragmentace po 4095 B (souvislé, ~1 ms) |
| 3 | `send-keys -l` obchází výklad názvů kláves | potvrzeno — pro payloady vždy `-l` |
| 4 | `pipe-pane` nezastaví peera při vadném odběrateli | potvrzeno — panel běží, ale server bufferuje NEOMEZENĚ (370 MB/10 s) a glibc paměť nevrací |
| 5 | control mode utáhne flotilu | potvrzeno s výhradou — `%output` jen pro připojenou session ⇒ jeden klient NA SESSION; `pause-after` nutný |
| 6 | pty buffer ~64 kB; SIGHUP sémantika | SIGHUP potvrzen přesně; buffer je ale jen **12–19 kB** |
| 7 | scrollback vysvětluje 936 MB serveru | potvrzeno — ~3,5 kB RSS na 100znakový řádek při `history-limit 100000` z ~/.tmux.conf; `clear-history` růst zastaví, paměť jádru nevrátí |
| 8 | vložené `/` neotevře paletu | potvrzeno na reálném CC — bracketed paste leží v input lajně doslovně; `send-keys -l '/mod'` paletu otevře |

## Dvě funkční varianty (návrh v původním znění NELZE nasadit — hypotéza 1)

### A — trvalý můstek `pipe-pane -IO` per panel
- Jeden supervizovaný pomocný proces: stdin = výstup panelu (odposlech), stdout = vstup panelu (injektáž).
- Injektáž `\x1b[200~payload\x1b[201~\r` — byte-exaktní, **imunní vůči `select-pane -d`** ⇒ zámek pak platí výhradně pro lidi, přesně dle záměru.
- ⚠ Stojí na NEDOKUMENTOVANÉM chování (`-I` obchází input-off). Nutné: pin verze tmuxu + kanárkový self-test injektáže při startu démona.
- Pád helperu viditelný přes `#{pane_pipe}=0`; mezera odposlechu krytá JSONL přepisem.

### B — bez zámku, jen dokumentované chování
- `paste-buffer` → `capture-pane` ověření input lajny → `send-keys Enter`; nesouhlasí-li, `C-u` a retry.
- Server je jednovláknový ⇒ paste je vůči lidským klávesám serializovaný; riziko jen v okně paste→Enter a verify ho uzavírá.
- Pomalejší, ale bez závislosti na nedokumentovaném chování.

Doporučené pořadí: **B jako první krok** (malý, dokumentovaný), A jako eskalace, pokud zbytkové okno B v provozu prokazatelně bolí.

## Footguny (výběr, plný seznam v protokolu)

- `select-pane -d` zahazuje tiše — démon se o ztrátě nedozví.
- `paste-buffer` překládá LF→CR (pro chat TUI žádoucí; doslovné LF: `-s $'\n'`).
- `pipe-pane -o` je PŘEPÍNAČ — druhé volání rouru vypne. Pro idempotentní attach nepoužívat.
- Jedna roura na panel: `-I` zabije běžící `-O` odposlech ⇒ proto kombinovaný `-IO`.
- Odposlech vidí `\r\n` (ONLCR) — parser musí normalizovat.
- Zaseknutý odběratel roury / nečtený control klient = neomezený růst RSS serveru, trvalý do restartu.
- `history-limit` platí jen pro NOVÉ panely.
- TIOCSTI je na tomto jádře vypnuté (`legacy_tiocsti=0`) — mimo tmux žádná zadní vrátka pro vstup.

## Provozní nálezy nezávislé na redesignu

1. **`history-limit` dolů pro panely zakládané démonem** — jediná skutečná páka na 936 MB produkčního serveru (pravda je v JSONL, scrollback je duplicitní).
2. Zákaz `pipe-pane -o` v jakémkoli budoucím kódu.
3. Zmenšení RSS serveru dá jen plánovaný restart; `clear-history` jen zastaví růst.
4. Rozdělení na sokety per tým: teď NE — jediný ospravedlňující argument je „pád serveru zabije všech 26 najednou", a pády se nepozorují.
5. Oprava dřívějšího tvrzení: pty buffer je 12–19 kB, ne 64 kB — peer se při zamrzlém čtenáři zablokuje DŘÍV, než se tradovalo.

## Zbývající rasy i s variantou A

- Copy-mode (člověk scrolluje) — neměřeno, zda `-I` byty obejdou; před injektáží kontrolovat `#{pane_in_mode}`.
- Smazání input lajny ničí lidský draft — draft před `C-u` vyčíst a vrátit/zalogovat (dnešní chování „couvni a hlas" zůstává).
- Doručený ≠ vykonaný platí při JAKÉKOLI dopravě — ověřování z přepisu se neruší.

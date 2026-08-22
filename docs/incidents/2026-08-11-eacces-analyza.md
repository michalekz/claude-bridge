---
status: verified
verified_at: 2026-08-11
verified_by: ai-bridge-dev
purpose: Analýza opakovaného selhání `EACCES` při vlastní obnově démona Claude Code — příčina, dopad, co s tím lze dělat na naší straně.
sources:
  - ~/.claude/daemon.log (5494 řádků, od 3. 7. 2026)
  - přímé pozorování procesů a stavu binárky 11. 8. 07:5x
  - záloha logu ve scratchpadu designera (incident-057a841a/daemon.log.bak)
invalidates_when: Přestane-li se binárka Claude Code opakovaně nahrazovat, nebo změní-li démon způsob sledování změn.
---

# `EACCES` u démona Claude Code — analýza

Zadání Zdeňka 11. 8. Fakta dodal ai-designer, hypotézy jsou moje.

⚠ **Nejde o claude-bridge.** `claude.exe daemon` je démon Claude Code od Anthropicu. Zdrojové kódy nemáme, analýza je z chování, logů a stavu souborů.

## Závěr napřed

**Binárka Claude Code se na tomhle stroji opakovaně nahrazuje** — 499 výměn za pět týdnů, z toho 61 jen 11. 8. Démon Claude Code sleduje čas změny své vlastní binárky a při každé výměně se restartuje „kvůli upgradu". Když restart trefí okamžik, kdy je soubor rozepsaný, `posix_spawn` skončí na `EACCES`, démon zemře a jeho agenti na pozadí osiří.

**Příčina není u nás a naše strana ji neovlivní.** Co ovlivnit můžeme, je odolnost vůči ní — a jedna z těch úprav už je hotová (#105).

## Doložená měření

### 1. Binárka se NAHRAZUJE, nepřepisuje

```
07:53:18   inode 4457229   304 282 632 B   -rwxr-xr-x   odkazů 2
07:54:49   inode 4457212   304 282 632 B   -rwxr-xr-x   odkazů 2
```

**Změna inode při shodné velikosti i právech** = zapsal se nový soubor a přejmenoval se přes starý. To je chování instalátoru, ne editace.

### 2. Instalátor byl přistižen při běhu

```
pid 1207308   npm install @anthropic-ai/claude-code@2.1.227
```

Krátký proces, doběhl mezi dvěma mými příkazy. **Verze, kterou instaluje, už je nainstalovaná** — `package.json` nese 2.1.227.

### 3. Démon na každou výměnu reaguje restartem

Řádky, které selhání vždy předcházejí:

```
binary at …/claude.exe changed (mtime changed) — self-restarting for upgrade
shutting down (cause=upgrade, uptime=60s, leases=0, live_workers=2)
upgrade self-respawn failed to spawn: EACCES … posix_spawn '…/claude.exe'
```

**`uptime=60s`** a minutové rozestupy cyklu (06:34:06 · 06:35:06 · 06:37:07) říkají, že démon nastartuje, přežije minutu, uvidí další výměnu a jde znovu.

### 4. Statické vysvětlení `EACCES` je vyloučené

| kandidát | měření | verdikt |
|---|---|---|
| chybí právo ke spuštění | `-rwxr-xr-x` | ✗ |
| cizí vlastník | `michalekz` = uživatel démona | ✗ |
| oddíl `noexec` | `/ rw,relatime` | ✗ |
| chybí právo k průchodu adresářem | `drwxrwxr-x` | ✗ |

**V klidovém stavu je binárka spustitelná.** Selhání je tedy vázané na okamžik, ne na konfiguraci.

### 5. Výskyt je shlukový, ne trvalý

```
24. 7.   8×        28. 7.  12×        11. 8.   2×
25. 7.   3×        10. 8.   1×
```

Mezi 28. 7. a 10. 8. **třináct dní bez jediného výskytu**. Selhání nastává jen ve dnech, kdy se binárka vyměňuje často.

### 6. Instalace pokračují i teď, kdy démon neběží

Poslední řádek logu je selhaný restart v 06:37. Výměnu inode jsem pozoroval v 07:54, tedy o hodinu a čtvrt později.

⇒ **Démon je oběť, ne původce.** Nepadá proto, že by se sám upgradoval — padá proto, že mu někdo jiný mění binárku pod rukama.

## Hypotézy

### Pravděpodobné

**H1 — `EACCES` je závod s instalátorem.** `npm` rozbalí soubor a teprve pak mu nastaví právo ke spuštění. Spustí-li démon `posix_spawn` uvnitř toho okna, dostane `EACCES`, protože v tu chvíli soubor spustitelný opravdu není.

Sedí na všechno: stejný uživatel, právo `x` v klidu nastavené, selhání jen občas, a jen ve dnech s častými výměnami. **Poměr 26 selhání ku 499 výměnám** (5 %) odpovídá úzkému oknu.

**H2 — instaluje se dokola verze, která už je nainstalovaná.** 499 výměn za pět týdnů není běžná kadence upgradů; `package.json` i roster hlásí 2.1.227 a instaluje se přesně 2.1.227. Něco tedy o upgrade žádá znovu a znovu, přestože je hotový.

**H3 — reakce démona ten stav zesiluje.** Sledovat čas změny vlastní binárky a hned se restartovat je rozumné u jednorázového upgradu. Při opakovaných výměnách z toho vzniká restartovací smyčka po minutě, která zvyšuje šanci, že se některý restart do toho okna trefí.

### Spekulace — výslovně neověřené

**S1 — kdo instalace spouští.** Kandidáti: vlastní aktualizátor Claude Code (`installMethod: global`), spouštěcí skript flotily, nebo některý peer. **Nezjištěno.** Past, kterou jsem na to nastražil, chytila vlastní odraz — vzor `npm install @anthropic` seděl na příkazovou řádku mého vlastního shellu. Potřebuje čistší pokus, filtrovaný podle jména procesu, ne podle řádky.

**S2 — proč se smyčka nezastaví.** Nabízí se, že se porovnává dostupná verze proti verzi *běžících sezení*, ne proti nainstalované. Běžící sezení novou verzi vyzvednou až po restartu, takže by se podmínka nikdy nesplnila. **Nemáme čím doložit.**

## Dopad

```
výměna binárky
   → démon se restartuje (à 60 s)
   → někdy EACCES → démon zemře
   → agenti na pozadí osiří a do ~60 s je sklidí orphan watchdog
   → při dalším startu je bg adopt vzkřísí            ← vazba na #106
```

**Na naše peery to nesahá** — běží jako samostatné procesy v tmuxu, na démonovi Claude Code nezávisí. Zasaženi jsou jen agenti na pozadí.

⚠ **Vedlejší příznak, kterého si všimne i člověk:** během výměny vrací `claude --version` prázdný řetězec. Kdo v tu chvíli něco spouští, dostane nesrozumitelnou chybu.

## Co s tím lze dělat na naší straně

| co | proč to pomůže |
|---|---|
| **hotovo v #105** — sonda `agents --json` rozlišuje `probe-failed` | trefí-li naše volání totéž okno, brána **odmítne**, místo aby tiše propustila |
| **#106 ③** — smíření registrů | vzkříšeného agenta odhalí bez ohledu na to, proč démon spadl |
| zjistit původce instalací | jediné, co odstraní příčinu; vyžaduje čistší past |
| hlášení upstream | reakce démona na změnu binárky je jeho volba, ne naše |

**Zabránit výměně binárky neumíme** a myslím, že ani nemáme. Správná odpověď na cizí komponentu, která se pod námi mění, je **selhávat čitelně a neutrpět tichou škodu** — a přesně to obě naše úpravy dělají.

## Co zbývá změřit

1. **Kdo spouští `npm install`** — past filtrovaná podle `comm`, ne podle příkazové řádky.
2. **Zda se smyčka zastaví sama**, když se všechna sezení restartují na 2.1.227 (ověřitelné mimochodem při příštím rollu).
3. **Zda `EACCES` skutečně padá na chybějící právo `x`** — dalo by se chytit sledováním práv souboru v okamžiku instalace.

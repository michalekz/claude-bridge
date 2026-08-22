---
status: draft
verified_at: 2026-08-17
verified_by: ai-bridge-dev
purpose: Matice 32 předpovědí z oponentury v3 (skeptik, kb-ops, provoz, CC expert) s vyhodnocením a testy pro pilot 2. Dle kontraktu Zdeňka NIC nezapracováno do v3 — rozhodne měření.
sources:
  - docs/cs/zadani-flotila-nad-cc-daemonem-v3.md + plan-…-v3.md
  - oponentura 17. 8. (4× 8 námitek-předpovědí)
---

# Matice předpovědí — pilot 2

Vyhodnocení: **T** = testovat v pilotu 2 (očekávání napsané předem) · **A** = navrhuji
přijmout jako axiom při zapracování (netestovatelné pilotem, ale doložené) ·
**Š** = návrh škrtu, rozhodne pilot evidencí · **D** = definiční práce před pilotem.

## Blok 1 — EXISTENČNÍ: suverenita binárky a supervizoru (nejvýš)

| # | předpověď (kdo) | vyhodnocení | test P2 + očekávání oponenta |
|---|---|---|---|
| 1.1 | klíč jmenného prostoru supervizoru neznámý; kopie binárky buď rozdvojí flotilu, nebo nechrání (kb-ops 1) | **T — test č. 1** | spawn z kopie: počet stromů v `/tmp/cc-daemon-*`; obě větve mají předem napsané důsledky |
| 1.2 | `tengu_bg_binary_takeover` (default ON): novější npm klient PŘEVEZME supervizor z kopie (expert 1) | **T — test č. 2** | supervizor z vA, dotyk povrchu binárkou vB>vA → assert cmdline supervizoru; expert předpovídá takeover |
| 1.3 | stržení celého kokpitu (kill tmux serveru) = smrt flotily do ~60 s; „projekci lze kdykoli zbourat" neplatí (expert 2) | **T** | kill fleet-tmux + stopky nad workery; ② tmux+supervizor naráz; ③ stihne tick <60 s? |

Blok 1 může změnit §10 i §4 zásadně — proto se měří PRVNÍ, před stavbou B1.

## Blok 2 — compact: zaklínění a eskalace

| # | předpověď | vyh. | test |
|---|---|---|---|
| 2.1 | busy peer nad prahem: busy-brána × PreCompact hook = přetečení vyrobené námi (skeptik N1) | **T** | busy scratch >85 % přes všechny timeouty; pass = eskalace dřív než 95 % kontextu; jinak busy-brána → „odlož s retry, po N compact i přes busy" |
| 2.2 | opakovaně blokovaný autocompact nemá alarm; role dojede na tvrdý limit (expert 8) | **T** | odepřená kotva, hnát přes práh; počítat výstřely hooku; assert alarm (expert: nepřijde) |
| 2.3 | hooky z pluginu vystřelí i na staré peery mimo registr → blokovaný autocompact bez pomoci, deny bez cesty ven (provoz 1) | **T — podmínka P2** | scratch peer mimo registr s hooky přes práh; fix-kandidáti: pass-through mimo registr / alarm řádek |

## Blok 3 — journal, zámky, závody

| # | předpověď | vyh. | test |
|---|---|---|---|
| 3.1 | druhý vykonavatel ve stavu INJEKT doručí `/compact` podruhé (skeptik N2) + zamrzlý operátor (SIGSTOP, ne kill) = dvojitá injektáž nebo tiché čekání (provoz 2) | **T** | kill -9 I kill -STOP v každém stavu; počítat dvojitá doručení; pravidlo-kandidát: „prošlý stav vlastní držitel zámku; převzetí = přepis journalu" |
| 3.2 | stop × pane-died hook: reconcile vzkřísí stopnutou roli attachem dřív, než doběhne deregistrace (expert 3) | **T** | umělé zpoždění 3 s ve stopu, hlídač zapnutý; assert `stopped` po 60 s |
| 3.3 | compact drží zámek role minuty → reconcile nespraví mrtvý pohled; odmítnutí bez držitele/stáří je k ničemu ve 3 ráno (provoz 3) | **T + A** (obsah odmítnutí = axiom) | souběh compact(KOTVA-zdržený) + respawn rodiny + tick; každé odmítnutí nese pid+operaci+stáří |
| 3.4 | skeptik: journal-resume je workflow engine bez incidentu — reconcile má JEN eskalovat (N2-škrt) | **Š** | rozhodne 3.1: pokud posun automatu zdvojuje doručení, skeptik vyhrává |

## Blok 4 — hlídač a inotify

| # | předpověď | vyh. | test |
|---|---|---|---|
| 4.1 | inotify oslepne po atomickém rename rosteru; `jobs/` watch nevidí podadresáře → hlídač reálně jede na 5min ticku (expert 6) | **T** | 3 updaty rosteru → 3 eventy?; dispatch nové role po startu watcheru → event? |
| 4.2 | attach hned po respawnu trefí ERESPAWNING a panel umře podruhé — bez retry/backoff B4 flake (expert 7) | **T** | 20× cyklus; konvergence s retry ≤3 |
| 4.3 | hlídač po 5 pádech `failed` navždy (StartLimitBurst) a alarm nepřijde, protože vede přes něj (kb-ops 5; doklad: služba selhávala 24 dní) | **T + A: alarm o hlídači nesmí vést přes hlídače** | 6× kill do 10 s; kudy ven zpráva |
| 4.4 | skeptik N3: hlídač před migrací hlídá událost, kterou vyléčit neumí — odložit za P2 | **Š** | počítat spontánní úmrtí pohledů mimo fleet operace za běh pilotu; skeptik: 0 |

## Blok 5 — idle-reap a pin

| # | předpověď | vyh. | test |
|---|---|---|---|
| 5.1 | reap proběhne I s živým attachem („tichý respawn" — pid se mění bez akce fleetu; `tengu_bg_attach_wake_after_reap` existuje) (expert 4) | **T** | 3 role × 3 h: s pohledem / pin / holá; log pid+procStart à 1 min |
| 5.2 | pins.json nemá CLI, je pod proper-lockfile, hot-reload nedoložen — zápis fleetem = šum nebo neúčinnost (expert 5) | **T** | zápis pod zámkem/bez; 70 min; „lock compromised" v logu; pin zapsaný po startu supervizoru |

## Blok 6 — alarmy

| # | předpověď | vyh. | test |
|---|---|---|---|
| 6.1 | eskalační adresát je smrtelný (reap/compact) a během P2 „starý"; alarm leží v inboxu do rána (provoz 4) | **T + A: nevyřízená eskalace = trvalý stav slotu ve fleet_status** | eskalace na stopnutého/compactujícího adresáta; viditelnost jinde |

## Blok 7 — kanárek

| # | předpověď | vyh. | test |
|---|---|---|---|
| 7.1 | bez tabulky podmínka→reference→spouštěč→adresát vyrobí ≥3 falešné alarmy za 48 h při ~100 reinstallech/týden (provoz 5) | **D + T** | tabulka PŘED pilotem; běh přes ≥5 reálných reinstallů |
| 7.2 | ugrep vzor bez `ulimit -v` = 7GiB incident při každém běhu; se stropem SIGSEGV <5 s (kb-ops 6) | **T** | obě varianty, VmHWM; + definovat 2 druhy selhání (vzor nespadne = binárka opravena × spadne jinak) |
| 7.3 | skeptik N8: snapshoty/respawnFlags/drift jmen bez výskytu — kanárek jen 3 doložené položky | **Š** | evidenčně: kolikrát by škrtnutá položka měla důvod vystřelit |

## Blok 8 — zdroje, retence, měřicí definice (před pilotem)

| # | předpověď | vyh. | test |
|---|---|---|---|
| 8.1 | delta-práh RSS hnije + pod swapem slepý (RSS klesá vyswapováním — doloženo night-watch) → **podlaha MemAvailable ≥ 8 GiB v 5min oknech + PSS+swap per strom** (kb-ops 3 + provoz 8) | **D — přijmout definici před pilotem** | vzorkovat à 60 s, hlásit minimum |
| 8.2 | retence dle §10 mine 99,7 % růstu — `tmp/` jedné úlohy je 313 z 314 MB; věková retence nezachytí (kb-ops 2 + provoz 7) | **D** | růst na peer-den, tmp/ zvlášť; pravidlo: osy co/kdy/kdo/výjimky; NESMÍ smazat forenzní (84b8edfe) ani oživitelné (T4c) |
| 8.3 | reboot test smaže cwd pilotních peerů i evidenci v /tmp (provoz 8b) | **✅ VYŘEŠENO 17. 8.** — evidence zkopírována do docs/cs/pilot-p0-evidence/, P0 peeři stopnuti; pilot 2 dostane cwd mimo /tmp | — |
| 8.4 | git revert nevrací systemd stav → inventura sloupec „mimo repozitář" + návrat vyzkoušet doopravdy (kb-ops 7) | **A** | nanečisto v P3 |
| 8.5 | drop-in nepřežije přejmenování jednotky; dědičnost adj=0 není deklarace (kb-ops 4) | **A + T** | unit hlídače deklaruje explicitně; DropInPaths + /proc adj obojí |

## Blok 9 — škrty skeptika (rozhodne evidence pilotu)

| # | návrh | vyh. |
|---|---|---|
| 9.1 | `fleet view open` a `canary` nejsou slovesa (6→5 nástrojů… resp. 8→6 sloves CLI) | **Š** — audit events.jsonl: počet volání mimo dispatch/reconcile cestu |
| 9.2 | B5 (automat) za P2 — migrace potřebuje jen wake + deny (N4) | **Š** — počítat ruční compacty během P2; jednotky/tým = skeptik vyhrává |
| 9.3 | ready-check: „ověř kotvy" + roundtrip-nad-tahem hlídají neselhavší (N7) | **Š** — 20 dispatchů, počítat 0/20 |
| 9.4 | brány B1/B2 neumějí selhat → poškozené fixtury + inventura zapsaná předem (N6) | **A — přijmout do plánu při zapracování** (lepší test, žádný spor) |
| 9.5 | mrtvý panel stopnuté role nemá konec; roll ×24 mrtvol drží scrollback v RAM (provoz 6) | **T** | stop 1 + roll se selháním 1/3 attachů; RSS tmux po 48 h |

## Souhrn pro rozhodnutí

- **Testovat (T): 19** předpovědí, z toho blok 1 PŘED stavbou B1 — může změnit §4/§10.
- **Axiomy k zapracování (A): 5** — alarm o hlídači ne přes hlídače · eskalace jako stav slotu · obsah odmítnutí zámku · sloupec „mimo repozitář" · brány-které-umí-selhat.
- **Definice před pilotem (D): 3** — kanárková tabulka, MemAvailable podlaha, retenční osy.
- **Škrty čekající na evidenci (Š): 5.**
- **Vyřešeno hned: 1** (evidence mimo /tmp).

Nic z toho není zapracováno ve v3 — čeká na měření pilotu 2 a Zdeňkovo GO.

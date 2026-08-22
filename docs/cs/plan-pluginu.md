---
status: proposal
verified_at: 2026-08-10
verified_by: ai-bridge-dev
purpose: Souhrnný plán claude-bridge — kde plugin stojí, co ho dělí od stable, co jde do 0.11.27 a co leží v zásobníku.
sources:
  - git develop 5240b57, značka v0.11.26
  - katalog ~/.claude/plugins/marketplaces/claude-bridge/.claude-plugin/marketplace.json
  - zásobník úloh #5–#102
  - docs/cs/rotace-uctu/zadani-samostatneho-nastroje.md
invalidates_when: Vydáním 0.11.27, přepnutím stable kanálu, nebo změnou zadání rotace.
---

# Plán claude-bridge

Souhrn pro vlastníka. Odpovídá na tři otázky: **kde plugin dnes stojí**, **co ho dělí od stabilního vydání** a **co se ještě neudělalo**.

Sourozenecké dokumenty: [zadání samostatného nástroje pro rotaci](rotace-uctu/zadani-samostatneho-nastroje.md) · [README rotace](rotace-uctu/README.md)

| sekce | odpovídá na |
|---|---|
| [Kde jsme](#kde-jsme) | co je vydané a co běží |
| [Nejbližší rozhodnutí: stable](#nejbližší-rozhodnutí-stable-flip) | co dělí dev od stable a kdo to pouští |
| [v0.11.27](#v01127--nejbližší-vydání) | obsah nejbližšího vydání |
| [Rotace](#rotace--mimo-plugin-ale-váže-se) | proč není v pluginu a co z ní plugin potřebuje |
| [Dokumentace](#dokumentace--dluh-se-splácí-před-stable) | co chybí vnějšímu uživateli |
| [Zásobník](#zásobník-podle-témat) | všechno ostatní, roztříděné |
| [Brány](#brány--kdo-co-pouští) | která rozhodnutí nejsou moje |

## Kde jsme

```
develop      5240b57 · značka v0.11.26 · pracovní strom čistý
manifesty    4 × 0.11.26 (plugin + MCP server + démon + shared)
flotila      23 × 0.11.26 · tst-c 0.11.2 (záměrně nedotčen)
démon        0.11.26, 24 peerů
```

**Katalog má dva kanály a je mezi nimi propast:**

| kanál | verze | značka |
|---|---|---|
| `claude-bridge` (stable) | **0.10.0-rc.2** | `v0.10.0-rc.2` |
| `claude-bridge-dev` | **0.11.26** | `v0.11.26` |

Stable je o celou řadu 0.11 pozadu. Kdo si dnes plugin nainstaluje z veřejného kanálu, dostane verzi z doby před řídicí rovinou.

**Soak skončil.** Týdenní provoz na 0.11.24 doběhl rollem 9.–10. 8.; 0.11.26 je kandidát na stable.

## Nejbližší rozhodnutí: stable flip

Přepnutí stable kanálu na 0.11.26 je **jediná věc, která dnes brání vnějším uživatelům používat aktuální plugin**. Brána je vlastníkova.

### Co k flipu patří

| # | položka | stav |
|---|---|---|
| 1 | soak na jedné verzi | ✅ hotovo (0.11.24, týden, ukončeno rollem) |
| 2 | kandidát ověřený na flotile | ✅ 23 peerů na 0.11.26, 24 restartů bez vady |
| 3 | dokumentace pro cizího uživatele | ❌ dluh, viz [Dokumentace](#dokumentace--dluh-se-splácí-před-stable) |
| 4 | katalogový popis `claude-bridge-dev` | ❌ pořád text z v0.10.15 — vlastníkova položka |
| 5 | marketingové materiály | ⏸ čtyři hotové drafty čekají na ratifikaci |
| 6 | rozhodnutí vlastníka | ⏸ **brána** |

### Otázka, která u toho visí

**Je 0.11.27 podmínkou flipu, nebo ne?** Dvě čitelné cesty:

- **flip 0.11.26 hned** — dnešní kandidát je ověřený provozem; 0.11.27 pak jde do dev kanálu jako obvykle;
- **flip až 0.11.27** — stable dostane i opravy z rollu (tichý peer po compactu, mlčící guard), tedy vady, které vnější uživatel potká dřív než my.

Doporučuji **druhou**: #99 je vada, po které peer po compactu tiše stojí, a ta cizího uživatele potká hned. Zpoždění je jedno vydání, ne týden.

## v0.11.27 — nejbližší vydání

Vzniklo celé z rollu 9.–10. 8. Seřazeno podle škody, kterou to působí.

| # | co | povaha |
|---|---|---|
| #99 | peer po compactu tiše stojí | vada, řešení schválené |
| #100 | guard na limity nevystřelil nikdy | 🔴 vada, **příčina obou zablokování** |
| #104 | zablokovaný peer je neviditelný | chybí průběžná detekce |
| #101 | `peer_list` nerozliší zaneprázdněného od zablokovaného | chybějící rozlišení |
| #102 | wake nenese, že důvod sundání ≠ důvod acku | chybějící signál |
| #98 | zprávy se řežou | **otevřené vyšetřování** |
| #103 | restart rozsype pořadí oken | vada, opakuje se pokaždé |

### #99 🔴 Peer po compactu tiše stojí

**Vada:** ověření compactu má práh 180 s odvozený z měření na kontextech ~760 k. Nad 906 k komprese trvala déle, ověření hlásilo `unresolved` — a protože probouzecí řádka visí na úspěšném ověření, **neodešla**. Peer po úspěšném compactu zůstal stát.

**Řešení (autor Zdeněk):** krátce po odeslání `/compact` poslat peerovi **kanálem** příkaz k re-onboardu a k ohlášení veliteli. Zpráva čeká ve schránce nezávisle na tom, jak dopadne ověření.

Proč je to lepší než opravovat práh:

- probuzení se odpojí od ověření úplně;
- nejde přes `send-keys`, takže odpadá celá třída vad kolem vstupní řádky a palety;
- nese obsah, ne jen probuzení — peer po probuzení ví, co má dělat.

**Před implementací změřit:** zachovává fronta pořadí? Když ano, zpoždění (Zdeňkova hodnota 40 s) je jen rezerva a nic na něm nestojí. Když ne, musí být odvozené z dat.

### #100 🔴 Guard na limity nevystřelil nikdy

**Dvě nezávislá měření, obě říkají totéž.**

```
 9. 8. večer   session došla na 105 %   práh 0,70   událostí: 0
10. 8. 14:53   session na 76 %          práh 0,70   událostí: 0
```

V celé auditní stopě není **jediná** vlastní událost guardu. Grep na `guard` vrátí pouze `peer_compacted`, jejichž *text důvodu* to slovo obsahuje.

Rozlišit měřením: je vadný, nebo se nevyhodnocuje vůbec?

⚠ **Tohle je příčina, ne položka.** Obě instance zablokovaných peerů (#104) vznikly proto, že nikdo nevaroval. Není to totéž co hlídač rotace — je to vlastní funkce, kterou máme, máme ji zapnutou a nefunguje.

### #104 🔴 Zablokovaný peer je neviditelný — potřebujeme průběžnou detekci

Nález plt-velitele; odhalil to Zdeněk pohledem do okna. **Druhá instance téže třídy:**

| kdy | co | jak se to zjistilo |
|---|---|---|
| 9./10. 8. v noci | `mic-*`, `etl-*` na dialogu limitu při rollu | můj sken panelů po rollu |
| 10. 8. | `ai-designer` hard-stopnutý ~hodinu, nečetl zprávy, žádosti visely | až Zdeněk pohledem do okna |

**Jádro nálezu:** můj sken je **bodový** — běží po mé akci. Tahle porucha vzniká **kdykoli a mimo mé akce**.

⚠ **První návrh byl předimenzovaný a měření ho zmenšilo.** Chtěl jsem stavět průběžnou detekci. Ta **už existuje, běží cronem à dvě minuty a funguje** — `spend_watchdog.sh` zachytil oba případy:

```
 9. 8. 19:20:01  ALERT  etl:velitel + etl:dev
10. 8. 11:38:01  ALERT  plt:integration-dev + plt:keeper
```

Má i **polohové pravidlo**, které odliší aktivní dialog od zmínky v historii: je-li na spodku panelu normální vstupní řádek, je hláška jen text.

**Zbývají tři úpravy, ne nový systém:**

| # | co | doklad |
|---|---|---|
| ① | smazat adresné vyloučení autora | polohové pravidlo ho plně nahrazuje — viz níže |
| ② | doručovat, ne jen zapisovat | 9. 8. si alertu 80 minut nikdo nevšiml |
| ③ | prověřit pokrytí vzoru | dnes cílí na org měsíční strop; přihlašovací dialog neověřen |

**K bodu ①.** Hlídač vylučuje panel svého autora, protože ten hlášku běžně cituje. Vyloučení se ale aplikuje **před** záchytem, takže polohové pravidlo na tom panelu nedostane šanci — a hodinové zablokování designera nemá v logu ani řádku. Námitka, že smazání vrátí vlastní odraz, **neplatí**:

```
2026-08-10T14:58:01  zmínka-v-historii: ai:bridge-dev (ne dialog, vstupní řádek přítomen)
```

Můj panel v tu chvíli doslova citoval text dialogu. Vyloučený nejsem. Hlídač mě prohlédl a nevystřelil.

**Kontrola živosti patří před každou žádost s časovým limitem**, ne jen před eskalaci — `peer_restart`, `peer_compact`, `peer_ask` s čekáním. Všechny dnes hlásí „nepotvrdil", což má dvě příčiny s opačnou radou.

**Dvě opravy mých vlastních tvrzení, obě z logu:**

- **Hlídač nemlčel.** Varoval v obou případech; selhalo **doručení**, ne detekce. Slil jsem dohromady dva různé hlídače — mlčí náš guard v `rate_limit_status` (#100), ne spend watchdog.
- **„Ven jedině ukončením procesu" jsem nedoložil.** Log hlásí `vyřešeno` v 20:42:02, moje vynucené restarty přišly v 20:43. **Peery uvolnilo přepnutí účtu, ne já.** Platné znění: zmizí-li příčina, dialog zmizí sám.

### #101 `peer_list` má rozlišit zaneprázdněného od zablokovaného

Peer uvázlý v modálním dialogu má živý tep, registr ho hlásí jako `live` a `kill -0` projde — a přitom nereaguje. „Nepotvrdil" má dvě příčiny s **opačnou radou**: zaneprázdněného stačí zopakovat, zablokovanému čekání nepomůže nikdy.

Během rollu jsem to třikrát rozlišoval ručně, pohledem na panel. Řídicí rovina ten stav pozná; má ho vystavit.

### #102 Wake zpráva má nést, že důvod sundání ≠ důvod acku

`etl-velitel` odsouhlasil zastavení kvůli rollu a probudil se po vynuceném restartu z jiné příčiny. Jemu to prošlo, protože parkoval durable. Kdo zaparkuje „jen na chvíli", může o práci přijít.

### #98 🔴 Zprávy mezi peery se řežou — nevíme kde ani proč

**Otevřené vyšetřování, ne úloha k naplánování.** Zatím víme jen to, kde vada NENÍ.

Tři vzorky, všechny od téhož odesílatele, všechny končí **uprostřed slova**:

```
 407 znaků    9. 8.
2867 znaků    9. 8.
 955 znaků   10. 8.   msmrenmu-597b7dd1
```

Žádná společná mez → **není to pevný limit.**

**Co vylučuje naši vrstvu.** Uložený soubor ve schránce:

```
velikost 1293 B · pole content 955 znaků · JSON PLATNÝ · všech 10 klíčů přítomno
```

Kdyby řezal náš zápis, byl by useknutý **soubor** a s ním i JSON. Soubor je celý a platný — uříznutý je **obsah pole `content`**, tedy přesně to, co nám odesílatel předal. **Ukládáme bajtově věrně; vada sedí nad naší obálkou.**

**Otázky, na které nemáme odpověď:**

1. Řeže se náklad už na hranici volání nástroje u odesílatele — tedy nedogeneroval se argument (mez výstupu, přerušení proudu)?
2. Nebo mezi modelem a naším nástrojem sedí ještě vrstva, která obsah zkracuje?
3. Proč pokaždé jinde, a proč vždy uprostřed slova?
4. Nastává to jen u dlouhých zpráv, nebo jsme kratší uříznuté zprávy jen nepoznali?

**Proč to není kosmetika.** Příjemce nemá jak uříznutou zprávu rozeznat od úplné. 10. 8. mě to stálo nesprávné tvrzení vlastníkovi: zpráva nesla „token je mrtvý" a část, která to dokládala, se nedoručila — takže jsem mu hlásil jako otevřené riziko něco, co bylo vyřízené.

**Obrana, než příčinu najdeme:** odesílatel k obsahu připojí zamýšlenou délku nebo koncovou značku, příjemce ověří a při neshodě si řekne o zbytek. Do té doby platí pravidlo: **zpráva končící uprostřed slova je podezřelá — doptej se, nestav na ní.**

### #103 Pořadí oken se každým restartem rozsype

**Nedořešené a projevuje se pokaždé.** `peer_restart` panel zruší a vyrobí nový, který tmux zařadí **na konec sezení**. Po dávkové operaci tedy okna leží v pořadí, v jakém se restartovala, ne v tom, jak je má vlastník srovnaná.

Po rollu 10. 8. vypadalo sezení `ai` takhle:

```
je:   kb-dev · process-dev · kb-ops · designer · bridge-dev
má:   designer · bridge-dev · process-dev · kb-dev · kb-ops
```

Srovnáno ručně přes `tmux move-window`. **To je náplast, ne oprava** — po příštím rollu to bude znovu špatně.

**Co s tím.** Pořadí je vlastnost, kterou vlastník nastavuje a která nikde není zapsaná. Dvě cesty:

| cesta | co obnáší |
|---|---|
| zapamatovat si polohu při restartu a vrátit ji | drobná změna v `peer_restart`, žádný nový stav |
| deklarovat pořadí v rozvržení týmu | poctivější, ale je to nový kus konfigurace a `team_layout` ho musí umět srovnat |

Doporučuji **první** a hned: restart má peera vrátit tam, odkud ho vzal. Druhá cesta dává smysl teprve tehdy, až bude pořadí něco, co se deklaruje předem — a to dnes není.

### Doprovod

- **#97** — zbytek R-1: značky škrcení se zásah dotýká jen při úspěchu, takže pod trvalou chybou 403 se endpoint zkouší po každém volání místo jednou za minutu.

## Rotace — mimo plugin, ale váže se

**Rozhodnutí vlastníka 9. 8.: rotace nepůjde do claude-bridge.** Vzniká jako samostatný firemní nástroj — CLI, vlastní MCP server, časovač, žádný démon. Zadání je [tady](rotace-uctu/zadani-samostatneho-nastroje.md).

**Zadání se 9. 8. večer změnilo a zpřísnilo.** Hlídač limitů přestal být volitelnou nadstavbou a je jádrem:

- **bez modelu** — v okamžiku, kdy je hlídač potřeba, je právě sezení ta zablokovaná část;
- **preventivně** — dialog o limitu je tvrdý stop, ze kterého se strojově vyjít nedá;
- **soběstačně** — nesmí viset na naší telemetrii, protože ta 9. 8. mlčela.

### Co z toho zůstává v pluginu

| co | kde |
|---|---|
| oprava R-1 (týdenní okno jako hranice účtu) | **v pluginu**, vydáno v 0.11.26 |
| identifikace účtu z dvojice oken | v pluginu jako metoda, ostře použita 9. 8. |
| vlastní rotace, přihlášení, hlídač | **mimo plugin** |

R-1 patří do veřejného pluginu bezpodmínečně — není to rotace, je to vada skládání odpovědi ze dvou zachycení, která nastane i pouhým škrcením endpointu.

## Dokumentace — dluh se splácí před stable

| # | co | proč to blokuje stable |
|---|---|---|
| #84 | pravidlo: dokumentace se aktualizuje s vydáním, které mění povrch nástrojů | jinak dluh naroste znovu |
| #85 | revize `USAGE.md` + `INSTALL.md` proti aktuální verzi | vnější uživatel čte zastaralý popis |
| — | `KNOWN-LIMITATIONS.md`: `installed_plugins.json` má **jeden záznam na stroj** | překvapí každého, kdo provozuje víc sezení |
| — | `KNOWN-LIMITATIONS.md`: most pojmenuje spawnutého peera podle náhodné konverzace | obchází se `/rename`, ale nikde to není |

**Nález z rollu, který do omezení taky patří:** panel dostává po restartu nové id, takže mapa panelů pořízená na začátku dávkové operace je po prvním kroku k ničemu.

## Zásobník podle témat

Nic z toho není naplánované na konkrétní vydání.

### Řídicí rovina

| # | co |
|---|---|
| #82 | 🔴 dlouhý handler blokuje celou řídicí rovinu — změřeno, 2 ms čtení čekalo 60 s |
| #46 | MCP server jako podproces se registruje jako anonymní peer |
| #55 | detekce mrtvých sezení |
| #62 | investigace vlastního ovladače vedle tmuxu |
| #51 | vazba restartu code-serveru na životní cyklus sezení |
| — | migrace registru chybí v `events.jsonl`, je jen v journalu |

### Identita a bezpečnost

| # | co |
|---|---|
| #49 | průchod identitou + detekce poplachu |
| #50 | kontrola rozdvojení po spawnu, napříč spouštěči |
| #47 | rozšíření ochrany proti rozdvojení o úlohy na pozadí |
| #72 | `peer_list` hlásí pid zapisovatele titulku, ne procesu |

### Doručování

| # | co |
|---|---|
| #77 | `pending/` znamená „nepotvrzeno přečtené", ne „nedoručeno" — chybí záznam o odeslání |
| #95 | doručování přes nativní inboxový soket |

### Telemetrie a limity

| # | co |
|---|---|
| #60 / #61 | oprava závažnosti a skládání v `rate_limit_status` |
| #12 | detekce přepnutí modelu |
| #13 | předpověď z rychlosti spotřeby |
| #14 | souhrnný nástroj pro stav účtu |
| #69 | provenience cen v `model_info` |

### Pohodlí

| # | co |
|---|---|
| #53 | nápověda u `peer_not_found` |
| #54 | `peer_set_model` |
| #56 | vlastní šablona onboardingu u `peer_compact` |
| #58 | paletka do VS Code |
| #65 | sjednotit tři duplikáty mezi MCP serverem a sdíleným balíkem |

### Vnějšek

| # | co |
|---|---|
| #5 | shánění testerů |
| — | čtyři marketingové drafty čekají na ratifikaci |
| — | úklid mrtvého tokenu z adresy marketplace `oxyshop-plugins` (tichá vada: bez toho se katalog neaktualizuje) |

## Brány — kdo co pouští

| brána | drží | stav |
|---|---|---|
| přepnutí stable kanálu | **vlastník** | otevřená otázka |
| distribuce ven k cizím lidem | **vlastník** — brána se definuje účinkem, ne mechanismem | — |
| commity | designer, mandát od 5. 8. neomezeně | běží |
| katalogový popis pluginu | **vlastník** | nesplněno |

## Co tenhle plán neobsahuje

- **Termíny.** Pořadí ano, data ne.
- **Fázi B (fulltext).** Odložena, nic se na ní nezměnilo.
- **Práci na rotaci.** Má vlastní zadání a vlastní repozitář.
- **`tst-c`.** Zůstává na 0.11.2 záměrně a nesahá se na něj.

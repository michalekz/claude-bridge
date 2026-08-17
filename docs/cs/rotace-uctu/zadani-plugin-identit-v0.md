---
status: verified
verified_at: 2026-08-17
verified_by: ai-bridge-dev (ratifikace Zdeněk 17. 8. přes designera, msx6odb1)
purpose: RATIFIKOVANÉ zadání v0 pro samostatný CC plugin správy N Claude identit (registrace, limity, přepínání). Navazuje na ratifikaci z 9. 8. (samostatný nástroj mimo claude-bridge) a měření z 9.–11. 8.
sources:
  - docs/cs/rotace-uctu/zadani-samostatneho-nastroje.md (ratifikace 9. 8., commit 0fc4271)
  - ~/.claude-bridge/control/accounts/ (registrace 2 účtů z 9. 8.)
  - scratch nástroje: rotate.mjs, acct-probe.mjs, rot-deadman.sh (vyřazeno z provozu 11. 8., marker)
invalidates_when: změna formátu .credentials.json nebo OAuth limitního API
---

# Plugin identit — zadání v0 (návrh)

Samostatný CC plugin (NE součást claude-bridge): udržuje N registrovaných Claude
identit, hlásí jejich limity a přepíná, pod kterým účtem flotila konzumuje tokeny.

## Co je ROZHODNUTO a ZMĚŘENO dřív (nezačínáme od nuly)

| co | kdy | pramen |
|---|---|---|
| rotace = samostatný nástroj mimo claude-bridge | ratifikace 9. 8. | commit 0fc4271 |
| **spotřeba teče na účet TOKENU** (ne na účet, kterým session vznikla) | doměřeno 9. 8., trojmo | [[account-rotation]] |
| **běžící proces vyzvedne vyměněný credentials soubor BEZ restartu** | doměřeno 9. 8. | tamtéž — přepnutí „pod rukama" JE možné, restart peerů není nutný |
| selhání výměny je čitelné a vratné | doměřeno 9. 8. | tamtéž |
| týdenní okno = hranice účtu; **čas není identita** — záznamy třídit otiskem okna, ne časem | 9. 8. | 47ed073 + R-1 |
| R-1/#97: rate_limit_status po rotaci skládá odpověď ze DVOU účtů | doloženo konstrukcí | úloha #97 — plugin identit to musí vyřešit, ne zdědit |
| rozhraní se verzuje V KAŽDÉM volání; neznámý příkaz = verze 0; **rotace ODMÍTNE, nedegraduje** | rozhodnuto 9. 8. večer | kotva |
| automatika = konfigurovatelný práh, VYPNUTÝ default (Zdeňkova volba) | 9. 8. | kotva |
| stará scratch rotace VYŘAZENA Z PROVOZU (marker blokuje 4 zápisové cesty) | 11. 8., se souhlasem | nic z ní neběží; kód je předloha, ne základ |
| registrace 2 účtů už existuje | 9. 8. | `~/.claude-bridge/control/accounts/` (gmail, oxy2: token+email+meta) |
| daemon připraven na `accountProfile` per role | v0.11.x | `control_config` settableKeys |

## Rozsah v0 (minimum k užitku)

1. **Registrace identity** (bod 1 zadání): vedený průchod — izolovaný profil
   (`CLAUDE_CONFIG_DIR`), interaktivní přihlášení, uložení tokenu+meta do
   registru identit. Přeregistrace při expiraci. (Prototyp profilů existuje:
   `~/.claude-profiles/mantis-linka-*`.)
   ⚠ **Povinné akceptační kritérium — s poctivou proveniencí (korekce Zdeněk
   17. 8.):** dva registry záznamy ukázaly na týž účet (doloženo 9. 8.).
   **Příčina: ručně zkopírovaný token** — Zdeněk potvrdil vlastní copy-paste
   omyl při zakládání profilů. **Dědičnost credentials čerstvým
   `CLAUDE_CONFIG_DIR` je NEREPRODUKOVANÁ hypotéza** (process-devova env
   sanitizace možná strhla skutečný mechanismus, ale nikdo ho neověřil na
   čistém vstupu). Ochrana je táž pro obě příčiny: registrace musí
   ① sanitizovat env, ② vyžádat device-code login pro KAŽDOU položku,
   ③ skončit **důkazem identity** — sondou „pod kým teču", ne „login proběhl".
   Akceptace: registrace nad prostředím s cizími credentials musí selhat
   NAHLAS — zdůvodnění už není „změřená dědičnost", ale „nevíme, jestli
   dědičnost existuje, a spadnout nahlas je levnější než to zjišťovat
   na fakturách".
2. **Přehled limitů všech identit** (bod 2, měřicí část): aktivní účet ze
   statusline/oauth cesty (existuje, v0.9.0); **neaktivní účty minimální
   inference sondou s jejich tokenem — limity se čtou z HLAVIČEK odpovědi**
   (`anthropic-ratelimit-unified-{5h,7d,7d-opus}-*`; mechanismus `acct-probe.mjs`,
   měřeno 9. 8.). Výstup: session 5h / týden / Fable per identita + otisk okna.
   ⚠ `/api/oauth/usage` setup-tokenům vrací 403 (chybí `user:profile`) —
   **usage endpoint NENÍ cesta v0**; hlavičková cesta ano (stačí `user:inference`).
   403 ≠ mrtvý token (to je 401); 429 je sám o sobě informace „účet na limitu"
   (doloženo 17. 8. na oxy). Sonda = nenulová, zanedbatelná spotřeba — protokol
   pilotu to říká nahlas.
   ⚠ **Doměřeno 17. 8. při stavbě: hlavičkový povrch se od 9. 8. ZMĚNIL** —
   dnes nese `status` (allowed/…) + `reset` (→ otisk účtu funguje) + org id,
   ale **už ne remaining/limit** ⇒ procenta vytížení neaktivních touhle cestou
   NEJSOU. Poctivá vrstevnatost v0: aktivní účet = plná čísla (statusline
   cesta v0.9.0) · neaktivní = verdikt + stav oken + otisk (binární „allowed /
   at-limit", bez %) · plná čísla neaktivních = přes credentials pár
   s `user:profile` + refresh flow — **fáze 1.5** (pár existuje pro oxy,
   access token expirovaný ~6. 8. → potřebuje refresh; expirovaný refresh
   je dle pastí normální stav → přeregistrace).
3. **Ruční přepnutí** (bod 3): `switch <identita>` — zámek, záloha, výměna
   credentials, ověření (sonda potvrdí, že spotřeba teče na cílový účet),
   deadman pojistka, audit. ODMÍTNE při: chybějící doklad limitů cíle,
   neexpirovaný zámek, rozdíl schémat.
4. **Ovládání: MCP server pluginu** (bod 3): `identity_list` ·
   `identity_status` · `identity_switch` · `identity_register_start`.
   Verzované odpovědi (rozhodnutí 9. 8.).
5. **Hlášení přes claude-bridge** (bod 4): plugin píše do inboxů/kanálu jako
   peer „identity" — přepnutí, blížící se limit, selhání sondy. Bridge zůstává
   doručovací rovinou, plugin logikou (stejná dělba jako fleet CLI v3).

## Co v0 VĚDOMĚ NEDĚLÁ (odklad, ne zapomnění)

- automatické strategie přepínání (bod 2, rozhodovací část) — práh OFF default,
  zapnutí je Zdeňkova volba po soaku měřicí části
- per-peer identity (dnes: účet = celý stroj; per-role `accountProfile` až po
  přestavbě v3 — preset role je na to připravený)
- oprava R-1 uvnitř claude-bridge `rate_limit_status` (#97) — koordinovaná
  změna, ale samostatné vydání
- **sonda platební cesty jako samostatná funkce** (rozhodnutí Zdeněk 17. 8.):
  ① klíč v env = jen warning při sanitizaci · ② indikace overage (subscription
  přeteče do API na TÉMŽE tokenu — jeho typický případ) = FÁZE 2, postavená
  na usage datech; vědomý odklad

## Pool a hranice (doplněno z fleet ops: kb-ops + process-dev, 17. 8.)

⚠ **Governance — co je a co není dohodnuto (korekce process-deva):**
ratifikace 9. 8. se týkala rotace jako nástroje (bridge-dev). Pool v
`llm_accounts.yaml` je **přidělení účtů pro procesní linku P-003** (Zdeněk
30. 7. přidělil a sám se přihlásil) — **NENÍ to flotilní politika rotace;
žádná taková dohoda dosud neexistuje.** Flotilní politiku ratifikuje Zdeněk
teprve TÍMTO zadáním. Strukturu poolu přebíráme jako výchozí návrh, ne jako
jeho rozhodnutí o flotile.

- Pool (P-003): linka-a = `zdenek.michalek@gmail.com` (primární) · linka-b =
  `zdenek.michalek@oxyshop.cz` (záložní) · `z.michalek@oxyshop.cz` ZÁMĚRNĚ
  v rezervě mimo pool.
- **Mantinel z linky pro budoucí automatiku:** failover UVNITŘ poolu smí být
  automatický; přepnutí MEZI pooly nikdy samo — mění, který rozpočet platí.
- **Hranice rozsahu (potvrzeno nezávisle kb-ops i process-dev):** plugin řeší
  **CC identity** (subscription tokeny). API klíče přes proxy `:18202` NEŘEŠÍ —
  proxy drží klíč v kontejnerovém env, per-request selektor neumí. Neslévat;
  jen CC větev dnes může fungovat.

## Měřené pasti z procesní linky (process-dev, přebírá se jako závazné)

| past | doklad | důsledek pro plugin |
|---|---|---|
| dva záznamy → týž účet; past je TICHÁ, projeví se až na fakturách | doloženo 9. 8.; **příčina = ruční copy-paste tokenu (Zdeněk); dědičnost profilem = nereprodukovaná hypotéza** | akceptační kritérium registrace (viz výše) — kryje obě příčiny |
| `ANTHROPIC_API_KEY` v env **MŮŽE přebít** subscription — doloženo na P-003 workerech; **u interaktivních sessions s OAuth to běžný stav NENÍ** (Zdeňkova provozní empirie, korekce 17. 8.: „platný klíč v .env není sám o sobě chyba, jen warning — velmi častý případ") | 4. 8.: klíč v prostředí 6 z 24 agentů; mez platnosti = process-devův kontext, ne univerzální | sanitizace při registraci/switchi zůstává (jednoznačnost, čí token ukládám); **nález klíče u běžící session = WARNING se zdrojem do logu, NEblokuje**. Hranici obou empirií rozhodne nepovinný krok pilotu |
| expirovaný refresh token = očekávaný stav, ne porucha | vynuceno naostro (primární na prázdný profil) — „nic nespadlo" není doklad | ve statusu je „token expirovaný" normální stav identity → cesta k přeregistraci, ne eskalace |
| seznam příznaků vyčerpání je VŽDY neúplný | 9. 8. „org monthly spend limit" neodpovídal žádnému vzoru → eskalace místo failoveru | rozhodování podle textu chyby je o jedno znění pozadu: **hlasitá výchozí větev + log doslovného znění**, seznam doplňovat z provozu |

## ✅ RATIFIKACE 17. 8. — Zdeňkovy odpovědi (přes designera, msx6odb1)

1. **Pořadí: PROKLAD, širší než návrh** — měřicí část I ruční switch HNED;
   po B-krocích v3 se odkládá JEN automatizace (kterou v0 stejně nemá).
2. **Registrovat všechny TŘI identity včetně rezervy** `z.michalek@oxyshop.cz`
   — rezerva je registrovaná, ne v poolu; pool pravidla beze změny.
3. **v0 přepíná jen ručně na pokyn: ANO.**
4. **Přepnutí se NEHLÁSÍ** („je to všem transparentní… stačí jen do logu")
   — audit log povinný, karta/kanál ne.
   ⚠ Technická poznámka k zápisu (designer): do vyřešení #97 (R-1) může
   `rate_limit_status` po přepnutí skládat odpověď ze dvou účtů — **log switche
   musí obsahovat větu „guard čísla do #97 ber s rezervou"**, ať první podivný
   guard poplach po přepnutí nikdo nevyšetřuje jako poruchu.

**Aktualizace 17. 8. (doloženo voláním):** všechny tři setup-tokeny z 9. 8.
jsou PLATNÉ (gmail 200 · oxy 429 = autentizace prošla, účet na limitu — jede
pod ním flotila · oxy2 200; meta expirace 2027-08-09).
⇒ **Registrace těchto tří = IMPORT z `control/accounts/` + whoami ověření,
žádný device code.** Zdeňkův interaktivní čas není potřeba; device-code
průchod v pluginu zůstává pro budoucí identity a přeregistrace po expiraci,
ale není na kritické cestě pilotu. Pilot začíná importem → přehled limitů → switch.

## Otevřené otázky pro Zdeňka (zodpovězeno ratifikací výše — ponecháno pro kontext)

1. **Pořadí vůči přestavbě flotily (v3/#112):** plugin identit před stavbou B1–B6,
   po ní, nebo paralelně? (Můj návrh: zadání+plán teď, stavba po B-krocích v3 —
   „denně to jsou hodiny" mluví pro dřív, jedna rozdělaná přestavba pro později.)
2. **Kolik identit v první vlně a čí** — částečně zodpovězeno poolem z 30. 7.
   (2 + 1 v rezervě); zbývá: registrovat v první vlně i rezervu, nebo jen pool?
3. **Smí v0 přepínat jen ručně na pokyn** (doporučuji), nebo už s návrhem („limit za
   ~30 min, doporučuji přepnout — potvrď")?
4. **Ohlašovací povinnost:** přepnutí ovlivní všech ~24 peerů naráz — komu se hlásí
   předem (velitelé kanálem?) a je nějaké okno dne zakázané?

## Pilot (podmínka nasazení — Zdeněk 17. 8.: „opět chci pilot, bez něj žádné GO")

Ratifikace zadání = GO na stavbu, **NE na nasazení.** Mezi hotový plugin a ostrý
provoz patří pilot s protokolem; protokol → designer → Zdeněk → teprve GO.

- **Izolovaná testovací session** (`tst-*` vzor), ne produkční peer.
- **Celý řetěz naostro:** registrace identity (se Zdeňkem, device code) →
  přehled limitů všech tří → ruční switch TAM a hned ZPĚT → **sonda „pod kým
  teču" (účet) po každém kroku** → audit log úplný.
- **Akceptační kritéria napsaná PŘEDEM**, včetně toho, co je neúspěch —
  mj.: registrace nad prostředím s cizími credentials selže nahlas ·
  sonda po switchi ukáže cílový účet do X s · po switchi zpět původní ·
  žádný záznam v logu nechybí · nález `ANTHROPIC_API_KEY` v env =
  **WARNING se zdrojem do logu, ne FAIL** (korekce Zdeněk 17. 8.: platný
  klíč v .env není sám o sobě chyba, velmi častý případ).
- **Dva nepovinné poznávací kroky** (nepodmiňují GO, jen platí hypotézy):
  ① čistý vstup + čerstvý profil BEZ sanitizace → pod kým teču?
  (rozhodne nereprodukovanou dědičnost credentials) ·
  ② session s klíčem v env + přihlášeným OAuth → jedno volání → **z čeho se
  platilo, doloženo z usage/faktury, ne domněnkou** (rozhodne hranici mezi
  Zdeňkovou empirií a process-devovým měřením z P-003).
- ⚠ **Řečeno nahlas:** pilot se dotýká OSTRÝCH účtů (jiné neexistují) —
  spotřeba sond je zanedbatelná, ale JE nenulová; a **switch přepíná účet
  CELÉHO stroje**, takže krok switch běží v dohodnutém okně, kdy to flotile
  nevadí, a vrací se okamžitě. Okno odsouhlasí Zdeněk v protokolu.
- Selhání kteréhokoli kritéria = pilot FAIL, oprava, nový běh — žádné
  „prošlo s výhradou".

## Bezpečnost (převzato, platí)

Tokeny nikdy do repa ani do chatu (opis, ne string) · soubory 600 · záloha před
výměnou · audit každé výměny s otiskem okna · deadman: nedokončená výměna se
sama vrátí.

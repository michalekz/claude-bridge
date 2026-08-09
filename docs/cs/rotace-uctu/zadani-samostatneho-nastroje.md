---
status: proposal
verified_at: 2026-08-09
verified_by: ai-bridge-dev
purpose: Zadání samostatného firemního nástroje pro rotaci a správu předplatitelských přihlášení, mimo claude-bridge.
sources:
  - docs/cs/rotace-uctu/protokol.html (měření, 22 hypotéz)
  - docs/cs/rotace-uctu/rozhodnuti.html (rozhodnutí a doporučení)
  - scratchpad/rotate.mjs, rot-heartbeat.sh, acct-probe.mjs (prototypy, ověřené provozem 9. 8.)
invalidates_when: Claude Code přestane číst přihlášení ze souboru, nebo změní tvar hlaviček limitů.
---

# Samostatný nástroj pro rotaci a správu přihlášení

Zdeňkovo rozhodnutí 9. 8. 2026 večer: rotace **nepůjde do claude-bridge**, ale vznikne jako samostatný nástroj ve firemním privátním repozitáři.

Tenhle dokument je zadání. Měření, o která se opírá, jsou v sourozeneckých dokumentech ve stejném adresáři.

## Proč samostatně

Celý večer jsme řešili, jak rotaci dostat do claude-bridge a přitom ji nevydat veřejně. Vzniklo z toho pět otázek, z nichž ani jedna neměla levnou odpověď:

- dělení veřejné mechaniky × privátní politiky
- vlinkování privátního modulu při buildu
- verzní vyjednávání mezi pluginem a démonem
- neznámá „umí Claude Code stahovat z privátního repozitáře"
- zásah do veřejného katalogu, ze kterého bere flotila

**Samostatný nástroj ruší všech pět naráz**, protože se veřejného repozitáře ani katalogu nedotkne.

### Klíčový nález, který to umožnil

Předpokládali jsme, že rotace potřebuje telemetrii flotily. **Nepotřebuje.**

Stav N připojení = **N sond**. Hlavička odpovědi `anthropic-ratelimit-unified-*` nese okno i stav pro účet, kterému token patří — změřeno 9. 8. na všech třech účtech. Není k tomu potřeba číst nic, co píše claude-bridge.

Tím padá jediná vazba, kolem které se stavěly všechny ty komplikace.

## Tvar: CLI + MCP server + časovač. Žádný démon.

| co je potřeba | co to vyžaduje |
|---|---|
| rotace, správa přihlášení | **příkaz**, ne služba |
| stav N připojení | **příkaz** |
| denní hlídání expirace a živosti | **systemd časovač** |
| automatický práh | fáze 3, odloženo |

Odpadá zámek, stavový soubor, RPC smyčka i životní cyklus služby — u claude-bridge je to největší část kódu, která s vlastní funkcí nemá co dělat.

**Démon se přidá, až ho něco bude potřebovat.** Ne dřív.

MCP server je tenká vrstva, která volá totéž CLI. Registruje se v sezení **cestou k souboru**, ne přes katalog pluginů — žádný marketplace, žádné `/plugin update`.

## Rozhraní

### CLI

```
acct status              který profil je aktivní, kdy vyprší, je živý
acct list                všechny profily + limity každého (N sond)
acct use <profil>        přepni na profil (s předletovou sondou)
acct restore             zpět na kotvu záchrany
acct anchor              postav a ověř kotvu záchrany
acct health              denní přehled: dny do expirace + živost všech
```

### MCP nástroje

| nástroj | co vrací |
|---|---|
| `account_status` | aktivní profil, jeho limity, stáří záznamu |
| `account_list` | všechny profily s jejich session i týdenními limity |
| `account_use` | provede rotaci, vrátí výsledek a otisk cílového okna |

Rozdělení ploch drží princip z claude-bridge: **CLI je primitivum, MCP je fasáda.** Nástroj, který potřebuješ při rozbitém přihlášení, nesmí sedět za tím rozbitým přihlášením — a MCP server žije uvnitř sezení, které je autentizované právě tím souborem, co se mění.

## Datové uložiště

```
~/.claude-bridge/control/accounts/     (0700, soubory 0600)
  <profil>.token        roční token ze `setup-token`
  <profil>.email        komu patří
  <profil>.meta.json    vznik + dopočtená expirace
  .rescue.credentials.json    kotva záchrany — poskládaný roční profil
  .pre-rotation.credentials.json   archiv původního /login (NEOVĚŘITELNÝ)
active-account.json     který profil je aktivní · jediný zdroj pravdy
```

⚠ **Datum vzniku ročního tokenu musí žít mimo hlavní stavový soubor**, ať přežije jeho přestavbu. Je jediným nositelem informace o expiraci — z tokenu ani z API se nezjistí.

Cestu lze při vzniku nástroje přesunout jinam; dnešní umístění je dědictví prototypu.

## Invarianty

Všech pět je schválených designerem 9. 8. a čtyři z nich vznikly z vyvrácené hypotézy.

1. **Do živého souboru se nikdy nezapisuje profil, který neprošel čerstvou sondou.** Mrtvý token by jinak dojel do souboru a celá flotila by naráz spadla na `Login expired`.
2. **Zachycení patří profilu podle OTISKU OKNA, ne podle času.** Otisk je dvojice `(5h resetsAt, 7d resetsAt)` — jedna hodnota nestačí, okna jsou zarovnaná na půlhodinu a dva účty se mohou trefit. Časové pravidlo padlo na protipříkladu: zachycení třináct sekund po rotaci neslo data předchozího účtu, protože rozpracovaný tah doběhl na starém účtu.
3. **Rotuje se PROFIL, účet se netvrdí.** Zobrazená identita nemá vazbu na skutečnou — `auth status` opakuje, co zapsalo přihlášení, a `userID` je číslo instalace. Do auditní stopy patří profil.
4. **Kotva záchrany je poskládaný roční profil, ne browserové přihlášení.** Browserová záloha je ze své podstaty neověřitelná: zkouška ji znehodnotí, ať dopadne jakkoli.
5. **Polarita brzdy na tep:** pokus, který má rotaci zrušit, snímkuje stav PŘED; pokus, který ji má zachovat, stav PO. Tvrdý invariant s testem obou směrů.

## Co nástroj NEobsahuje

- **Automatický spouštěč na prahu.** Fáze 3, vypnutá ve výchozím stavu, až po tom, co ruční provoz přežije celý pracovní den.
- **Volbu cíle podle zbývajícího prostoru.** Zatím prosté kolečko; cílový účet se nemusí znát dopředu, zjistí se přepnutím a cena omylu je jedno kopírování.
- **Stav `effective`** — potvrzení, že přepnutí dosedlo u peerů. Čte se ze zachycení stavové řádky, které píše claude-bridge. Dá se doplnit později jako čtení jednoho souboru, **read-only, bez vazby opačným směrem**.

## Vazba na claude-bridge: téměř žádná

| směr | co |
|---|---|
| nástroj → claude-bridge | nic |
| claude-bridge → nástroj | nic |
| společný soubor | `~/.claude/.credentials.json` — zapisuje jen nástroj, claude-bridge z něj jen čte token pro endpoint spotřeby |

**Oprava R-1 v claude-bridge (commit `47ed073`) funguje i tak.** Hranicí účtu je shoda týdenního okna obou půlek odpovědi — to se zahojí samo, ať rotaci provede kdokoli. Kdyby byla oprava postavená jinak („rotace zneplatní zachycení"), musel by se claude-bridge o rotaci dozvědět, a to je přesně ta vazba, kterou tímhle rušíme.

## Instalace a aktualizace

```
privátní firemní repozitář  →  git clone na stroj
                            →  MCP server registrovat cestou k souboru
                            →  systemd časovač pro denní přehled
aktualizace                 =  git pull + restart časovače
```

Žádný marketplace, žádný katalog, žádné `/plugin update`, žádná otázka veřejnosti.

## Otevřené otázky

1. **Jméno a umístění repozitáře.** Podle konvence flotily jde o firemní nástroj; `/opt/hmh/tools/` už takové věci hostí.
2. **Zda časovač, nebo cron.** Časovač je konzistentnější s tím, jak běží claude-bridge.
3. **Kolik profilů se počítá do budoucna.** Zadání říká N; dnes tři.
4. **Chování na macOS.** Claude Code tam drží přihlášení v Keychainu, ne v souboru. Pro firemní nástroj na našich strojích to nevadí; pro kohokoli s Macem by to nefungovalo. Neměřeno.

## Prototypy, které se zproduktivní

Vše ověřené provozem 9. 8. — šest rotací na živé flotile 24 peerů bez jediné chyby.

| soubor | co umí |
|---|---|
| `rotate.mjs` | status / anchor / to / restore, předletová sonda, kontrola přepsání |
| `rot-heartbeat.sh` | brzda na tep — vrátí kotvu, když přestanou chodit značky |
| `acct-probe.mjs` | hlavičky limitů pro daný token |
| `rot-observe.mjs` | co si který peer myslí o svém účtu |

Žádný z nich nesmí vypsat hodnotu tokenu. Všechny pracují s otisky.

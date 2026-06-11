# Channels — průvodce odstraňováním problémů

Tento dokument je hloubková reference pro rozchození real-time push channels v claude-bridge. Základní setup je v [INSTALL.md](INSTALL.md); tento soubor čti, když push nefunguje a chceš přesně vědět proč.

> **Než začneš — potřebuješ vůbec channels?**
>
> claude-bridge doručuje zprávy **i bez channels**, přes *piggyback*: když sender napíše `peer_ask`, příjemce zprávu uvidí při svém **dalším tool callu**. Doručení je garantované a spolehlivé; latence závisí na aktivitě příjemce.
>
> Pokud ti zprávy chodí, jen se zpožděním, plugin **není rozbitý** — piggyback funguje záměrně. Tento dokument je jen pro případ, kdy chceš **real-time push** (zprávy renderované inline jako `<channel>` tag v moment doručení, bez nutnosti tool callu) a push se nedostavuje.
>
> Real-time push je **volitelný upgrade**, ne baseline požadavek.

## TL;DR — tři gaty, které musí být všechny otevřené

Channels doručí zprávy inline jako `<channel>` tagy jen když platí **všechny tři** níže současně. Pokud kterýkoli tichoušky selže, zprávy padají na piggyback (doručení při příštím tool callu) a uživatel vidí lag bez zjevné chyby.

1. **`channelsEnabled: true`** ve správném settings souboru (Console účty: user-level `~/.claude/settings.json`; Teams/Enterprise: managed settings — viz [Org admin kontext](#org-admin-kontext-teamsenterprise-vs-console)).
   *Ověření:* `cat`/`type` soubor přímo.
2. **`allowedChannelPlugins`** obsahuje exaktní match `{marketplace, plugin}` pro to, co je nainstalované.
   *Ověření:* porovnat s výstupem `claude plugin list` (část za `@` je marketplace name).
3. **`--channels plugin:<plugin>@<marketplace>` flag** při startu Claude Code, marketplace name odpovídá install source.
   *Ověření:* zkontrolovat launch command a porovnat s `claude plugin list`.

Pokud kterýkoli gate chybí, dostaneš jeden z error patternů popsaných níže.

### Rychlý symptom index — skoč na fix

| Co vidíš | Sekce |
|---|---|
| `not on your org's approved channels list` warning | [→ není v allowlist](#plugin-claude-bridgemarketplace-není-na-org-allowlistu) |
| `plugin not installed` při `--channels` startu | [→ plugin not installed](#plugin-claude-bridgemarketplace--plugin-not-installed) |
| `unsupported source type` při `plugin install` | [→ unsupported source type](#plugin-install-selže-s-unsupported-source-type) |
| Zprávy přijdou jen s dalším tool callem (push tichoušky selhává) | [→ push padá na piggyback](#zprávy-přicházejí-jen-při-dalším-tool-callu-příjemce-push-tichoušky-padá-na-piggyback) |
| `identity_unresolvable` při bootu pluginu | [→ identity race](#identity_unresolvable-při-bootu-pluginu) |
| Stejné jméno pro víc peerů ve stejné složce (vše "marketing") | [→ name collision](#dva-peeři-ve-stejné-složce-mají-stejné-name-marketing-atd-a-peer_ask-name-vrací-peer_not_found-nebo-ambiguous_peer) |
| `peer_ask` vrací `peer_not_found`, ač `peer_list` to jméno právě ukázal | [→ peer mezi voláními vypršel](#peer_ask-name-vrací-peer_not_found-ač-peer_list-právě-ukázal-toto-jméno) |
| Peer není v `peer_list` vůbec (vidíš jen sebe) | [→ peer chybí úplně](#peer-není-v-peer_list-vůbec) |
| Dva duplicitní `plugin:claude-bridge@...` řádky v startup banneru | [→ duplicate banner](#startup-banner-ukazuje-dva-duplicitní-řádky-pluginclaude-bridgemarketplace) |

## Společné požadavky (jakýkoli OS)

### Marketplace identifier musí odpovídat instalaci

`claude plugin list` ukáže, ze kterého marketplace plugin pochází:

```
claude-bridge@claude-bridge      ← instalovaný z public github (single-plugin marketplace)
claude-bridge@oxyshop-plugins    ← instalovaný z oXyShop monorepa
```

Část za `@` je marketplace name. Všude, kde používáš plugin identifier — `--channels` flag, `allowedChannelPlugins` entry, `claude plugin update` — musí marketplace name přesně odpovídat.

**Častá past:** update přes `claude plugin update claude-bridge` (bez `@<marketplace>`) vrátí v CLI "Plugin not found". Použij kvalifikovaný `claude plugin update claude-bridge@<marketplace>`.

### Plný restart po update pluginu

Když `claude plugin update` hlásí `Restart to apply changes`, znamená to, že nový bundle je na disku, ale **běžící plugin proces má stále starý kód načtený v paměti**. Aby se nový kód aplikoval:

- **CLI:** `Ctrl+D` pro úplné ukončení Claude Code, pak `claude --channels ...` pro fresh start.
- **VS Code Extension chat:** `Ctrl+Shift+P` → `Developer: Reload Window`. Pokud nový bundle nenaskočí po reloadu, zavři VS Code úplně a otevři znovu.
- **NEstačí samo o sobě:** `/mcp reconnect` uvnitř Claude Code. To jen obnoví MCP handshake; podkladový plugin proces drží starou paměťovou kopii.

### Drž celou fleet na jedné verzi

Mixed-version fleet (někteří peeři na v0.5.2, jiní na v0.6.0) produkuje subtilní nekonzistence, které se těžko diagnostikují: name collisions, kde jedna strana vidí cwd-slug a druhá ai-title, chování push watcheru závisející na verzi příjemce, OSC 2 emisi jen z některých peerů. Každý je samostatný symptom a kumulují se.

**Doporučení:** když vyjde nová claude-bridge verze, `Ctrl+D` + restart každého běžícího peera (ne jen toho, na kterém testuješ). To je nejlevnější způsob, jak udržet fleet v zdravém stavu.

### Org admin kontext: Teams/Enterprise vs Console

Default pro `channelsEnabled` závisí na typu tvého claude.ai účtu:

- **Console (individuální / Anthropic Console účet):** channels default **ON**. User-level `~/.claude/settings.json` opt-in je honored.
- **Teams / Enterprise:** channels default **OFF**, dokud je admin nepovolí v managed settings. User-level config je ignorován.

Pokud jsi Teams/Enterprise user, admin musí upravit `allowedChannelPlugins` v claude.ai → Admin settings → Claude Code → Channels. User-level `~/.claude/settings.json` nemůže přepsat managed policy.

Když enabluješ channels pro svůj org, pamatuj, že `allowedChannelPlugins` **nahrazuje** Anthropic default seznam. Pokud tvoji uživatelé spoléhají na Telegram / Discord / iMessage channels, vypiš je explicitně taky.

## Linux / macOS

### Lokace settings souboru

User-level (individuální Console účty):

```
~/.claude/settings.json
```

Přidej:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-bridge", "plugin": "claude-bridge" }
  ]
}
```

### Restart příkaz

```bash
# Ukonči Claude Code přes Ctrl+D, pak:
claude --channels plugin:claude-bridge@claude-bridge
```

### VS Code Remote (Linux remote, libovolný klient OS) — terminal profile

Terminal profily pro Remote-SSH integrovaný terminál jdou do **klient-side** `settings.json` (na notebooku), NE do `~/.vscode-server/data/User/settings.json` na remote. Viz [INSTALL.md — VS Code terminal profile](INSTALL.md#vs-code-terminal-profile-všechny-os) pro plný snippet.

### Časté Linux pasti

- **`claude plugin marketplace add github.com/owner/repo` shodí terminál**: CC bug na Linux 2.1.173 v některých scénářích. Marketplace JE zaregistrovaný v settings i přes crash. Přeskoč další krok (`claude plugin install`) a místo něj ručně edituj `~/.claude/settings.json`, přidej `"claude-bridge@claude-bridge": true` do `enabledPlugins`, pak restartuj Claude Code. Plugin se nainstaluje při dalším startu.

- **`Bash subprocess nemá tty`**: záměrně — Claude Code spawne subprocess shelly bez controlling terminálu. Nemá vliv na channels; jen znamená, že z těch shellů neumíš OSC-emitnout. Plugin spravuje vlastní OSC emisi přes tty parent CC.

## Windows

Windows má striktnější policy enforcement a několik platform-specific config lokací. Pokud push nefunguje, přečti tuto sekci celou.

### Lokace settings souborů

Existují **tři různé `settings.json` soubory**, na kterých záleží na Windows, každý spravuje jiné věci:

| Soubor | Cesta | Co kontroluje |
|---|---|---|
| Claude Code user settings | `%USERPROFILE%\.claude\settings.json` | User-level channels opt-in (jen Console účty — Teams ignoruje), `enabledPlugins`, marketplaces |
| VS Code user settings (Windows klient) | `%APPDATA%\Code\User\settings.json` | Terminal profily pro VS Code integrated terminal (i když je připojený na Linux remote) |
| Claude Code managed settings | `C:\Program Files\ClaudeCode\managed-settings.json` *nebo* `C:\ProgramData\ClaudeCode\managed-settings.json` | Admin-level policy. Nutné pro Teams/Enterprise `channelsEnabled: true`. Vyžaduje admin write práva. |

### Marketplace + allowlist alignment

Na Windows, kde se Teams policy enforcuje, **managed settings** `allowedChannelPlugins` musí obsahovat entry, který přesně odpovídá marketplace, ze kterého je plugin instalovaný. Pokud nainstaluješ z `claude-bridge` marketplace (public github), ale org allowlist má jen `oxyshop-plugins`, channels se neotevřou — i když oba referencují stejný plugin kód interně.

Pro dev/test setupy používající víc instalačních cest přidej **všechny** varianty do org allowlistu:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "oxyshop-plugins", "plugin": "claude-bridge" },
    { "marketplace": "claude-bridge", "plugin": "claude-bridge" }
  ]
}
```

### Restart příkaz

```powershell
# Ukonči Claude Code přes Ctrl+D, pak:
claude --channels plugin:claude-bridge@claude-bridge
```

Nahraď `@claude-bridge` tím, co ukazuje `claude plugin list` za `@`.

### Push polling (v0.5.5+)

Před v0.5.5 Windows-native Claude Code příjemci tichoušky padali na piggyback, protože chokidar default backend (`ReadDirectoryChangesW`) sporadicky míjí ADD events pro soubory přicházející atomickým temp+rename — zvlášť při aktivním antivirus. v0.5.5 vynutí `usePolling: true` na Windows s 200 ms intervalem.

Pokud vidíš push nefungovat na Windows a verze je `≤ 0.5.4`, updatuj na aktuální. Linux/macOS users nejsou ovlivněni.

### `--dangerously-load-development-channels` NENÍ policy bypass

Flag whitelistuje plugin's channel pro aktuální session, ale **nepřepíše org-level policy enforcement** na Teams účtech. Uvidíš channel registrovaný ve startup banneru Claude Code ("Channels (experimental) messages from … inject directly in this session") s paralelním warningem ("not on your org's approved channels list"), ale skutečné push doručení je stále tichoušky filtrováno. Zprávy přijdou jen přes piggyback.

Jediný reálný fix na Teams účtech je přidat plugin do managed `allowedChannelPlugins`.

### VS Code Extension chat taby

Extension chat tabs renderují vlastní UI a **aktuálně channels vůbec nepodporují**. Setting `claudeCode.claudeProcessWrapper`, který starší docs zmiňují, je v Extension v2.1.x+ tiše ignorovaný. Používej Extension chat tabs jako orchestrátora (piggyback doručení stačí pro aktivně-řídící stranu) a terminálově spuštěný Claude jako worker peery (kde push hraje roli).

## Katalog symptomů

Každý entry: error message nebo behavior → pravděpodobná příčina → fix.

### "plugin claude-bridge@<marketplace> not on your org's approved channels list"

**Příčina:** `--channels` arg referencuje marketplace/plugin kombinaci, která není v tvém org `allowedChannelPlugins`. Nejčastější na Teams/Enterprise účtech, když jsi nainstaloval plugin z marketplace, který admin ještě nepovolil.

**Fix:**
1. Ověř `claude plugin list` pro potvrzení, ze kterého marketplace je plugin. Část za `@` je marketplace name.
2. Požádej org admina, ať přidá `{ "marketplace": "<ten marketplace>", "plugin": "claude-bridge" }` do org `allowedChannelPlugins`.
3. Počkej minutu pro propagaci policy.
4. Restartuj Claude Code s odpovídajícím `--channels` flagem.

Pokud používáš dvě instalační cesty (např. github pro osobní + GitLab pro práci), admin musí vypsat **oba** entries.

### "plugin claude-bridge@<marketplace> · plugin not installed"

**Příčina:** `--channels plugin:claude-bridge@<X>` referencuje marketplace `<X>`, ale `claude plugin list` ukazuje plugin nainstalovaný pod jiným marketplace name. Channels arg nefall-backuje; očekává přesný match proti nainstalovanému pluginu.

**Fix:** match marketplace name v `--channels` k tomu, co reportuje `claude plugin list`. Příklad: pokud list ukazuje `claude-bridge@claude-bridge`, channels arg je `--channels plugin:claude-bridge@claude-bridge`, ne `@oxyshop-plugins`.

Stejný error vznikne, pokud plugin opravdu není nainstalovaný — ověř přes `claude plugin list`.

### Plugin install selže s "unsupported source type"

**Příčina:** `marketplace.json` deklaruje `source`, který Claude Code nezná. String-form `"source": "."` **není** podporovaný pro pluginy v rootu marketplace; jako stringy fungují jen subdirectory cesty typu `"./plugins/<name>"`. Pro root pluginy musí být source object jako `{ "source": "github", "repo": "<owner>/<repo>", "ref": "<tag>" }` (self-reference je OK).

**Fix:** pokud jsi maintainer marketplace, přepni na object source. Pokud jsi user, znamená to, že marketplace, který jsi zkusil přidat, je špatně nakonfigurovaný — nahlaš bug proti tomu marketplace nebo použij jinou distribuční cestu.

### Zprávy přicházejí jen při dalším tool callu příjemce (push tichoušky padá na piggyback)

To je nejzákeřnější symptom, protože startup banner Claude Code radostně reportuje channels jako "enabled", zatímco doručení tichoušky padá na piggyback. Víc možných příčin:

**a) Policy blokuje channels (Teams account, žádný managed allowlist match)**
- Banner ukazuje `Channels (experimental)` řádek A paralelní `not on your org's approved channels list` warning.
- Fix: viz "not on your org's approved channels list" výše.

**b) Windows watcher míjí FS events (v0.5.4 a starší)**
- Banner ukazuje channels enabled, žádné warningy, ale push pořád nedoručí inline.
- `~/.claude-bridge/inbox/<recipient-id>/pending/<msgid>.json` existuje hned po zápisu odesílatelem, ale příjemce nezareaguje, dokud sám neudělá tool call.
- Fix: upgrade na v0.5.5+, který vynucuje chokidar polling na Windows.

**c) Příjemce není spuštěný s `--channels`**
- Příjemce proces běží jako plain `claude` bez channels arg. Push je opt-in per process.
- Fix: restartuj příjemce Claude Code s `claude --channels plugin:claude-bridge@<marketplace>`.

**d) Příjemce proces je zastaralý (starý plugin kód v paměti)**
- Updatoval jsi plugin nedávno, ale příjemce už běžel před updatem. Starý in-memory kód nezná nové polling/OSC chování.
- Fix: plný Ctrl+D restart příjemce, pak start s `--channels`.

Pro rozlišení a/b/c/d zkontroluj příjemcův pending inbox během testu (viz [Diagnostická procedura](#diagnostická-procedura)).

### `identity_unresolvable` při bootu pluginu

**Příčina:** plugin MCP server startoval o zlomek sekundy dřív, než Claude Code dokončil zápis `~/.claude/sessions/<ppid>.json`, takže plugin nedokáže resolvovat svou identitu. Bug před v0.5.2.

**Fix:** upgrade na v0.5.2+, který retry-uje resolvování identity s exponential backoff až ~3 s. Jako okamžitý workaround na starší verzi: `/mcp reconnect` uvnitř Claude Code připojí MCP server znovu, do té doby je session soubor na místě.

### Dva peeři ve stejné složce mají stejné `name` ("marketing" atd.) a `peer_ask "<name>"` vrací `peer_not_found` nebo `ambiguous_peer`

**Dvě odlišné příčiny, které vypadají podobně:**

**a) Windows path encoding bug (před v0.5.3)**
- Symptom: `peer_list` ukazuje všechny peery ve stejné složce zhroucené do jednoho jména typu `marketing` s `source: "cwd-slug"`, i když jejich ai-tituly jsou různé.
- Příčina: pre-v0.5.3 `encodeProjectDir` ponechával mezery / tečky / non-ASCII znaky ve Windows cestách beze změny, zatímco Claude Code je všechny nahrazuje `-`. Constructed JSONL path neodpovídal tomu, co CC reálně zapsal, takže ai-title nešel přečíst → fallback na cwd-slug.
- Fix: upgrade na v0.5.3+.

**b) Cross-version prostředí (v0.5.2 peeři běží vedle v0.5.3+ peerů)**
- Symptom: většina peerů ukazuje korektní ai-title jména, ale pár starých peerů pořád ukazuje cwd-slug. `peer_ask` proti cwd-slug jménu vrátí `peer_not_found`, protože v0.5.3+ resolver očekává jiný formát jména.
- Fix: restartuj v0.5.2 peery (plný Ctrl+D + restart), aby přebrali v0.5.3+ encoding a refreshli vlastní status soubory s korektními ai-title-derived jmény.

### Peer není v `peer_list` vůbec

Odlišné od "objevil se a vypršel" případu. Peer se vůbec neukáže, i když víš, že jeho Claude Code běží.

**Dvě odlišné příčiny:**

**a) VS Code Extension lazy tab activation**

Extension chat taby aktivují své MCP servery až když user poprvé **klikne** na záložku. Než klikneš, plugin proces pro ten chat nezačal — peer doslova ještě nezačal heartbeating. Otevřeš dvě Extension taby vedle sebe a `peer_list` z jednoho ukáže jen sebe.

**Fix:** klikni na druhý tab jednou. Do ~5–10 s (jeden heartbeat cyklus) se objeví v `peer_list`. Pro multi-agent workflow, kde nechceš tuto latenci, dej přednost terminálově spuštěnému Claude jako workers (startují okamžitě při `claude` volání, žádná lazy aktivace).

**b) Heartbeat peera vypršel, než ses podíval**

Peer proces žije, ale jeho CC je idle déle než `ONLINE_THRESHOLD_MS = 30 s` a mtime souboru heartbeat je stale. `peer_list` filtruje cokoli staršího.

**Fix:** přiměj peer-a něco udělat — i jen no-op tool call. Heartbeat se obnovuje při každé plugin aktivitě. Pokud je peer reálně mrtvý, restartuj ho.

### `peer_ask "<name>"` vrací `peer_not_found`, ač `peer_list` právě ukázal toto jméno

**Příčina:** heartbeat-based discovery má `ONLINE_THRESHOLD_MS = 30s` cutoff. Mezi tím, co `peer_list` proběhl, a tím, co `peer_ask` proběhl, vypršely jmenovaným peerům heartbeats (příjemce zaonkud nebo jeho proces byl zabit).

V v0.5.4+ `peer_not_found` errors vrací `details.activePeers[]` — snapshot, který resolver reálně použil. Prozkoumej ho, ať vidíš, kdo je *aktuálně* online (může se lišit od toho, co ukázal dřívější `peer_list`).

**Fix:** adresuj přes `id` (UUID), které nezávisí na heartbeat-derived display name, NEBO znovu spusť `peer_list` pro fresh snapshot.

### Startup banner ukazuje dva duplicitní řádky `plugin:claude-bridge@<marketplace>`

```
✓ Channels (experimental) messages from plugin:claude-bridge@claude-bridge, plugin:claude-bridge@claude-bridge inject directly in this session
```

**Příčina:** předal jsi oba flagy `--dangerously-load-development-channels plugin:X` A `--channels plugin:X` se stejným pluginem. Oba flagy ho přijmou samostatně, takže se objeví dvakrát.

**Fix:** kosmetické, neškodné. Použij jeden nebo druhý; se správným allowlist potřebuješ jen `--channels`.

## Diagnostická procedura

Když push nefunguje, projdi tyhle kroky v pořadí:

### 1. Ověř verzi pluginu na všech peerech

```
peer_list
```

Pro každého peera (včetně sebe) zkontroluj `version`. Všichni peeři potřebují v0.5.5+ pro plnou Windows kompatibilitu. Pokud je nějaký na starší verzi, restartuj ho.

### 2. Ověř startup banner Claude Code

Když startuješ `claude --channels plugin:...`, banner by měl ukázat:

```
✓ Channels (experimental) messages from plugin:claude-bridge@... inject directly in this session
```

**Žádný** paralelní `not on your org's approved channels list` warning.

Pokud warning vidíš → viz "not on your org's approved channels list" výše.
Pokud channels řádek vůbec nevidíš → `--channels` flag se neparsuje; ověř launch command.

### 3. Trasuj zprávu přes filesystem

Při testu push sleduj pending inbox příjemce v reálném čase:

```bash
# Linux/macOS
watch -n 0.5 ls -la ~/.claude-bridge/inbox/<recipient-sessionId>/pending/
```

```powershell
# Windows PowerShell
while ($true) { Get-ChildItem $env:USERPROFILE\.claude-bridge\inbox\<recipient-sessionId>\pending\; Start-Sleep -Milliseconds 500; cls }
```

Pošli zprávu. Co pozoruješ, rozliší možné příčiny:

- **Soubor se v `pending/` vůbec neobjeví** → sender `peer_ask` selhal zapsat. Zkontroluj tool result u sendera; vzácné.
- **Soubor se v `pending/` objeví a zůstává tam indefinitely** → watcher příjemce nefiruje. Na Windows klasický chokidar miss (pre-v0.5.5). Upgrade a plný restart.
- **Soubor se objeví v `pending/`, příjemce ho okamžitě ukáže inline jako `<channel>` tag, pak přesun do `done/`** → push funguje jak má.
- **Soubor se objeví v `pending/`, příjemce NEukáže inline tag, později přesun do `done/`, když příjemce udělá jakýkoli tool call** → push selhal (policy block nebo watcher miss), piggyback to dohonil.

### 4. Porovnej, co `peer_list` ukazuje vs co error reportuje

V v0.5.4+ `peer_ask` a `peer_chat_read` `peer_not_found` errors zahrnují `details.activePeers` — snapshot, kdo je reálně online z pohledu resolveru. Porovnej s dřívějším `peer_list`, ať vidíš, jestli peeři vypršeli mezi voláními.

### 5. Ověř policy mimo Claude Code

Zkontroluj, že user-level settings existují tam, kde si myslíš:

```bash
# Linux/macOS
cat ~/.claude/settings.json | grep -E "channelsEnabled|allowedChannelPlugins"

# Windows
type $env:USERPROFILE\.claude\settings.json | Select-String "channelsEnabled","allowedChannelPlugins"
```

Pokud jsi na Teams/Enterprise účtu, taky zkontroluj, jestli managed settings existují lokálně:

```bash
# Linux managed
ls /etc/claude-code/managed-settings.json 2>/dev/null && cat /etc/claude-code/managed-settings.json

# Windows managed (cesty se liší; admin může použít kteroukoli)
dir "$env:PROGRAMDATA\ClaudeCode\managed-settings.json" 2>$null
dir "$env:ProgramFiles\ClaudeCode\managed-settings.json" 2>$null
```

Pokud managed settings existují a neobsahují tvůj plugin v `allowedChannelPlugins`, je to důvod, proč user-level opt-in nefunguje.

## Viz také

- [INSTALL.md](INSTALL.md) — počáteční channels setup (tento troubleshooting doc ho doplňuje)
- [USAGE.md — Doporučená topologie](USAGE.md#doporučená-topologie-extension-jako-orchestrátor-terminály-jako-workers) — Extension jako orchestrátor, terminály jako workers
- [Issue #21409 v anthropics/claude-code](https://github.com/anthropics/claude-code/issues/21409) — closed feature request, který vysvětluje, proč claude-bridge dělá některé věci, které Claude Code nedělá
- [Issue #18326 v anthropics/claude-code](https://github.com/anthropics/claude-code/issues/18326) — související closed request pro session-name → terminal-title propagaci

# Instalace a konfigurace

Tento dokument popisuje, jak `claude-bridge` přidat do Claude Code a jak ho rozjet tak, aby fungoval podle tvých potřeb. Plugin pracuje stejně dobře z terminálu (`claude` CLI) i z VS Code extension — některé vlastnosti se ale liší, viz [CLI vs VS Code Extension](#cli-vs-vs-code-extension) dál.

## Předpoklady

Plugin běží uvnitř Claude Code, takže ho nejdřív musíš mít nainstalovaný:

- **Operační systém:** Linux, macOS, Windows. Plugin sám je cross-platform (path handling, atomic write retry pro Windows AV).
- **Node.js** ≥ 18 (instalován samostatně, plugin si ho pak zavolá při buildu).
- **Claude Code** verze 2.1.x nebo novější (CLI nebo VS Code extension).

Plugin si při instalaci sám stáhne a sestaví TypeScript MCP server — nemusíš nic kompilovat ručně.

## Instalace přes marketplace

V Claude Code spusť:

```
/plugin marketplace add github.com/michalekz/claude-bridge
/plugin install claude-bridge
```

První příkaz přidá oXyShop marketplace (jednou za stroj), druhý nainstaluje plugin. Build proběhne automaticky.

Po instalaci je potřeba restart Claude Code procesu:

- **CLI:** ukončit (Ctrl+D) a spustit znovu.
- **VS Code:** Ctrl+Shift+P → "Developer: Reload Window".

Verzi po reloadu ověříš nástrojem `peer_list` — vlastní chat by měl být v seznamu jako "self" s aktuální verzí.

## Real-time push — proč a jak

Plugin má dva komunikační režimy. Je dobré rozumět rozdílu, protože konfigurace pro reaktivní workflow vyžaduje admin zásah.

### Piggyback fallback (vždy zapnut, žádná konfigurace)

Zpráva se zapíše do filesystem inboxu cílového chatu. Cílový chat ji uvidí ve chvíli, kdy zavolá svůj příští MCP tool — buď proto, že mu uživatel zadal nový prompt, nebo proto, že si sám něco volá. **Latence** je tedy "tak dlouho, jak dlouho cílový chat spí". Pro orchestrační workflow často stačí, doručení je 100% spolehlivé.

### Push channel (vyžaduje admin enable)

Pokud zapneš MCP channel feature, zpráva se cílovému chatu doručí **okamžitě** přes notifikaci. Reaktivní workflow ("agent A se ptá, agent B okamžitě odpovídá") díky tomu funguje plynule.

**Důležité — channels mají dva nezávislé gaty:**

1. **`channelsEnabled: true`** — globální permission "tato org může vůbec používat channels".
2. **`allowedChannelPlugins[]`** — per-plugin allowlist "tenhle konkrétní channel je povolený".

> **Pokud `channelsEnabled: true`, ale plugin chybí v allowlistu**, channels pro org sice fungují (jiné pluginy v allowlistu mohou push), ale **náš plugin tiše selže** — protože není v allowlistu, jeho push se dropne stejně jako kdyby channels byly globálně off.
>
> Potřebuješ **obě konfigurace pohromadě**.

### Jak zapnout channels

Dvě cesty podle toho, jestli jsi org admin nebo jednotlivý vývojář. Obě produkují stejný efekt — pod nimi je identický setting.

#### Varianta A — jednotlivý vývojář (user-level)

Zapiš přímo do `~/.claude/settings.json` na stroji, kde běží `claude`:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "oxyshop-plugins", "plugin": "claude-bridge" }
  ]
}
```

Restartuj Claude Code (nebo `/mcp reconnect` v aktivních sessions) a `--channels plugin:claude-bridge@oxyshop-plugins` bude fungovat bez `--dangerously-load-development-channels` flagu.

> **VS Code Remote upozornění:** soubor patří na **stroj, kde reálně běží `claude`**. Pokud používáš Remote-SSH nebo podobně, to je remote — tedy setting jde do remote `~/.claude/settings.json`, ne lokálního.

#### Varianta B — organizace (managed settings)

V *claude.ai → Admin settings → Claude Code → Channels*:

1. Zapnout `channelsEnabled: true`.
2. Do `allowedChannelPlugins` přidat:
   ```json
   { "marketplace": "oxyshop-plugins", "plugin": "claude-bridge" }
   ```

Pozor: `allowedChannelPlugins` **nahrazuje** Anthropic default seznam. Pokud váš tým používá Telegram/Discord/iMessage channels, musí být v seznamu explicitně:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-plugins-official", "plugin": "telegram" },
    { "marketplace": "claude-plugins-official", "plugin": "discord" },
    { "marketplace": "claude-plugins-official", "plugin": "imessage" },
    { "marketplace": "oxyshop-plugins", "plugin": "claude-bridge" }
  ]
}
```

### Spuštění Claude Code s channels

Po správně nastavených managed settings stačí `--channels` flag:

```bash
claude --channels plugin:claude-bridge@oxyshop-plugins
```

Pro trvalé zapnutí přes alias nebo VS Code terminal profile — viz [cross-platform sekce](#cross-platform--alias-a-vs-code-terminal-profile).

### Co když admin channels nezapne

Plugin funguje dál — jen v piggyback režimu. Zprávy doručí, jen s latencí danou aktivitou cílového chatu. Pro single-user nebo občasné dotazy úplně dostatečné.

**Bez admin akce nelze channels obejít** — `--dangerously-load-development-channels` flag je blokovaný org policy stejně jako `--channels`. Pokud potřebuješ real-time push a admin se nepohne, jediná alternativa je zatím počkat.

## CLI vs VS Code Extension

Plugin funguje v obou prostředích, ale ergonomie a některé vlastnosti se liší.

| Aspekt | Terminál (`claude` CLI) | VS Code Extension |
|---|---|---|
| Peer visibility po startu | okamžitě | po prvním kliknutí na záložku + ~5 s (lazy tab activation) |
| Update cycle | Ctrl+D + `claude` | Reload window |
| Boot errors viditelné na stderr | ano (přímo v terminálu) | jen v Extension Dev Console |
| Side-by-side workflow | tmux / screen / víc terminálových oken | nativní VS Code taby |
| Channels real-time | funguje (s allowlist) | funguje (s allowlist) |
| Identity (ai-title) | dorazí standardně | dorazí standardně |
| Editor integration | žádná | tight (Edit tool otevře soubor v editoru) |
| Doporučeno pro | multi-chat orchestraci, skripty | běžnou single-chat práci s kódem |

**Praktické důsledky:**

- Pro **multi-chat orchestraci** (manažující chat A koordinuje pracovní chaty B/C) je terminál + tmux výrazně rychlejší — žádná lazy tab activation, žádné čekání na heartbeat, rychlejší restart cycle.
- Pro **běžnou single-chat práci s kódem** zůstává VS Code Extension lepší — Edit tool, file picker, diff viewer.
- Možná **zlatá střední cesta:** VS Code pro editaci souborů, `claude` v VS Code integrated terminálu (Ctrl+`) pro chat. Editor integration zůstává, chat má rychlý restart cyklus.

## Cross-platform — alias a VS Code terminal profile

Trvalé zapnutí `--channels` flagu se dělá podle operačního systému. Příklady níže předpokládají, že admin už channels povolil (viz výše).

### Linux / macOS — shell alias

Do `~/.bashrc` nebo `~/.zshrc`:

```bash
alias claude='claude --channels plugin:claude-bridge@oxyshop-plugins'
```

Po `source ~/.bashrc` (nebo nové terminál session) každé `claude` spouští s channelem.

### Windows — PowerShell profile

Do `$PROFILE` (zjistíš cestou `echo $PROFILE` v PowerShellu, typicky `Documents\PowerShell\Microsoft.PowerShell_profile.ps1`):

```powershell
function claude { & claude.exe --channels plugin:claude-bridge@oxyshop-plugins $args }
```

PowerShell restartni nebo `. $PROFILE`.

### VS Code terminal profile (všechny OS)

Přidá položku `Claude (channels)` do dropdownu vedle `+` v integrated terminálu. Stačí kliknout → Claude se spustí s zapnutým channelem.

> **VS Code Remote upozornění — přečti jako první:** pro Remote-SSH (a podobné remote dev setupy) terminal profile config patří do **client settings.json** na lokálním notebooku — **ne** do `~/.vscode-server/data/User/settings.json` na remote. UI dropdown profilů kreslí desktop client a settings čte ze své strany. Auto-detekované shelly v dropdownu sice přicházejí z remote přes remote agenta, takže to vypadá, že VS Code settings čte ze serveru — ale profil entries jdou ze strany klienta. Cesty ke klient settings:
>
> - **Linux klient:** `~/.config/Code/User/settings.json`
> - **macOS klient:** `~/Library/Application Support/Code/User/settings.json`
> - **Windows klient:** `%APPDATA%\Code\User\settings.json`
>
> Klíč `terminal.integrated.profiles.<os>` je vázaný na **OS, kde běží terminál** (= remote OS), ne na klient OS. Při remote-Linux z Windows notebooku tedy editujeme `profiles.linux` v `%APPDATA%\Code\User\settings.json`.

Do příslušného `settings.json` (klient strana) přidej blok podle OS, kde reálně budeš spouštět terminály:

**Linux (terminál běží na Linuxu):**

```json
{
  "terminal.integrated.profiles.linux": {
    "Claude (channels)": {
      "path": "bash",
      "args": ["-l", "-c", "exec claude --channels plugin:claude-bridge@oxyshop-plugins"],
      "overrideName": true,
      "icon": "comment-discussion"
    }
  }
}
```

**macOS (terminál běží na macOS):**

```json
{
  "terminal.integrated.profiles.osx": {
    "Claude (channels)": {
      "path": "zsh",
      "args": ["-l", "-c", "exec claude --channels plugin:claude-bridge@oxyshop-plugins"],
      "overrideName": true,
      "icon": "comment-discussion"
    }
  }
}
```

**Windows (terminál běží na Windows):**

```json
{
  "terminal.integrated.profiles.windows": {
    "Claude (channels)": {
      "path": "pwsh.exe",
      "args": ["-NoLogo", "-Command", "claude --channels plugin:claude-bridge@oxyshop-plugins"],
      "overrideName": true,
      "icon": "comment-discussion"
    }
  }
}
```

Reload window (Ctrl+Shift+P → *Developer: Reload Window*) a položka se objeví v `+` dropdownu v terminal panelu.

Drobnosti k zapamatování:

- **Žádný `defaultProfile`** — položka je *přídavná* volba, ne default. Vybírá se explicitně, když je potřeba; běžný `bash` (nebo tvůj obvyklý default) zůstává nedotčený.
- **`exec claude …`** — Claude nahradí shell proces, takže Ctrl+D zavře terminál čistě bez prázdného shellu navrch.
- **`-l` (login shell)** — načte `~/.bashrc` / `~/.zshrc`, takže úpravy PATH (nvm, asdf, vlastní `~/.local/bin`) se aplikují.
- **`overrideName`** — bez něj by terminál nesl titulek "bash" / "pwsh" místo "Claude (channels)".

### VS Code task — auto-start worker při otevření projektu

Pokud chceš worker terminál připravený ihned po otevření projektu — bez kliknutí v dropdownu, bez psaní — použij VS Code task s `runOn: folderOpen`.

Přidej do `.vscode/tasks.json` v projektu (případně do user-level `~/.vscode/tasks.json`, pokud to nechceš commitnout):

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Claude Code: claude-bridge worker",
      "type": "shell",
      "command": "claude --channels plugin:claude-bridge@oxyshop-plugins",
      "isBackground": true,
      "problemMatcher": [],
      "runOptions": { "runOn": "folderOpen" },
      "presentation": {
        "reveal": "always",
        "focus": false,
        "panel": "dedicated",
        "clear": false
      }
    }
  ]
}
```

Při prvním otevření složky se VS Code zeptá na povolení automatických tasků. Povolení odsouhlas a task pak nastartuje při každém dalším otevření.

Trade-offy proti manuálnímu terminal profilu výše:

- **Auto-start vs. on-demand** — task startuje pokaždé, profil startuje až po kliknutí. Vyber podle toho, jestli chceš worker připravený defaultně.
- **Workspace vs. system** — `.vscode/tasks.json` platí per-projekt (a jde do gitu, pokud ho commitneš); profil v `settings.json` platí napříč všemi tvými VS Code okny.
- **Vždycky terminálový Claude** — obě varianty spouští Claude v terminálu. Ani jedna nepomáhá Extension chat tabu (kde aktuálně channels zapnout nelze — viz níže).

### VS Code Extension chat taby

Extension kreslí Claude Code chat taby přímo v VS Code (ne terminály). Aktuálně Extension **neumí zapnout channels** pro tyto taby — flag se nepředává, a setting `claudeCode.claudeProcessWrapper` je v aktuálním buildu Extension tiše ignorovaný.

V praxi to znamená, že Extension chat taby běží v **piggyback režimu** (zprávy se drainují s každým tool callem), zatímco terminálově spuštěný Claude umí běžet s **real-time push**. Přirozené rozdělení rolí:

- **Extension jako orchestrátor** — řídí multi-chat workflow, posílá `peer_ask`, čte odpovědi přes piggyback při svém příštím tool callu. Push nepotřebuje, protože je aktivně řídící strana.
- **Terminály jako workers** — čekají na zprávy od orchestrátora. Push **potřebují**, aby se okamžitě probudily, když přijde úkol.

Viz [USAGE — Doporučená topologie](USAGE.md#doporučená-topologie-extension-jako-orchestrátor-terminály-jako-workers) pro detail.

## Kde jsou data pluginu

Plugin si drží stav v samostatném adresáři, nikdy nezapisuje do Claude Code interních dat:

```
~/.claude-bridge/
├── inbox/<sessionId>/
│   ├── pending/<msg-id>.json   — nedoručené zprávy
│   └── done/<msg-id>.json      — archiv konzumovaných
└── status/<sessionId>.json     — heartbeat (1 soubor / chat, refresh každých 5 s)
```

Read-only přístup k `~/.claude/projects/` a `~/.claude/sessions/`. Plugin nikdy nemodifikuje session JSONL ani jiný stav Claude Code.

## Časté problémy a řešení

### "peer_list mi nic nevrací, nebo vidím jen sebe"

Tři možné příčiny v pořadí pravděpodobnosti:

1. **Druhý chat ještě nebyl aktivován** (jen VS Code Extension). Klikni na druhý tab, počkej 5–10 s, zkus znovu. Terminálové chaty tento problém nemají.
2. **Druhý chat běží jinde, než si myslíš.** Zkontroluj `cwd` ve výsledku `peer_list` — všichni peeři musí mít vidět stejný `~/.claude-bridge/` (tj. běžet jako stejný uživatel, na stejném stroji).
3. **Plugin neběží.** V druhém chatu zkus `peer_list` — pokud vrátí chybu o neznámém nástroji, plugin se tam neinstaloval. Reinstaluj přes `/plugin install claude-bridge`.

### "Posílám zprávu, ale druhý chat nereaguje hned"

Pokud nemáš zapnuté channels (viz výše), je to očekávané — zpráva čeká v inboxu a doručí se při příštím tool callu cílového chatu. Pro okamžité doručení potřebuješ admin enable.

Verifikace, že zpráva dorazila do inboxu:

```bash
ls ~/.claude-bridge/inbox/<sessionId-cílového-chatu>/pending/
```

Pokud tam JSON soubory jsou, doručení funguje — jen je cílový chat zatím nepřečetl.

### "--channels blocked by org policy"

Tvůj org má `channelsEnabled: false` v managed settings. Admin musí flipnout. Bez admin akce ani `--dangerously-load-development-channels` flag neprojde. Plugin pokračuje v piggyback fallback režimu (bez push).

### "identity_unresolvable při startu, plugin hlásí failed"

Známý race condition (před v0.5.2): MCP server pluginu startuje o zlomek sekundy rychleji, než Claude Code zapíše `~/.claude/sessions/<ppid>.json`, takže plugin neumí rozpoznat svoji identitu a spadne.

Workaround: `/mcp reconnect` v Claude Code. Session soubor je už na místě a identita se rozresolvuje čistě.

Fix je naplánovaný do v0.5.2 (retry s exponential backoff + fallback na `cwd-slug`).

### "Po update pluginu se nic nezměnilo"

Po `/plugin update` je potřeba restart Claude Code procesu:

- **CLI:** Ctrl+D + `claude` znovu.
- **VS Code:** Ctrl+Shift+P → "Developer: Reload Window". V některých případech nestačí, je potřeba reload celého VS Code.

Ověření verze přes `peer_list` → `self.version`.

### "Dva chaty se stejným jménem (ambiguous_peer)"

Pokud máš dva chaty se stejným ai-titlem (např. dva "Explore X" v různých projektech), `peer_ask { to: "Explore X" }` vrátí `ambiguous_peer` error s výčtem konkrétních `id`. V takovém případě posílej **by id** (UUID), které je vždy jedinečné.

### "peer_chat_search vrátil scope_too_large"

Filtrovaný scope (po `maxAgeDays: 30`) přesahuje 200 MB. Důvody:

- Máš hodně velkých sessions (s tool_result obsahy) v jednom projektu.
- Spustil jsi `scope: 'all-projects'` na notebooku s desítkami projektů.

Workaround: použij specifičtější `query`, nebo zužuj scope (přejdi z `all-projects` na `project`). Pro reálné nasazení s velkým historickým archivem se připravuje FTS5 backend ve verzi v0.5+.

## Co dál

- **[Podrobný návod k použití](USAGE.md)** — všechny nástroje, argumenty, vzory pro typické workflows.
- **[Hlavní README](../../README.cs.md)** — krátké shrnutí toho, co plugin dělá a komu se hodí.

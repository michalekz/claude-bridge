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

### Jak zapnout channels (admin akce v claude.ai)

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

Do `settings.json`:

**Linux:**

```json
{
  "terminal.integrated.profiles.linux": {
    "claude-bridge": {
      "path": "bash",
      "args": ["-c", "claude --channels plugin:claude-bridge@oxyshop-plugins; exec bash"]
    }
  },
  "terminal.integrated.defaultProfile.linux": "claude-bridge"
}
```

**macOS:**

```json
{
  "terminal.integrated.profiles.osx": {
    "claude-bridge": {
      "path": "zsh",
      "args": ["-c", "claude --channels plugin:claude-bridge@oxyshop-plugins; exec zsh"]
    }
  },
  "terminal.integrated.defaultProfile.osx": "claude-bridge"
}
```

**Windows:**

```json
{
  "terminal.integrated.profiles.windows": {
    "claude-bridge": {
      "path": "pwsh.exe",
      "args": ["-NoExit", "-Command", "claude --channels plugin:claude-bridge@oxyshop-plugins"]
    }
  },
  "terminal.integrated.defaultProfile.windows": "claude-bridge"
}
```

Ctrl+` pak otevře terminál se zapnutým channelem.

### Pro VS Code Extension samotnou (ne terminal v ní)

Extension neumí předat `--channels` flag přes settings.json (zatím — viz claude-fa.st). Pokud chceš VS Code chat tab s channelem, musíš použít `claudeCode.claudeProcessWrapper` setting na wrapper skript, který flag doplní. Detail najdeš v `docs/audit/` nebo v issue trackeru — je to fragile a doporučujeme spíš použít terminálovou cestu.

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

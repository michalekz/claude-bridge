# Aktivace živých dat — funkce v0.9.0+

`peer_context_status` a `rate_limit_status` v Verzi 0.9.0+ jsou **live-data-only**. Všechny heuristiky z předchozích verzí (canonical model lookup, detekce `[1m]` tagu, čtení „fossil" `.usage_cache.json`) byly odstraněny. Bez nastavení oba nástroje vrací `hasLiveData: false` s odkazem na tento dokument.

Setup jsou **dva bloky** do `~/.claude/settings.json`:

1. **statusLine wrapper** — zachytává per-render stdin JSON z Claude Code (rate_limits + context_window + effort + model).
2. **PostToolUse hook** — volá Anthropic OAuth endpoint `/api/oauth/usage` jako sekundární zdroj rate limits (omezeno na ~1/min).

Můžeš aktivovat jeden nebo oba. Oba dohromady = plné pokrytí.

## Rychlá cesta (doporučeno)

Plugin obsahuje **SessionStart hook** (`setup-check.cjs`), který:

- Aktualizuje symbolické odkazy na stabilních cestách `~/.claude/claude-bridge-statusline.cjs` a `~/.claude/claude-bridge-refresh-limits.cjs` — ukazují na aktuální cache adresář.
- Automaticky generuje `~/.claude/claude-bridge-statusline-wrapper.sh`, který zachová jakoukoli již existující statusLine (např. [benabraham/claude-code-status-line](https://github.com/benabraham/claude-code-status-line)) přes subprocess passthrough.
- Vypíše na stderr banner při každém startu session, pokud setup není kompletní — s copy-paste JSON úryvky pro chybějící části.

Pro aktivaci SessionStart hooku nemusíš nic dělat — je součástí bundled hooků pluginu (`.claude-plugin/hooks/hooks.json`). Jen instaluj / aktualizuj plugin a jednou restartuj Claude Code.

## Manuální konfigurace

Pokud raději nastavíš ručně, přidej tyto dva bloky do `~/.claude/settings.json`. Pokud už máš objekt `hooks`, **sloučit** pole PostToolUse — nepřepisovat.

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/claude-bridge-statusline-wrapper.sh"
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/claude-bridge-refresh-limits.cjs",
            "timeout": 6
          }
        ]
      }
    ]
  }
}
```

Restartuj Claude Code (nebo spusť `/plugin marketplace update claude-bridge@claude-bridge`, `/reload-plugins`, `/mcp reconnect` — viz sekci [Ověření](#ověření) pro kompletní kontrolu).

## Co dělá jednotlivá část

### statusLine wrapper

- Přečte stdin JSON z Claude Code.
- Atomicky zapíše do `~/.claude-bridge/live/statusline.json` (temp + rename).
- Pokud je nastavená env proměnná `CLAUDE_BRIDGE_UNDERLYING_STATUSLINE` (setup-check ji naplní automaticky z tvé původní konfigurace), spustí ten příkaz jako subprocess, přesměruje stdin, streamuje stdout zpět. Původní status line se renderuje stejně jako předtím.
- Bez underlying wrapper produkuje prázdný stdout — Claude Code zobrazí prázdnou status line, ale zachycení proběhne.

Wrapper je **transparentní** — nikdy neblokuje ani nezpožďuje rendering.

### PostToolUse `refresh-limits.cjs`

Po každém úspěšném tool callu:

1. Kontrola omezení — pokud předchozí refresh proběhl před méně než 60 s, končí.
2. Načte OAuth token z `~/.claude/.credentials.json` (Linux/Windows) nebo macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`).
3. Validuje sadu znaků tokenu (paranoidní — brání HTTP header injection z poškozeného credentials souboru).
4. Volá `curl https://api.anthropic.com/api/oauth/usage` přes subprocess s `--config` stdin — token nikdy neleaknee do `ps`.
5. Zapíše odpověď do `~/.claude-bridge/live/oauth-api.json` a označí throttle marker.

Odpověď OAuth API je **bohatší** než statusLine stdin: obsahuje `spend`, `extra_usage`, per-model kvóty, `limits[]` s per-model scope, experimental codenames.

## Ověření

Po nastavení restartuj Claude Code a zkontroluj:

```
peer_context_status
```

Očekávaný výstup:

```json
{
  "hasLiveData": true,
  "contextLimitSource": "statusline-stdin",
  "model": "Fable 5",
  "contextLimit": 1000000,
  "tokensUsed": 259000,
  "effortLevel": "high",
  "claudeCodeVersion": "2.1.201",
  "lastTurnAt": "2026-07-07T15:00:00Z"
}
```

Klíčové indikátory: `hasLiveData: true`, `contextLimitSource: "statusline-stdin"` (ne `no-live-data`).

```
rate_limit_status
```

Očekávaný výstup:

```json
{
  "hasLiveData": true,
  "source": "statusline-stdin",
  "staleness": "fresh",
  "capturedAgeSeconds": 12,
  "session": { "utilization": 0.6, "windowExpired": false, "hoursUntilReset": 2.6 },
  "week": { "utilization": 0.51, "windowExpired": false, "hoursUntilReset": 131.9 }
}
```

Klíčové indikátory: `source: "statusline-stdin"` (nebo `"oauth-api"` po prvním spuštění hooku), `staleness: "fresh"`, malá hodnota `capturedAgeSeconds`.

## Řešení problémů

Skill `claude-bridge-setup` (auto-load na triggery „setup live data", „hasLiveData false") obsahuje rozhodovací strom pro selhání.

Rychlé kontroly:

**Banner setupu se objevuje při každém startu session.**
`setup-check` porovnává tvé `settings.json.statusLine.command` a PostToolUse příkazy proti substringům `claude-bridge-statusline` / `claude-bridge-refresh-limits`. Použij cesty přes symlinky (viz výše). Absolutní cesta na cache adresář nebude rozpoznána.

**`hasLiveData: false` i po setupu.**
StatusLine musí alespoň jednou renderovat, aby zachycení proběhlo. Restartuj CC, pak pošli libovolný prompt.

**`rate_limit_status` ukazuje `source: "statusline-stdin"` ale bez `spend` / `perModelWeekly`.**
Bohatá pole má pouze OAuth API. Počkej ~1 minutu, aby se spustil PostToolUse hook, nebo vynuť tool call teď.

**OAuth cesta se nikdy nespustí (žádný `oauth-api.json`).**
- Zkontroluj `~/.claude/.credentials.json` s klíčem `claudeAiOauth.accessToken` (na macOS: `security find-generic-password -s "Claude Code-credentials" -w`).
- Otestuj, že tvůj počítač dosáhne na `https://api.anthropic.com` (firemní proxy může blokovat).

## Odinstalace

Obnov `~/.claude/settings.json` do stavu před setupem. Plugin si nechá state file `~/.claude-bridge/setup-state.json`, ale po odinstalaci pluginu (`/plugin uninstall`) nic nedělá — klidně smaž `rm -rf ~/.claude-bridge/`.

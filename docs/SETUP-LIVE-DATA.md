# Live data setup — activate v0.9.0+ features

`peer_context_status` and `rate_limit_status` in v0.9.0+ are **live-data-only**. All pre-v0.9.0 heuristics (canonical model lookup, `[1m]` tag detection, `.usage_cache.json` fossil read) were removed. Without setup, both tools return `hasLiveData: false` with a pointer to this document.

Setup is **two additions** to `~/.claude/settings.json`:

1. A **statusLine wrapper** — captures per-render stdin JSON from Claude Code (rate_limits + context_window + effort + model).
2. A **PostToolUse hook** — calls Anthropic's OAuth `/api/oauth/usage` endpoint as a secondary rate-limits source (throttled ~1/min).

You can activate one or both. Both together = full coverage.

## Fast path (recommended)

The plugin ships a **SessionStart hook** (`setup-check.cjs`) that:

- Refreshes stable symlinks at `~/.claude/claude-bridge-statusline.cjs` and `~/.claude/claude-bridge-refresh-limits.cjs` pointing at the current cache dir.
- Auto-generates `~/.claude/claude-bridge-statusline-wrapper.sh` that preserves any pre-existing statusLine command (like [benabraham/claude-code-status-line](https://github.com/benabraham/claude-code-status-line)) via subprocess passthrough.
- Prints a banner on stderr at every session start when setup is incomplete, with copy-paste snippets for the missing pieces.

You don't have to do anything special to enable the SessionStart hook — it's part of the plugin's bundled hooks (loaded from `.claude-plugin/hooks/hooks.json`). Just install / update the plugin and restart Claude Code once.

## Manual configuration

If you'd rather set it up by hand, add these two blocks to `~/.claude/settings.json`. If you already have a `hooks` object, **merge** the PostToolUse array — don't overwrite.

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

Then restart Claude Code (or run `/plugin marketplace update claude-bridge@claude-bridge`, `/reload-plugins`, `/mcp reconnect` — see the [Verification](#verification) section for a full check).

## What each piece does

### statusLine wrapper

Claude Code sends a JSON blob on stdin to whatever program is configured in `settings.json.statusLine.command`. The wrapper:

1. Reads that JSON, writes it to `~/.claude-bridge/live/statusline.json` with an atomic temp+rename.
2. If `CLAUDE_BRIDGE_UNDERLYING_STATUSLINE` env var is set (auto-populated by setup-check from your original config), spawns that command as a subprocess, pipes the JSON in, and streams its stdout back to Claude Code. Your existing status line renders exactly as before.
3. If no underlying is configured, produces no stdout — Claude Code shows an empty status line but the capture still happens.

This makes the wrapper **transparent** — it never blocks or delays rendering.

### PostToolUse `refresh-limits.cjs`

After each successful tool call, this hook:

1. Checks `~/.claude-bridge/live/last-oauth-refresh` mtime — if less than 60s ago, exits early (throttled).
2. Reads OAuth token from `~/.claude/.credentials.json` (Linux/Windows) or macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`).
3. Validates the token contains only safe HTTP-header characters (paranoid — prevents injection from a corrupted credentials file).
4. Calls `curl https://api.anthropic.com/api/oauth/usage` via subprocess with `--config` stdin so the token never appears in `ps` output.
5. Writes response to `~/.claude-bridge/live/oauth-api.json`, touches the throttle marker.

The OAuth API response is **richer** than the statusLine stdin: it includes `spend`, `extra_usage`, `perModelWeekly` breakdowns, structured `limits[]` with per-model scoping, and experimental codenames. StatusLine stdin only carries the basic session + week utilization.

## Verification

After setup, restart Claude Code and check:

```
peer_context_status
```

Expected output:

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

Key indicators: `hasLiveData: true`, `contextLimitSource: "statusline-stdin"` (not `no-live-data`).

```
rate_limit_status
```

Expected output:

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

Key indicators: `source: "statusline-stdin"` (or `"oauth-api"` after the hook fires), `staleness: "fresh"`, `capturedAgeSeconds` small.

## Troubleshooting

See the `claude-bridge-setup` skill (auto-loads on triggers like "setup live data", "hasLiveData false") for a decision tree of failure modes.

Quick checks:

**Setup banner appears at every session start.**
`setup-check` compares your `settings.json.statusLine.command` and PostToolUse commands against `claude-bridge-statusline` / `claude-bridge-refresh-limits` substrings. Use the symlink paths as documented above. If you use an absolute path to the cache dir, setup-check doesn't recognize it.

**`hasLiveData: false` after setup.**
StatusLine has to render at least once before the capture appears. Restart CC, then send any prompt to trigger a render.

**`rate_limit_status` shows `source: "statusline-stdin"` but no `spend`/`perModelWeekly`.**
Rich fields come from OAuth API only. Wait ~1 minute for the PostToolUse hook to fire between renders, or force a tool call now.

**OAuth path never fires (no `oauth-api.json`).**
- Verify `~/.claude/.credentials.json` exists with `claudeAiOauth.accessToken` (on macOS: `security find-generic-password -s "Claude Code-credentials" -w`).
- Test that your machine can reach `https://api.anthropic.com` (corporate proxies sometimes block this).

## Uninstalling

Restore your `~/.claude/settings.json` from before setup. The plugin will keep its state file at `~/.claude-bridge/setup-state.json`, but that doesn't hurt anything if the plugin is uninstalled — feel free to `rm -rf ~/.claude-bridge/` if you want a clean slate.

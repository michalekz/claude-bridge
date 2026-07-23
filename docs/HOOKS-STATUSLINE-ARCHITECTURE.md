# Hooks + statusLine architecture (v0.9.0+)

Technical explainer of the v0.9.0 live-data pipeline. See [SETUP-LIVE-DATA.md](SETUP-LIVE-DATA.md) for how to configure it; this document is about **how** it works and **why** each piece is where it is.

## Overview

```
                      ┌────────────────────┐
                      │   Claude Code CLI  │
                      └──────────┬─────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     statusLine render     PostToolUse fires    MCP tool call
        (per turn)         (per tool call)      (agent request)
              │                  │                  │
              ▼                  ▼                  ▼
      claude-bridge-       claude-bridge-        MCP server
      statusline.cjs       refresh-limits.cjs   (bundle.cjs)
              │                  │                  │
      ┌───────┴─────────┐        │                  │
      │                 │        │                  │
      ▼                 ▼        ▼                  ▼
  user's original    write   throttled OAuth    reads live/*.json
  statusLine        live/    curl → live/       returns to agent
  (passthrough)     status   oauth-api.json
                    line.
                    json
```

Three actors write / read `~/.claude-bridge/live/`:

- `statusline.cjs` (per-turn) writes `statusline.json`
- `refresh-limits.cjs` (per-tool-call, throttled) writes `oauth-api.json`
- MCP server bundle (per agent request) reads both

## Why two sources?

Claude Code 2.1.80+ sends `rate_limits` and `context_window` on stdin to statusLine hooks. This is the primary, most-current source — data arrives every render (typically once per user turn). But:

- StatusLine stdin only includes basic fields: session + week utilization.
- No `spend`, `extra_usage`, per-model quotas, experimental codenames.
- StatusLine renders can be delayed (long-running turn without a fresh stdin push).

The OAuth API path fills those gaps: full response body with rich fields, more predictable cadence (throttled to ~1/min per PostToolUse). It's the same endpoint the Anthropic dashboard uses.

When both are present in `live/`, `readLiveRateLimits` returns whichever envelope has the newer `capturedAt` — the freshest data wins.

## Component: statusLine wrapper

Source: `src/statusline/main.ts` (bundled to `dist/statusline.cjs`).

### Invocation

The wrapper runs as CC's `settings.json.statusLine.command`. CC sends stdin JSON like:

```json
{
  "cwd": "/opt/claude-bridge",
  "version": "2.1.201",
  "model": { "display_name": "Fable 5" },
  "effort": { "level": "high" },
  "context_window": {
    "context_window_size": 1000000,
    "used_percentage": 25.9,
    "current_usage": {
      "input_tokens": 3500,
      "output_tokens": 500,
      "cache_read_input_tokens": 200000,
      "cache_creation_input_tokens": 55000
    }
  },
  "rate_limits": {
    "five_hour": { "used_percentage": 42, "resets_at": 1783200000 },
    "seven_day": { "used_percentage": 18, "resets_at": 1783600000 }
  }
}
```

### Flow

1. Read all of stdin (blocking).
2. Parse JSON. On parse failure, log warning, continue — never fail.
3. Extract sessionId from `CLAUDE_CODE_SESSION_ID` env var (CC exposes this to hook children; falls back to cwd-derived hash).
4. Wrap payload in `{capturedAt, sessionId, payload}` envelope, atomic-write to `~/.claude-bridge/live/statusline.json` (temp file + rename to avoid partial reads).
5. If `CLAUDE_BRIDGE_UNDERLYING_STATUSLINE` env var is set, spawn the underlying command via `/bin/sh -c` (or `cmd.exe /d /s /c` on Windows), pipe our original stdin into it, stream its stdout to our stdout. Exit with underlying's exit code.
6. If no underlying, produce no stdout — CC renders an empty status line, but the capture happened.

### Failure modes

All handled — the wrapper NEVER crashes CC's rendering:

- Malformed stdin JSON → log to stderr, still passthrough raw bytes to underlying.
- `writeStatusLineLive` fails (disk full) → log, continue with passthrough.
- Underlying spawn fails → log, exit 0.
- Underlying non-zero exit → propagated as our exit code, but wrapper itself doesn't crash.

## Component: PostToolUse `refresh-limits`

Source: `src/refresh-limits/main.ts` (bundled to `dist/refresh-limits.cjs`).

### Invocation

CC calls this after every successful tool use when configured under `hooks.PostToolUse[*].hooks[*].command`. CC pipes a JSON payload on stdin (`{session_id, tool_name, tool_input, tool_response}`), which we drain and discard — the hook fires on time, not on payload contents.

### Flow

1. Throttle check: read `~/.claude-bridge/live/last-oauth-refresh` mtime. If < 60s ago, exit 0. This is the primary rate limiter — protects against burning through the actual rate limit on tool-heavy turns.
2. Read OAuth access token:
   - **darwin**: `security find-generic-password -s "Claude Code-credentials" -w`. If succeeds, parse JSON output, take `claudeAiOauth.accessToken`.
   - **any platform**: fallback to `~/.claude/.credentials.json` (permissions 600, plain JSON with same key path).
3. Validate token character set: `^[a-zA-Z0-9\-._~+/=]+$`. Blocks HTTP header injection if the credentials file is corrupted.
4. Call `curl -s -f --config -` with token piped as stdin config file:
   ```
   header = "Authorization: Bearer <token>"
   ```
   This keeps the token out of `ps` (visible via command line) and out of `environ` (visible via /proc/<pid>/environ). Only in-process memory of curl.
5. Parse response body as JSON.
6. Wrap in `{capturedAt, data}` envelope, atomic-write to `~/.claude-bridge/live/oauth-api.json`.
7. Touch throttle marker — only on success. On failure, marker stays stale so the next tool call re-attempts.

### Why deprecated?

Per [benabraham/claude-code-status-line CHANGELOG](https://github.com/benabraham/claude-code-status-line/blob/main/CHANGELOG.md), the OAuth `/api/oauth/usage` endpoint is documented as deprecated in favor of stdin `rate_limits` (from CC 2.1.80). It's kept as a fallback path there and here.

If Anthropic retires the endpoint entirely, `readLiveRateLimits` falls back to statusLine-only. Nothing else breaks.

## Component: SessionStart `setup-check`

Source: `src/setup-check/main.ts` (bundled to `dist/setup-check.cjs`, activated via `.claude-plugin/hooks/hooks.json`).

### What it maintains

- **Symlinks** at stable paths under `~/.claude/`:
  - `claude-bridge-statusline.cjs → cache/<version>/dist/statusline.cjs`
  - `claude-bridge-refresh-limits.cjs → cache/<version>/dist/refresh-limits.cjs`
  
  Why symlinks: CC's `settings.json.statusLine.command` doesn't expand `${CLAUDE_PLUGIN_ROOT}` (only hook commands do). Absolute paths in settings.json would break every time the plugin cache dir changes on update. Symlinks give a stable path that setup-check updates on every SessionStart.

- **Wrapper shell script** at `~/.claude/claude-bridge-statusline-wrapper.sh`:
  ```sh
  #!/bin/sh
  export CLAUDE_BRIDGE_UNDERLYING_STATUSLINE="<detected original statusLine>"
  exec node "$HOME/.claude/claude-bridge-statusline.cjs"
  ```
  Why a script: `settings.json.statusLine` has no `env` field, so the wrapper needs a shell layer to set the env var. This is the closest thing to composability we get without upstream CC changes.

- **Setup state** at `~/.claude-bridge/setup-state.json`:
  ```json
  {
    "pluginVersion": "0.9.0",
    "lastBannerShownForVersion": "0.9.0",
    "originalStatusLine": "~/.claude/claude-code-status-line.py",
    "statusLineConfigured": true,
    "hookConfigured": true,
    "lastCheckedAt": "2026-07-07T15:00:00Z"
  }
  ```

### Original statusLine detection

On the **first** SessionStart after plugin install, the user's `settings.json.statusLine.command` still points at their original (say, benabraham's). Setup-check reads that value, saves it to `originalStatusLine` in state, and generates the wrapper with it as `CLAUDE_BRIDGE_UNDERLYING_STATUSLINE`.

On **subsequent** SessionStarts (after the user switches settings.json to point at our wrapper), the current command IS the wrapper — but the state file remembers the original.

Safety: if state is cleared (state file deleted) AND current command is our wrapper AND wrapper.sh already exists, setup-check does NOT overwrite the wrapper. It preserves whatever the user last had — either the auto-generated file or their manual edits.

### Banner logic

Print banner when EITHER:

- Setup is incomplete (missing statusLine wrapper OR PostToolUse hook), OR
- Plugin version changed since last banner (announces new features)

Skip banner when setup is complete AND version unchanged since last banner shown. State file's `lastBannerShownForVersion` prevents the "hello, version bump!" banner from re-firing on every session start after a single upgrade — only appears once per version transition.

## Data files

```
~/.claude-bridge/live/
├── statusline.json         # written by statusLine wrapper per render
├── oauth-api.json          # written by refresh-limits hook per throttle window
└── last-oauth-refresh      # empty file, mtime is throttle marker

~/.claude-bridge/
├── guard-rate-limits.json  # written by peer_set_rate_limit_guard tool
└── setup-state.json        # written by setup-check hook

~/.claude/
├── claude-bridge-statusline.cjs           # symlink → cache/<ver>/dist/statusline.cjs
├── claude-bridge-refresh-limits.cjs       # symlink → cache/<ver>/dist/refresh-limits.cjs
└── claude-bridge-statusline-wrapper.sh    # auto-generated shell wrapper
```

Nothing else on the **data / messaging** plane — the plugin's telemetry, inbox, registry and guard configs are entirely file-based, with no daemon, no shared memory, no network state.

> **Scope note (v0.10.0+)** — the "no daemon" rule above applies to the data/messaging plane only. **Process lifecycle** (spawn, stop, restart, compact watchdog) is a qualitatively different problem — processes need a supervisor that lives longer than they do, which CC hooks cannot provide. From v0.10.0 an opt-in **control plane daemon** (`servers/claude-bridge-daemon/`) handles that separately. Communication with the daemon is still file-based (`~/.claude-bridge/control/requests/`, `results/`, `events.jsonl`) — the file-based principle carries into the new component. See [ADR-008 in `architecture.md`](architecture.md#adr-008--control-plane-daemon-vedle-file-based-filozofie).

## Why not IPC / daemon / socket for the data plane?

We considered several patterns during the pre-implementation phase:

- **In-memory shared state via MCP** — MCP servers can hold state, but stdio transport is per-session, so state doesn't cross Claude Code chats. And we specifically want cross-chat visibility.
- **Unix socket + daemon** — would work, but adds a persistent process to manage, complicates uninstall, and doesn't survive session boundaries any better than file-based.
- **Pipes / FIFOs** — one-shot, no re-read, defeats the "check any time" access pattern.

The v0.10.0 control-plane daemon is intentionally scoped to lifecycle work and does not intrude on any of the above surfaces.

File-based, atomic-writes, POSIX-scoped is the simplest thing that works cross-session for user-scoped data (rate limits, context usage). Same design principle carries through the whole plugin (peer inbox, guard configs, notification settings).

## Known transient behavior — race window after reconnect

Between `/mcp reconnect` and the **first** statusLine render of the session, there's a race window (~1-3 seconds) during which `peer_context_status` may return `hasLiveData: false` for self even though the plugin is working correctly. Explanation:

1. `/mcp reconnect` spawns a fresh MCP server process. Its self identity has a new `sessionId`.
2. The statusLine wrapper (spawned separately by Claude Code per render) hasn't yet been triggered for this session's new lifecycle — no `live/statusline/<newSessionId>.json` exists.
3. The legacy fallback (`live/statusline.json`, from v0.9.0) still exists but its `sessionId` matches a **previous** session, so `readStatusLineLive(newSessionId)` correctly rejects it (no cross-session contamination).
4. Result: `hasLiveData: false` until the first statusLine render lands.

This is **not a bug** — it's the plugin correctly refusing to fabricate a number it doesn't have. `hasLiveData: false + setupPointer` is more useful than a stale/foreign capture.

**Observed empirically 2026-07-09** (jira-architect HMH setup): two `peer_context_status` calls fired in parallel within the same turn. The `to` omitted (self-only) call returned `hasLiveData: false`; the simultaneous `to: 'all'` call returned correct self data with `tokensUsed: 524286`. Difference: the all-scan path spends ~500ms enumerating active peers via the registry, giving the statusLine wrapper time to complete its atomic write. The self-only path checks disk immediately and finds nothing there yet.

### Recommended agent pattern for consumers

If `peer_context_status` (self) returns `hasLiveData: false` immediately after a `/mcp reconnect` or plugin update, treat it as transient:

```
1. First call → hasLiveData: false + setupPointer
2. Wait for the next natural tool call OR sleep ~3 seconds
3. Retry — should return live data
4. If still hasLiveData: false → invoke the claude-bridge-setup skill
   (setup is genuinely incomplete, not just transient)
```

Do not add unbounded retry loops — beyond 3 seconds, `hasLiveData: false` is authoritative and reflects real setup gaps.

## Related documents

- [SETUP-LIVE-DATA.md](SETUP-LIVE-DATA.md) — user-facing setup instructions.
- [../CHANGELOG.md](../CHANGELOG.md) — the v0.9.0 breaking-change entry documenting what was removed from v0.8.x.
- [../CREDITS.md](../CREDITS.md) — benabraham/claude-code-status-line reference (their static analysis informed the statusLine stdin schema we depend on).

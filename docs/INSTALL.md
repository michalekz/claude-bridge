# Installation and configuration

This document covers how to add `claude-bridge` to Claude Code and tune it to your setup. The plugin works equally well from the terminal (`claude` CLI) and from the VS Code extension — a few characteristics differ between them, see [CLI vs VS Code Extension](#cli-vs-vs-code-extension) below.

## Prerequisites

The plugin runs inside Claude Code, so you need that first:

- **Operating system:** Linux, macOS, Windows. The plugin itself is cross-platform (path handling, atomic write retry for Windows AV).
- **Node.js** ≥ 18 (installed separately; the plugin's build script calls it).
- **Claude Code** version 2.1.x or newer (CLI or VS Code extension).

The plugin downloads and builds its TypeScript MCP server on install — nothing to compile manually.

## Installation via marketplace

In Claude Code:

```
/plugin marketplace add github.com/michalekz/claude-bridge
/plugin install claude-bridge
```

The first command registers the marketplace (once per machine), the second installs the plugin. The build runs automatically.

After installation, restart the Claude Code process:

- **CLI:** exit (Ctrl+D) and start `claude` again.
- **VS Code:** Ctrl+Shift+P → "Developer: Reload Window".

Verify the install with `peer_list` — your own chat should appear as `self` with the current version.

## Real-time push — why and how

The plugin operates in one of two delivery modes. The difference matters.

### Piggyback fallback (always on, no configuration)

A message is written into the recipient's filesystem inbox. The recipient sees it the next time it calls any MCP tool — either because the user gave it a new prompt, or because it invoked something itself. **Latency** therefore equals "how long the target chat sleeps". Delivery is 100% reliable. For most orchestration workflows this is enough.

### Push channel (opt-in, requires admin action)

With MCP channels enabled, a message arrives **immediately** as a notification rendered inline in the target chat's context. Reactive workflows ("agent A asks, agent B replies right away") flow naturally.

**Important — channels have two independent gates:**

1. **`channelsEnabled: true`** — a global org-level permission "this organization may use channels at all".
2. **`allowedChannelPlugins[]`** — per-plugin allowlist "this specific plugin's channel is allowed".

> **If `channelsEnabled: true` is set but the plugin is missing from the allowlist**, channels work for the org (other allowlisted plugins can push) but **this plugin's channel silently fails** — its push gets dropped exactly as if channels were globally off.
>
> You need **both** configured together.

### Enabling channels (admin action in claude.ai)

In *claude.ai → Admin settings → Claude Code → Channels*:

1. Set `channelsEnabled: true`.
2. Add to `allowedChannelPlugins`:
   ```json
   { "marketplace": "claude-bridge", "plugin": "claude-bridge" }
   ```

Note: `allowedChannelPlugins` **replaces** the Anthropic default list. If your team uses Telegram/Discord/iMessage channels, list them explicitly:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-plugins-official", "plugin": "telegram" },
    { "marketplace": "claude-plugins-official", "plugin": "discord" },
    { "marketplace": "claude-plugins-official", "plugin": "imessage" },
    { "marketplace": "claude-bridge", "plugin": "claude-bridge" }
  ]
}
```

### Launching Claude Code with channels

With managed settings configured correctly, the `--channels` flag is enough:

```bash
claude --channels plugin:claude-bridge
```

For permanent enablement via alias or VS Code terminal profile, see [cross-platform setup](#cross-platform--alias-and-vs-code-terminal-profile).

### What if the admin doesn't enable channels

The plugin continues to work in piggyback mode. Messages are delivered with the latency of the target chat's activity. For single-user or occasional-query workflow this is perfectly sufficient.

**There's no way to bypass org policy** — `--dangerously-load-development-channels` is blocked by the same gate. If you need real-time push and your admin won't move, piggyback is your only option until they do.

## CLI vs VS Code Extension

The plugin works in both environments, but ergonomics differ.

| Aspect | Terminal (`claude` CLI) | VS Code Extension |
|---|---|---|
| Peer visibility after start | immediate | after first tab click + ~5 s (lazy tab activation) |
| Update cycle | Ctrl+D + `claude` | Reload window |
| Boot errors on stderr | yes (direct terminal output) | only in Extension Dev Console |
| Side-by-side workflow | tmux / screen / multiple terminal windows | native VS Code tabs |
| Channels real-time | works (with allowlist) | works (with allowlist) |
| Identity (ai-title) | arrives normally | arrives normally |
| Editor integration | none | tight (Edit tool opens file in editor) |
| Recommended for | multi-chat orchestration, scripting | day-to-day single-chat work with code |

**Practical implications:**

- For **multi-chat orchestration** (coordinator chat A managing worker chats B/C), terminal + tmux is noticeably faster — no lazy tab activation, no waiting for heartbeats, faster restart cycle.
- For **single-chat work with code**, VS Code Extension stays better — Edit tool, file picker, diff viewer.
- A possible **middle ground:** VS Code for file editing, `claude` in the VS Code integrated terminal (Ctrl+`) for chat. Editor integration is preserved while the chat has the fast restart cycle.

## Cross-platform — alias and VS Code terminal profile

Permanent enablement of `--channels` depends on the OS. Examples below assume the admin has already enabled channels.

### Linux / macOS — shell alias

In `~/.bashrc` or `~/.zshrc`:

```bash
alias claude='claude --channels plugin:claude-bridge'
```

After `source ~/.bashrc` (or new terminal session), every `claude` invocation runs with the channel.

### Windows — PowerShell profile

In `$PROFILE` (find the path via `echo $PROFILE` in PowerShell, typically `Documents\PowerShell\Microsoft.PowerShell_profile.ps1`):

```powershell
function claude { & claude.exe --channels plugin:claude-bridge $args }
```

Restart PowerShell or run `. $PROFILE`.

### VS Code terminal profile (all OSes)

In `settings.json`:

**Linux:**

```json
{
  "terminal.integrated.profiles.linux": {
    "claude-bridge": {
      "path": "bash",
      "args": ["-c", "claude --channels plugin:claude-bridge; exec bash"]
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
      "args": ["-c", "claude --channels plugin:claude-bridge; exec zsh"]
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
      "args": ["-NoExit", "-Command", "claude --channels plugin:claude-bridge"]
    }
  },
  "terminal.integrated.defaultProfile.windows": "claude-bridge"
}
```

Ctrl+` then opens a terminal with the channel pre-enabled.

### For the VS Code Extension itself (not the terminal inside it)

The extension can't pass `--channels` via settings.json (yet). If you want a VS Code chat tab to have the channel enabled, you need to use `claudeCode.claudeProcessWrapper` pointing at a wrapper script that injects the flag. This setup is fragile and we recommend using the terminal path instead.

## Where the plugin keeps its data

The plugin lives entirely in `~/.claude-bridge/` (its own namespace; never touches Claude Code internals):

```
~/.claude-bridge/
├── inbox/<sessionId>/
│   ├── pending/<msg-id>.json   ← incoming messages, not yet drained
│   └── done/<msg-id>.json      ← already consumed, available for peer_reply
└── status/<sessionId>.json     ← heartbeat (refreshed every 5 s)
```

Read-only access to `~/.claude/projects/` and `~/.claude/sessions/`. The plugin never modifies session JSONL files or any other Claude Code state.

## Common problems and fixes

### "peer_list returns nothing or only myself"

Three possible causes, in order of likelihood:

1. **The other chat hasn't been activated yet** (VS Code Extension only). Click the other tab, wait 5–10 s, try again. Terminal chats don't have this problem.
2. **The other chat is running somewhere unexpected.** Check `cwd` in `peer_list` output — every peer must see the same `~/.claude-bridge/` (i.e., same user, same machine).
3. **The plugin isn't running.** In the other chat, try `peer_list` — if it returns an unknown-tool error, the plugin wasn't installed there. Reinstall via `/plugin install claude-bridge`.

### "I sent a message, the other chat doesn't react immediately"

If you don't have channels enabled (see above), this is expected — the message waits in the inbox and is delivered on the target chat's next tool call. For immediate delivery you need admin enablement.

Verify the message reached the inbox:

```bash
ls ~/.claude-bridge/inbox/<target-sessionId>/pending/
```

If JSON files are there, delivery works — the target chat just hasn't read them yet.

### "--channels blocked by org policy"

Your organization has `channelsEnabled: false` in managed settings. The admin needs to flip it. Without admin action, even `--dangerously-load-development-channels` will not get through. The plugin continues to work in piggyback-fallback mode (without push).

### "After plugin update nothing changed"

After `/plugin update` you need to restart the Claude Code process:

- **CLI:** Ctrl+D + `claude` again.
- **VS Code:** Ctrl+Shift+P → "Developer: Reload Window". In some cases this isn't enough — restart all of VS Code to be safe.

Verify the version via `peer_list` → `self.version`.

### "Two chats with the same name (ambiguous_peer)"

If you have two chats with the same ai-title (e.g., two "Explore X" in different projects), `peer_ask { to: "Explore X" }` returns `ambiguous_peer` with the colliding `id`s listed. Send by **id** instead (UUID, always unique).

### "peer_chat_search returned scope_too_large"

The filtered scope (after `maxAgeDays: 30`) exceeded 200 MB. Reasons:

- You have many large sessions (with heavy tool_result content) in one project.
- You ran `scope: 'all-projects'` on a notebook with tens of projects.

Workaround: use a more specific `query`, or narrow scope (from `all-projects` to `project`). For real deployments with large historical archives, an FTS5 backend is planned for a future release.

## What's next

- **[Detailed usage guide](USAGE.md)** — every tool, arguments, workflow recipes.
- **[Main README](../README.md)** — short summary of what the plugin does and who it's for.

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

### Enabling channels

Two ways to enable, depending on whether you're an org admin or an individual developer. Both produce the same effect — the underlying setting is identical.

#### Option A — individual developer (user-level)

Write directly to `~/.claude/settings.json` on the machine where you run `claude`:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-bridge", "plugin": "claude-bridge" }
  ]
}
```

Restart Claude Code (or run `/mcp reconnect` in active sessions) and `--channels plugin:claude-bridge` will work without the `--dangerously-load-development-channels` flag.

> **VS Code Remote caveat:** the file goes on the **machine where `claude` actually runs**. If you use Remote-SSH or similar, that's the remote — so the setting goes into the remote-side `~/.claude/settings.json`, not on your local laptop.

#### Option B — organization (managed settings)

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

Adds a `Claude (channels)` entry to the `+` dropdown in the integrated terminal. Open it once → Claude starts with the channel ready.

> **VS Code Remote caveat — read this first:** for Remote-SSH (or any remote dev setup), the terminal profile config **must go in the client-side `settings.json`** on your local laptop — **not** in `~/.vscode-server/data/User/settings.json` on the remote. VS Code's profile dropdown UI is rendered by the desktop client and reads its settings from the client. The auto-detected shell list in the dropdown comes from the remote, which makes this counter-intuitive — but profile entries themselves are client-only. Client settings paths:
>
> - **Linux client:** `~/.config/Code/User/settings.json`
> - **macOS client:** `~/Library/Application Support/Code/User/settings.json`
> - **Windows client:** `%APPDATA%\Code\User\settings.json`
>
> The `terminal.integrated.profiles.<os>` key is keyed on the **OS where the terminal runs** (= remote OS), not the client OS. So when connected to a Linux remote from a Windows laptop, edit `profiles.linux` in `%APPDATA%\Code\User\settings.json`.

In the appropriate `settings.json` (client side), add the profile block(s) for the OS(es) where you'll actually run terminals:

**Linux (terminal runs on Linux):**

```json
{
  "terminal.integrated.profiles.linux": {
    "Claude (channels)": {
      "path": "bash",
      "args": ["-l", "-c", "exec claude --channels plugin:claude-bridge"],
      "overrideName": true,
      "icon": "comment-discussion"
    }
  }
}
```

**macOS (terminal runs on macOS):**

```json
{
  "terminal.integrated.profiles.osx": {
    "Claude (channels)": {
      "path": "zsh",
      "args": ["-l", "-c", "exec claude --channels plugin:claude-bridge"],
      "overrideName": true,
      "icon": "comment-discussion"
    }
  }
}
```

**Windows (terminal runs on Windows):**

```json
{
  "terminal.integrated.profiles.windows": {
    "Claude (channels)": {
      "path": "pwsh.exe",
      "args": ["-NoLogo", "-Command", "claude --channels plugin:claude-bridge"],
      "overrideName": true,
      "icon": "comment-discussion"
    }
  }
}
```

Reload window (Ctrl+Shift+P → *Developer: Reload Window*) and the entry appears in the `+` dropdown in the terminal panel.

A few details worth knowing:

- **No `defaultProfile`** — the entry is an additional option, not the default. You pick it explicitly when needed; ordinary `bash` (or your usual default) stays available.
- **`exec claude …`** — Claude replaces the shell process, so Ctrl+D closes the terminal cleanly with no leftover empty shell.
- **`-l` (login shell)** — sources `~/.bashrc` / `~/.zshrc`, so any PATH adjustments (nvm, asdf, custom `~/.local/bin`) are loaded.
- **`overrideName`** — without this, the terminal title would still read "bash" / "pwsh" instead of "Claude (channels)".

### VS Code task — auto-start worker on folder open

If you want a worker terminal to be ready as soon as you open the project — no dropdown click, no typing — use a VS Code task with `runOn: folderOpen`.

Add to `.vscode/tasks.json` in your project (or in your user-level `~/.vscode/tasks.json` if you don't want to commit it):

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Claude Code: claude-bridge worker",
      "type": "shell",
      "command": "claude --channels plugin:claude-bridge",
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

The first time you open the folder, VS Code asks for permission to run automatic tasks. Allow it and the task fires on every subsequent folder open.

Trade-offs compared to the manual terminal profile above:

- **Auto-start vs. on-demand** — task starts every time, profile starts when you click it. Pick based on whether you want a worker ready by default.
- **Workspace vs. system** — `.vscode/tasks.json` is per-project (and goes into git if you commit it); profile in `settings.json` is system-wide across all your VS Code windows.
- **Terminal-side either way** — both spawn a terminal-launched Claude. Neither helps the Extension chat tab (which can't have channels enabled currently — see below).

### VS Code Extension chat tabs

The Extension renders Claude Code chat tabs inside VS Code itself (not terminals). Currently the Extension **cannot enable channels** for these tabs — there's no flag passthrough, and the `claudeCode.claudeProcessWrapper` setting is silently ignored in the current Extension build.

In practice this means Extension chat tabs run in **piggyback mode** (messages drain on every tool call), while terminal-launched Claude can run with **real-time push**. The natural division of labor:

- **Extension as orchestrator** — drives multi-chat workflows, sends `peer_ask`, reads replies via piggyback on its next tool call. Doesn't need push because it's actively driving anyway.
- **Terminals as workers** — wait for messages from the orchestrator. They *do* need push, so they wake up immediately when a task arrives.

See [USAGE — Recommended topology](USAGE.md#recommended-topology-extension-as-orchestrator-terminals-as-workers) for details.

## Where the plugin keeps its data

The plugin lives entirely in `~/.claude-bridge/` (its own namespace; never touches Claude Code internals):

```
~/.claude-bridge/
├── inbox/<sessionId>/
│   ├── pending/<msg-id>.json   ← incoming messages, not yet drained
│   └── done/<msg-id>.json      ← already consumed, available for peer_reply
├── status/<sessionId>.json     ← heartbeat (refreshed every 5 s)
├── guard/<sessionId>.json      ← context-usage guard thresholds (v0.7.0+)
└── notify/<sessionId>.json     ← idle-beep notification config (v0.7.0+)
```

Read-only access to `~/.claude/projects/` and `~/.claude/sessions/`. The plugin never modifies session JSONL files or any other Claude Code state.

## Environment variables

All optional. Set them in the shell before launching Claude Code (or in your shell profile).

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_BRIDGE_PEER_NAME` | ai-title from the session | Override this chat's display name in `peer_list`. Useful before Claude Code has generated an ai-title. |
| `CLAUDE_BRIDGE_ALLOW_ALL_PROJECTS` | unset | Set to `1` to allow `peer_chat_search { scope: 'all-projects' }`. Without it, search stays scoped to the current project. |
| `CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE` | enabled | Set to `0` (or `false`) to opt out of the dynamic terminal tab title (OSC 2) added in v0.6.0. Linux/macOS only; on Windows it is a no-op. |

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

### "identity_unresolvable on startup, plugin shows as failed"

Known race condition (pre-v0.5.2): the plugin's MCP server can boot fractionally faster than Claude Code writes its `~/.claude/sessions/<ppid>.json` file, so the plugin can't resolve its own identity and exits.

Workaround: `/mcp reconnect` inside Claude Code. The session file is in place by then and identity resolves cleanly.

This was fixed in v0.5.2 (retry with exponential backoff plus a `cwd-slug` fallback), so on current versions the workaround is rarely needed.

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
- **[Naming conventions](NAMING-CONVENTION.md)** — how MCP tools and bundled skills are named.
- **[Main README](../README.md)** — short summary of what the plugin does and who it's for.

The plugin also bundles role-playbook skills for multi-chat workflows: `claude-bridge-role-manager` (orchestrating worker peers) and `claude-bridge-role-memory-keeper` (single-writer shared memory). See [USAGE](USAGE.md) for when to load them.

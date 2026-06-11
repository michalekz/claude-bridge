# Channels — troubleshooting guide

This document is the deep reference for getting real-time push channels working with claude-bridge. The high-level setup is in [INSTALL.md](INSTALL.md); this file is what to read when push isn't working and you want to know exactly why.

> **Before you start — do you actually need channels?**
>
> claude-bridge delivers messages **without channels too**, via *piggyback*: when a sender's `peer_ask` lands in the recipient's inbox, the recipient sees it on its **next tool call**. Delivery is guaranteed and reliable; latency depends on the recipient's activity.
>
> If your messages arrive but with a delay, your plugin is **not broken** — piggyback is working as designed. This document is only for when you want **real-time push** (messages rendered inline as `<channel>` tags the moment they arrive, with no tool-call requirement) and push isn't happening.
>
> Real-time push is an **opt-in upgrade**, not a baseline requirement.

## TL;DR — three gates that must all be open

Channels deliver messages inline as `<channel>` tags only when **all three** of the following hold simultaneously. If any one fails silently, messages fall back to piggyback (delivered with the recipient's next tool call) and the user sees lag without an obvious error.

1. **`channelsEnabled: true`** in the right settings file (Console accounts: user-level `~/.claude/settings.json`; Teams/Enterprise: managed settings — see [Org admin context](#org-admin-context-teamsenterprise-vs-console)).
   *Verify:* read the file directly with `cat`/`type`.
2. **`allowedChannelPlugins`** contains an exact `{marketplace, plugin}` match for what's installed.
   *Verify:* compare against `claude plugin list` output (the part after `@` is the marketplace name).
3. **`--channels plugin:<plugin>@<marketplace>` flag** at Claude Code launch, with marketplace name matching the installed source.
   *Verify:* check the launch command and compare against `claude plugin list`.

If any gate is missing, you get one of the error patterns documented further down.

### Quick symptom index — jump to the fix

| Symptom you see | Section |
|---|---|
| `not on your org's approved channels list` warning | [→ not on approved list](#plugin-claude-bridgemarketplace-not-on-your-orgs-approved-channels-list) |
| `plugin not installed` at `--channels` startup | [→ plugin not installed](#plugin-claude-bridgemarketplace--plugin-not-installed) |
| `unsupported source type` at `plugin install` | [→ unsupported source type](#plugin-install-fails-with-unsupported-source-type) |
| Messages arrive only on recipient's next tool call (push silently failing) | [→ push falls back to piggyback](#messages-arrive-only-on-the-recipients-next-tool-call-push-silently-falls-back-to-piggyback) |
| `identity_unresolvable` at plugin boot | [→ identity race](#identity_unresolvable-on-plugin-boot) |
| Same name for multiple peers in same folder (e.g. all called "marketing") | [→ name collision](#two-peers-in-the-same-folder-show-the-same-name-marketing-etc-and-peer_ask-name-returns-peer_not_found-or-ambiguous_peer) |
| `peer_ask` returns `peer_not_found` even though `peer_list` just showed that name | [→ peer expired between calls](#peer_ask-name-returns-peer_not_found-despite-peer_list-having-just-shown-that-name) |
| Peer simply isn't in `peer_list` at all (you only see yourself) | [→ peer missing entirely](#peer-doesnt-appear-in-peer_list-at-all) |
| Two duplicate `plugin:claude-bridge@...` lines in startup banner | [→ duplicate banner](#startup-banner-shows-two-duplicate-pluginclaude-bridgemarketplace-lines) |

## Common requirements (any OS)

### Marketplace identifier must match what's installed

`claude plugin list` shows what marketplace the plugin came from:

```
claude-bridge@claude-bridge      ← installed from public github (single-plugin marketplace)
claude-bridge@oxyshop-plugins    ← installed from oXyShop monorepo
```

The part after `@` is the marketplace name. Everywhere you use the plugin identifier — `--channels` flag, `allowedChannelPlugins` entry, `claude plugin update` — that marketplace name must match exactly.

**Common pitfall:** updating with `claude plugin update claude-bridge` (no `@<marketplace>`) returns "Plugin not found" on the CLI. Use `claude plugin update claude-bridge@<marketplace>` qualified.

### Full restart after plugin update

When `claude plugin update` reports `Restart to apply changes`, this means the new bundle is on disk but the **running plugin process still has the old code loaded in memory**. To pick up the new code:

- **CLI:** `Ctrl+D` to exit Claude Code completely, then `claude --channels ...` to start fresh.
- **VS Code Extension chat:** `Ctrl+Shift+P` → `Developer: Reload Window`. If the new bundle doesn't kick in after reload, close VS Code entirely and reopen.
- **NOT enough on its own:** `/mcp reconnect` inside Claude Code. This only refreshes the MCP handshake; the underlying plugin process keeps its old in-memory copy.

### Keep your fleet on one version

A mixed-version fleet (some peers on v0.5.2, others on v0.6.0) produces subtle inconsistencies that are hard to diagnose: name collisions where one side sees the cwd-slug and the other sees the ai-title, push-watcher behavior that depends on whose receiver is which version, OSC 2 emission only from some peers. Each is a separate symptom and they compound.

**Recommendation:** when you ship a new claude-bridge release, `Ctrl+D` + restart every running peer (not just the one you're testing on). It's the cheapest way to keep the fleet sane.

### Org admin context: Teams/Enterprise vs Console

The default for `channelsEnabled` depends on your claude.ai account type:

- **Console (individual / Anthropic Console account):** channels default **ON**. User-level `~/.claude/settings.json` opt-in is honored.
- **Teams / Enterprise:** channels default **OFF** unless an admin enables them in managed settings. User-level config is ignored.

If you're a Teams/Enterprise user, the admin must update `allowedChannelPlugins` in claude.ai → Admin settings → Claude Code → Channels. User-level `~/.claude/settings.json` won't override managed policy.

When you're enabling channels for your own org, remember `allowedChannelPlugins` **replaces** Anthropic's default list. If your users rely on Telegram / Discord / iMessage channels, list them explicitly too.

## Linux / macOS

### Settings file location

User-level (individual Console accounts):

```
~/.claude/settings.json
```

Add:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-bridge", "plugin": "claude-bridge" }
  ]
}
```

### Restart command

```bash
# Exit Claude Code with Ctrl+D, then:
claude --channels plugin:claude-bridge@claude-bridge
```

### VS Code Remote (Linux remote, any client OS) — terminal profile

Terminal profiles for the Remote-SSH integrated terminal go in the **client-side** `settings.json` (on the laptop), NOT in `~/.vscode-server/data/User/settings.json` on the remote. See [INSTALL.md — VS Code terminal profile](INSTALL.md#vs-code-terminal-profile-all-oses) for the full snippet.

### Common Linux gotchas

- **`claude plugin marketplace add github.com/owner/repo` crashes the terminal**: CC bug on Linux 2.1.173 in certain scenarios. The marketplace IS registered in settings despite the crash. Skip the next step (`claude plugin install`) and instead manually edit `~/.claude/settings.json` to add `"claude-bridge@claude-bridge": true` to `enabledPlugins`, then restart Claude Code. Plugin will install on next start.

- **`Bash subprocess has no tty`**: by design — Claude Code spawns subprocess shells without a controlling terminal. Doesn't affect channels; just means you can't OSC-emit from those shells. Plugin handles its own OSC emission via parent CC's tty.

## Windows

Windows has stricter policy enforcement and several platform-specific config locations. Read this section in full if push isn't working there.

### Settings file locations

There are **three different `settings.json` files** that matter on Windows, and each handles different things:

| File | Path | What it controls |
|---|---|---|
| Claude Code user settings | `%USERPROFILE%\.claude\settings.json` | User-level channels opt-in (Console accounts only — Teams ignores), `enabledPlugins`, marketplaces |
| VS Code user settings (Windows client) | `%APPDATA%\Code\User\settings.json` | Terminal profiles for VS Code integrated terminal (including when connected to Linux remote) |
| Claude Code managed settings | `C:\Program Files\ClaudeCode\managed-settings.json` *or* `C:\ProgramData\ClaudeCode\managed-settings.json` | Admin-level policy. Required for Teams/Enterprise `channelsEnabled: true`. Needs admin write privileges. |

### Marketplace + allowlist alignment

On Windows where Teams policy is enforced, the **managed settings** `allowedChannelPlugins` must contain an entry that exactly matches the marketplace your plugin is installed from. If you install from `claude-bridge` marketplace (public github) but the org allowlist only has `oxyshop-plugins`, channels won't open — even though both reference the same plugin code internally.

For dev/test setups using multiple install paths, add **all** variants to the org allowlist:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "oxyshop-plugins", "plugin": "claude-bridge" },
    { "marketplace": "claude-bridge", "plugin": "claude-bridge" }
  ]
}
```

### Restart command

```powershell
# Exit Claude Code with Ctrl+D, then:
claude --channels plugin:claude-bridge@claude-bridge
```

Replace `@claude-bridge` with whatever your `claude plugin list` shows after the `@`.

### Push polling (v0.5.5+)

Before v0.5.5, Windows-native Claude Code receivers would silently fall back to piggyback because chokidar's default backend (`ReadDirectoryChangesW`) sporadically misses ADD events for files arriving via atomic temp+rename — especially with antivirus active. v0.5.5 forces `usePolling: true` on Windows with a 200 ms interval.

If you see push not working on Windows and version is `≤ 0.5.4`, update to current. Linux/macOS users are unaffected.

### `--dangerously-load-development-channels` is NOT a policy bypass

The flag whitelists the plugin's channel for the current session but **doesn't bypass org-level policy enforcement** on Teams accounts. You'll see the channel register in Claude Code's startup banner ("Channels (experimental) messages from … inject directly in this session") with a parallel warning ("not on your org's approved channels list"), but actual push delivery is still silently filtered out. Messages arrive only via piggyback.

The only real fix on Teams accounts is to add the plugin to managed `allowedChannelPlugins`.

### VS Code Extension chat tabs

The Extension's chat tabs render their own UI and **don't support channels at all currently**. The `claudeCode.claudeProcessWrapper` setting that older docs mention is silently ignored by Extension v2.1.x+. Use Extension chat tabs as the orchestrator (piggyback delivery is fine for the actively-driving side) and terminal-launched Claude as worker peers (where push matters).

## Symptom catalog

Each entry: error message or behavior → likely cause → fix.

### "plugin claude-bridge@<marketplace> not on your org's approved channels list"

**Cause:** the `--channels` arg references a marketplace/plugin combination that isn't in your org's `allowedChannelPlugins`. Most common on Teams/Enterprise accounts when you've installed the plugin from a marketplace the admin didn't whitelist yet.

**Fix:**
1. Verify `claude plugin list` to confirm which marketplace the plugin is from. The part after `@` is the marketplace name.
2. Ask your org admin to add `{ "marketplace": "<that marketplace>", "plugin": "claude-bridge" }` to the org's `allowedChannelPlugins`.
3. Wait a minute or so for policy propagation.
4. Restart Claude Code with the matching `--channels` flag.

If you're using two install paths (e.g. github for personal + GitLab for work), the admin must list **both** entries.

### "plugin claude-bridge@<marketplace> · plugin not installed"

**Cause:** `--channels plugin:claude-bridge@<X>` references marketplace `<X>`, but `claude plugin list` shows the plugin installed under a different marketplace name. The channels arg doesn't fall back; it expects exact match against an installed plugin.

**Fix:** match the marketplace name in `--channels` to whatever `claude plugin list` reports. For example, if list shows `claude-bridge@claude-bridge`, the channels arg is `--channels plugin:claude-bridge@claude-bridge`, not `@oxyshop-plugins`.

The same error appears if the plugin is genuinely uninstalled — verify with `claude plugin list`.

### Plugin install fails with "unsupported source type"

**Cause:** the marketplace's `marketplace.json` declares a `source` Claude Code doesn't recognize. The string-form `"source": "."` is **not** supported for plugins at the marketplace root; only subdirectory paths like `"./plugins/<name>"` work as strings. For root plugins, the source must be an object like `{ "source": "github", "repo": "<owner>/<repo>", "ref": "<tag>" }` (self-reference is OK).

**Fix:** if you're the marketplace maintainer, switch to object source. If you're a user, this means the marketplace you tried to add is misconfigured — file a bug against that marketplace or use a different distribution path.

### Messages arrive only on the recipient's next tool call (push silently falls back to piggyback)

This is the most insidious symptom because Claude Code's startup banner happily reports channels as "enabled" while delivery silently drops to piggyback. Multiple possible causes:

**a) Policy is blocking channels (Teams account, no managed allowlist match)**
- Banner shows the `Channels (experimental)` line AND a parallel `not on your org's approved channels list` warning.
- Fix: see "not on your org's approved channels list" above.

**b) Windows watcher missing FS events (v0.5.4 and earlier)**
- Banner shows channels enabled, no warnings, but push still doesn't deliver inline.
- `~/.claude-bridge/inbox/<recipient-id>/pending/<msgid>.json` exists right after the sender writes it, but the recipient never reacts until they make a tool call themselves.
- Fix: upgrade to v0.5.5+ which forces chokidar polling on Windows.

**c) Receiver not started with `--channels`**
- Receiver process is running plain `claude` without the channels arg. Push is opt-in per process.
- Fix: restart receiver Claude Code with `claude --channels plugin:claude-bridge@<marketplace>`.

**d) Receiver process is stale (old plugin code in memory)**
- You updated the plugin recently but the receiver was already running before the update. The old in-memory code doesn't know about new polling/OSC behavior.
- Fix: full Ctrl+D restart of the receiver, then start with `--channels`.

To distinguish a/b/c/d, check the receiver's pending inbox while a message is in flight (see [Diagnostic procedure](#diagnostic-procedure)).

### `identity_unresolvable` on plugin boot

**Cause:** the plugin's MCP server started a fraction of a second before Claude Code finished writing `~/.claude/sessions/<ppid>.json`, so the plugin can't resolve its own identity. Pre-v0.5.2 bug.

**Fix:** upgrade to v0.5.2+ which retries identity resolution with exponential backoff for up to ~3 s. As an immediate workaround on an older version, `/mcp reconnect` inside Claude Code re-attaches the MCP server, by which time the session file is in place.

### Two peers in the same folder show the same `name` ("marketing", etc.) and `peer_ask "<name>"` returns `peer_not_found` or `ambiguous_peer`

**Two distinct causes that look similar:**

**a) Windows path encoding bug (pre-v0.5.3)**
- Symptom: `peer_list` shows all peers in the same folder collapsed to a single name like `marketing` with `source: "cwd-slug"`, even though their ai-titles are different.
- Cause: pre-v0.5.3 `encodeProjectDir` left spaces / dots / non-ASCII chars in Windows paths unchanged, while Claude Code itself replaces them all with `-`. The constructed JSONL path didn't match what CC actually wrote, so ai-title couldn't be read → fallback to cwd-slug.
- Fix: upgrade to v0.5.3+.

**b) Cross-version environment (v0.5.2 peers running alongside v0.5.3+ peers)**
- Symptom: most peers show correct ai-title names, but a few old peers still show cwd-slug. `peer_ask` against the cwd-slug name returns `peer_not_found` because the v0.5.3+ resolver expects a different name format.
- Fix: restart the v0.5.2 peers (full Ctrl+D + restart) so they pick up the v0.5.3+ encoding and refresh their own status files with correct ai-title-derived names.

### Peer doesn't appear in `peer_list` at all

Distinct from the "appeared then expired" case. The peer never shows up to begin with, even though you know its Claude Code is running.

**Two distinct causes:**

**a) VS Code Extension lazy tab activation**

Extension chat tabs activate their MCP servers only when the user first **clicks** the tab. Until then, the plugin process for that chat hasn't started — the peer literally hasn't begun heartbeating yet. You'll open two Extension tabs side-by-side and `peer_list` from one will show only itself.

**Fix:** click the other tab once. Within ~5–10 s (one heartbeat cycle) it appears in `peer_list`. For multi-agent workflows where you don't want this delay, prefer terminal-launched Claude as workers (they start immediately on `claude` invocation, no lazy activation).

**b) Peer's heartbeat already expired before you looked**

The peer process is alive but its CC has been idle for over `ONLINE_THRESHOLD_MS = 30 s` and the heartbeat file mtime is stale. `peer_list` filters out anything older than that.

**Fix:** make the peer do something — even a no-op tool call. The heartbeat refreshes on every plugin activity. If the peer is genuinely dead, restart it.

### `peer_ask "<name>"` returns `peer_not_found` despite `peer_list` having just shown that name

**Cause:** heartbeat-based discovery has an `ONLINE_THRESHOLD_MS = 30s` cutoff. Between when `peer_list` ran and when `peer_ask` ran, the named peers' heartbeats expired (recipient went idle or its process was killed).

In v0.5.4+, `peer_not_found` errors return `details.activePeers[]` — the snapshot the resolver actually used. Inspect that to see who's actually online *now* (which may differ from what `peer_list` showed earlier).

**Fix:** address by `id` (UUID) which doesn't depend on the heartbeat-derived display name, OR re-run `peer_list` to get a fresh snapshot.

### Startup banner shows two duplicate `plugin:claude-bridge@<marketplace>` lines

```
✓ Channels (experimental) messages from plugin:claude-bridge@claude-bridge, plugin:claude-bridge@claude-bridge inject directly in this session
```

**Cause:** you passed both `--dangerously-load-development-channels plugin:X` AND `--channels plugin:X` with the same plugin. Both flags accept it independently, so it shows up twice.

**Fix:** this is cosmetic only. Use one or the other; with proper allowlist, you only need `--channels`.

## Diagnostic procedure

When push isn't working, walk through these in order:

### 1. Confirm plugin version on all peers

```
peer_list
```

For every peer (including self), check `version`. All peers need to be on v0.5.5+ for full Windows compatibility. If any peer is on an older version, restart it.

### 2. Confirm Claude Code startup banner

When you start `claude --channels plugin:...`, the banner should show:

```
✓ Channels (experimental) messages from plugin:claude-bridge@... inject directly in this session
```

with **no** parallel `not on your org's approved channels list` warning.

If you see the warning → see "not on your org's approved channels list" section above.
If you don't see the channels line at all → the `--channels` flag isn't being parsed; verify your launch command.

### 3. Trace a message through the filesystem

While testing push, watch the recipient's pending inbox in real time:

```bash
# Linux/macOS
watch -n 0.5 ls -la ~/.claude-bridge/inbox/<recipient-sessionId>/pending/
```

```powershell
# Windows PowerShell
while ($true) { Get-ChildItem $env:USERPROFILE\.claude-bridge\inbox\<recipient-sessionId>\pending\; Start-Sleep -Milliseconds 500; cls }
```

Send a message. What you observe distinguishes possible causes:

- **File never appears in `pending/`** → sender's `peer_ask` failed to write. Check sender's tool result; rare.
- **File appears in `pending/` and stays there indefinitely** → recipient's watcher isn't firing. On Windows, classic chokidar miss (pre-v0.5.5). Upgrade and full restart.
- **File appears in `pending/`, recipient shows it inline as `<channel>` tag immediately, then moves to `done/`** → push working as designed.
- **File appears in `pending/`, recipient does NOT show inline tag, then later moves to `done/` when recipient does any tool call** → push failed (policy block or watcher miss), piggyback caught up.

### 4. Compare what `peer_list` shows vs what error reports

In v0.5.4+, `peer_ask` and `peer_chat_read` `peer_not_found` errors include `details.activePeers` — the snapshot of who's actually online from the resolver's point of view. Compare it to your earlier `peer_list` to see whether peers expired between calls.

### 5. Verify policy from outside Claude Code

Check the user-level settings exists where you think it does:

```bash
# Linux/macOS
cat ~/.claude/settings.json | grep -E "channelsEnabled|allowedChannelPlugins"

# Windows
type $env:USERPROFILE\.claude\settings.json | Select-String "channelsEnabled","allowedChannelPlugins"
```

If you're on a Teams/Enterprise account, also check whether managed settings exist locally:

```bash
# Linux managed
ls /etc/claude-code/managed-settings.json 2>/dev/null && cat /etc/claude-code/managed-settings.json

# Windows managed (paths vary; admin may use either)
dir "$env:PROGRAMDATA\ClaudeCode\managed-settings.json" 2>$null
dir "$env:ProgramFiles\ClaudeCode\managed-settings.json" 2>$null
```

If managed settings exist and don't include your plugin in `allowedChannelPlugins`, that's why user-level opt-in isn't working.

## See also

- [INSTALL.md](INSTALL.md) — initial channels setup (this troubleshooting doc complements that)
- [USAGE.md — Recommended topology](USAGE.md#recommended-topology-extension-as-orchestrator-terminals-as-workers) — Extension as orchestrator, terminals as workers
- [Issue #21409 in anthropics/claude-code](https://github.com/anthropics/claude-code/issues/21409) — closed feature request that explains why claude-bridge does some things Claude Code doesn't
- [Issue #18326 in anthropics/claude-code](https://github.com/anthropics/claude-code/issues/18326) — related closed request for session-name to terminal-title propagation

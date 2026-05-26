# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.2] — 2026-05-26

Patch release — fixes the `identity_unresolvable` race condition users have hit on terminal-launched Claude Code.

### Fixed

- **`identity_unresolvable` on cold boot.** The MCP server could start a fraction of a second before Claude Code finished writing `~/.claude/sessions/<ppid>.json`, leaving the plugin unable to resolve its own identity and exiting. `buildContext()` now uses `resolvePeerIdentityWithRetry()` — exponential backoff with delays `[100, 200, 400, 800, 1500] ms` (≈ 3 s total). After all retries, the same `IdentityError` is thrown as before, so legitimate failures (old Claude Code version, ppid mismatch) still surface clearly. No more `/mcp reconnect` workaround needed on startup.

### Added

- `resolvePeerIdentityWithRetry()` public API in `identity.ts` with configurable `retryDelays` (tests can pass `[]` to disable retry).
- 4 new unit tests in `tests/unit/identity.test.ts` covering: fast path, retry-then-success mid-race, retry exhaustion, retry-disabled fast-fail.

### Docs

- `docs/INSTALL.md` + `docs/cs/INSTALL.md`: split channels enablement into user-level (`~/.claude/settings.json`) and admin/managed paths. Most individual devs want user-level.
- `docs/INSTALL.md` + `docs/cs/INSTALL.md`: added VS Code Remote caveat — `terminal.integrated.profiles.<os>` goes in client settings, not `~/.vscode-server/`. The profile dropdown UI is client-rendered; only the auto-detected shell list comes from the remote.
- `docs/INSTALL.md` + `docs/cs/INSTALL.md`: replaced fragile `claudeProcessWrapper` recommendation with honest "Extension chat tabs don't support channels currently" + pointer to topology section.
- `docs/INSTALL.md` + `docs/cs/INSTALL.md`: new "VS Code task — auto-start worker on folder open" subsection (third option alongside shell alias and terminal profile, via `tasks.json` + `runOn: folderOpen`).
- `docs/USAGE.md` + `docs/cs/USAGE.md`: new "Recommended topology" section — Extension as orchestrator (piggyback), terminals as workers (push). Explains the asymmetry as intentional, not a defect.

## [0.5.1] — 2026-05-26

Patch release — no functional changes. Documentation, CI hygiene, and internal cleanup.

### Added

- `CREDITS.md` — explicit attribution to upstream projects (cc2cc, claude-peers-mcp, claude-relay, multiclaude) whose patterns shaped this one.
- `README.cs.md` + `docs/cs/INSTALL.md` + `docs/cs/USAGE.md` — Czech translations as first-class parallel documentation. Language switcher in both READMEs.
- `.gitattributes` — forces LF line endings on all platforms (fixes Windows CI Biome failures).
- `local/` gitignore convention — per-clone scratch space for internal notes and drafts.

### Changed

- Test suites set `USERPROFILE` env var alongside `HOME` for Windows `os.homedir()` resolution. Fixes Windows CI test failures.
- `paths.test.ts` assertions use `path.join()` for cross-platform path separators.
- Internal source-comment examples updated from `/opt/oxy-kb` (real internal project name) to generic `/opt/my-project` placeholders.
- Czech install docs (`docs/cs/INSTALL.md`) now point to public github marketplace instead of internal GitLab. oXyShop users continue to install via their internal marketplace (which references this public repo as an external source — see [oXyShop internal marketplace.json](https://git.oxyshop.cz/ai-tools/oxyshop-claude-plugins)).

### Notes

CI now green across **ubuntu-latest, macos-latest, windows-latest × Node 20, 22** (6 jobs).

## [0.5.0] — 2026-05-26

Initial public release with the complete feature set developed across the 0.1.x–0.5.x internal cycle at oXyShop.

### Tools

- `peer_list` — discover other live Claude Code chats on the same machine (heartbeat-based, <30 s freshness).
- `peer_ask` / `peer_reply` — file-based messaging between chats with `pending`/`done` archive and `inReplyTo` correlation.
- `peer_inbox_read` — manual drain (rarely needed; piggyback handles this automatically on any tool call).
- `peer_chat_read` — read another chat's transcript with rich controls: `lastN`, `sinceTimestamp`, `sinceLastUserPrompt` semantic anchor, in-session `query`/`queryRegex` with `contextLines`, `crossProject` for archived sessions, `includeToolCalls`/`includeThinking` opt-ins, three output formats (markdown/json/compact).
- `peer_chat_search` — cross-session text search within current project (default) or across all projects, with regex support, context lines, scope caps and early-termination at `maxMatches`.
- `list_projects` / `list_sessions` / `session_stats` — read-only navigation of `~/.claude/projects/` JSONL history. `list_sessions` ships rich enrichment behind opt-in flags: `active` flag from heartbeat, `aiTitle`, `userPrompts` and `assistantReplies` counts that exclude tool_result inflation.

### Delivery model

- **Piggyback fallback (always on)** — incoming messages are drained from `~/.claude-bridge/inbox/<sessionId>/pending/` and rendered into the receiver's next tool call output. Reliable regardless of channel configuration.
- **Push channel (opt-in)** — when admin enables `channelsEnabled: true` plus the plugin in `allowedChannelPlugins`, messages arrive inline as `<channel>` tags in the receiver's context. Push and piggyback are deduplicated — a message delivered via push will not be re-rendered in the inbox block.

### Identity

- Stable peer `id` (Claude Code sessionId UUID) plus human-readable `name` (slug from ai-title or cwd). Plugin handles ambiguous-name resolution with explicit error rather than silent collision.
- Dynamic identity refresh — boot-time fallback identity is replaced with the actual ai-title once Claude Code emits it.

### Reliability

- Atomic file writes via `temp → rename` (cross-platform, with Windows AV retry).
- IDE-injected noise (`<ide_*>`, `<system-reminder>`) stripped from search and display.
- `tool_use` input + `tool_result` content truncated past 500 characters in `peer_chat_read` to prevent context blowup.

### Skill bundle

- `skills/claude-bridge/SKILL.md` — auto-loaded by Claude Code when the agent encounters multi-chat orchestration intent. Decision tree, workflow recipes, anti-patterns, error reference.

### Performance defaults

- `peer_chat_search` honors `maxAgeDays = 30` (older sessions skipped), `maxBytesScanned = 200 MB` (returns `scope_too_large` above), `maxMatches = 30` (early-terminate).
- Raw-buffer pre-filter on whole JSONL skips sessions without query hits before JSON parsing.

### Tests

- 202 unit tests covering parser, identity, inbox, peers registry, channel, watcher, atomic writes, and all eight MCP tools.

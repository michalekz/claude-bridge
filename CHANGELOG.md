# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.4] — 2026-06-30

### Fixed — `peer_context_status` undercount for fresh / post-clear sessions

Real-world smoke test on 5 active peers (jira-architect, jira-admin, jira-transition-head, jira-integration-dev, hmh-memory-keeper) revealed major undercount when a peer's session had recently gone through cache invalidation:

| peer | cache_read | cache_creation | true `/context` | v0.7.3 returned | v0.7.4 returns |
|---|---|---|---|---|---|
| jira-transition-head | 23,060 | **806,186** | ~83% | **2.3%** ❌ | **83.4%** ✓ |
| jira-integration-dev | 23,060 | **935,683** | ~96% | **2.3%** ❌ | **96.3%** ✓ |
| jira-admin | 948,901 | 596 | ~95% | 94.9% (~OK) | 94.9% |

**Root cause:** v0.7.0-v0.7.3 used `cache_read_input_tokens` alone. That works for mature cached sessions (cache_read dominates, cache_creation tiny). But after `/clear`, autocompact, or session start, cache is freshly being filled — `cache_creation_input_tokens` carries most of the input, `cache_read` is tiny. The original implementation read the wrong field.

**Fix:** `tokensUsed = cache_read + cache_creation + input + output` — total tokens in context window after the last assistant turn. Empirically matches `/context` across both fresh and mature sessions.

User-reported: "/context ukazuje zcela jiné (pravdivé) hodnoty ve srovnání s tím, co vrací MCP nástroj". Confirmed by raw JSONL inspection.

### Tests

- 263 → 265 (+2 covering full-formula sum + missing-field handling).
- Pre-existing test data updated to use realistic 4-field usage objects.

## [0.7.3] — 2026-06-29

### Added — `model_info` MCP tool

Static lookup tool returning canonical Claude model metadata. No JSONL scan, no network call — just an in-process table sourced from [Anthropic platform docs](https://platform.claude.com/docs/en/about-claude/models/overview).

Per-model fields:
- `id`, `displayName`, `family` (opus/sonnet/haiku/fable/mythos), `generation` (current/legacy/deprecated)
- `contextWindow`, `maxOutputTokens`
- `pricing` (input/output per MTok)
- `capabilities` (vision, extendedThinking, adaptiveThinking)
- `knowledgeCutoff`, `trainingDataCutoff`
- `notes` (special quirks, EOL dates)

Usage:
- `model_info()` — list all 10 known models
- `model_info({ model: "claude-opus-4-7" })` — single lookup (date suffix + [1m] stripped)
- `model_info({ generation: "current" })` — filter by lifecycle

### Refactored

- Extracted canonical model table to `src/parser/model-metadata.ts` (= single source of truth shared between `context-usage.ts` and `model_info` tool).
- `detectContextLimit` now delegates to `lookupModel` from the shared table.

### Tests

- 248 → 263 (+15 covering normalization, lookup, table integrity).

## [0.7.2] — 2026-06-29

Patch: replace empirical heuristic with **canonical model → context-window lookup**.

### Fixed

- **`detectContextLimit` now uses a canonical lookup table** sourced from [Anthropic platform docs](https://platform.claude.com/docs/en/about-claude/models/overview) (verified 2026-06-29):

| Model | Context window |
|---|---|
| Opus 4.6 / 4.7 / 4.8 | **1M** |
| Sonnet 4.6 | **1M** |
| Fable 5 / Mythos 5 / Mythos Preview | **1M** |
| Haiku 4.5 | **200k** |
| Legacy: Opus 4.1 / 4.5, Sonnet 4.5 | **200k** |

Previous v0.7.1 used the heuristic "tokensUsed > 200k → assume 1M". That worked but was hacky. v0.7.2 uses official model metadata; heuristic remains as defensive fallback for unknown/future model ids.

- Date suffix on model ids (`claude-haiku-4-5-20251001`) is stripped before lookup.
- Explicit `[1m]` tag still wins (overrides lookup for legacy models).

### Tests

- 244 → 248 (+4 covering canonical lookup, all generations, date-suffix normalization).

## [0.7.1] — 2026-06-29

Patch fix discovered during v0.7.0 smoke test (= empirical heuristic, superseded by v0.7.2 canonical lookup).

### Fixed

- **`peer_context_status` limit detection** — model strings in JSONL don't always carry the `[1m]` suffix. v0.7.1 added empirical heuristic: if `tokensUsed > STANDARD_LIMIT (200k)`, bump to `ONE_M_LIMIT (1M)`. v0.7.2 replaces this with canonical lookup table.

- **`dist/bundle.cjs` rebuilt** with the fix.

### Tests

- 243 → 244 (+1 for heuristic).

## [0.7.0] — 2026-06-29

Major release — **self-defending context lifecycle** + practitioner-grounded role playbooks.

### Added — MCP tools

- **`peer_context_status`** — read autocompact-relevant statistics for self or other peer(s). Returns `tokensUsed`, `contextLimit`, `percentUsed`, `autocompactRisk` (low/medium/high), `model`, `lastTurnAt`. Data source: `usage.cache_read_input_tokens` on most recent assistant event in peer's JSONL — matches `/context` Total exactly. Targets: `to` omitted = self; `to: 'all'` = all active peers + self; `to: 'alice'` = single peer; `to: ['alice', 'bob', 'self']` = bulk.

- **`peer_set_context_guard`** — self-write configuration for context-usage guard. Defaults: `enabled=true`, `warnAtPercent=0.85`, `criticalAtPercent=0.95`, `notifyPeerIds=[]`, `broadcastProject=false`. Self-targeted only — peer controls own settings. Persisted to `~/.claude-bridge/guard/<sessionId>.json`.

- **`peer_set_notification`** — self-write configuration for idle-beep notification. Defaults: `enabled=false`, `minIdleSeconds=30`. Persisted to `~/.claude-bridge/notify/<sessionId>.json`.

### Added — bundled role skills

Practitioner-grounded playbooks (3 reviewers across 3 different teams):

- **`claude-bridge-role-manager`** — playbook pro orchestrátora 2-N worker peerů. 11 load-bearing principů (Manager nevyrábí výstup, scale rigor to stakes, gating dle reverzibility×blast-radius×outward, verify, worker output = data, hub-and-spoke + mesh, NEzprůměrovávat neshodu, async crossed messages, no manager-execution, FREEZE artifact, manage upward). 17-section PLAYBOOK.md s detail patterns + cross-machine handoff + peer death recovery. Konvergenční signál: 3 nezávislí praktici z různých týmů zkonvergovaly na stejné patterny (pre-flight downstream isolation, single-writer route-to-keeper, FREEZE artifact, doc-wins-on-conflict).

- **`claude-bridge-role-memory-keeper`** — LIGHT playbook pro dedikovaného memory keeper peera v týmu 3+. 5 load-bearing principů + 8-krok zápis workflow + reconcile-pass workflow. References `claude-bridge-role-manager` PLAYBOOK #10 (= ironicky exemplifikuje princip pointer-not-duplicate).

### Changed

- **Bundle rebuilt** — previous bundle (`dist/bundle.cjs`) was stale from Jun 6, pre-v0.6.1. Self-read fix from commit `0e945dd` now actually shipped.

- **Naming convention documented** (`docs/NAMING-CONVENTION.md`) — MCP tools snake_case, skills `claude-bridge-role-*` pro role-based / `claude-bridge-*` pro operational.

- **Existing `claude-bridge` skill SKILL.md updated** — odebrány stale references na `self_read` error (= odstraněn v v0.6.1).

### Notes

- v0.7.0 introduces **infrastructure** for context guard (tools + state files). Wake-time warning injection into channel pump is scheduled for v0.7.1. v0.7.0 lets peers read each other's status; v0.7.1 will auto-fire warnings when threshold crossed.
- Tool count: 9 → 12.

### Tests

- 230 → 243 (+13 for context-usage parser).
- All passing, TypeScript strict, biome lint clean.

## [0.6.1] — 2026-06-11

Patch release allowing an agent to **read and search its own session**. Two paternalistic blocks were removed because they actively hurt the most useful recovery scenarios.

### Changed

- **`peer_chat_read` no longer rejects own session.** Previously `peer_chat_read { to: <self> }` returned `self_read` error with message "Cannot read own chat — your own context is already loaded". That assumption is wrong in three common scenarios where it matters most:
  - **Autocompact** — context window is compressed, original detail is gone from in-memory but lives on disk.
  - **`/clear` during a long session** — agent intentionally cleared its context, JSONL stays intact on disk.
  - **Resume after crash / restart** — only partial context is reloaded, full history is on disk.
  
  In all these, querying own JSONL via `peer_chat_read` is the legitimate (and sometimes only) recovery path. Caller has discretion over its own context window — adding history back is its call.

- **`peer_chat_search` no longer silently filters out caller's own session.** Same reasoning as above: post-autocompact / long-session use needs to search full on-disk history, including own. The silent filter made searches look incomplete without explanation.

### Why this isn't a breaking change

- No tool signature changes. Both tools accept the same args.
- `peer_ask` self-send block (`self_send` error) **stays intact** — sending a message to your own inbox is genuinely a weird loop with no useful semantic.
- Behavior change only: previously-erroring calls now succeed. No existing correct code can break.

### Tests

- Existing self-rejection tests flipped to verify happy-path: `peer_chat_read { to: self }` returns messages, `peer_chat_search` includes self session in scope.
- 230/230 tests pass.

## [0.6.0] — 2026-06-11

Minor release adding **dynamic terminal tab title** that tracks each peer's `displayName` (ai-title) automatically. End of "all my Claude tabs look identical" — orchestrators with 4+ worker terminals can finally tell them apart at a glance without manual `--name` flags or right-click renames.

### Added

- **Terminal title emission via OSC 2** — when a peer's `displayName` resolves or changes (typically when Claude Code emits the `ai-title` event 5-10 seconds after the first user prompt), the plugin writes `\x1b]2;<displayName>\x07` to the parent Claude Code process's controlling tty. VS Code's integrated terminal (and every standard terminal emulator) honors this in its tab title.
- New module `src/util/terminal-title.ts` with three exported helpers: `parseTtyNrFromProcStat`, `findParentTty`, `emitTerminalTitle`, `isTerminalTitleEnabled`.
- New `BuildContextOptions.emitTerminalTitle` flag (default: respect `CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE` env var; tests set `false`).
- New `ServerContext.parentTty: string | null` — cached at boot, used by the identity-refresh loop to re-emit OSC on `displayName` changes.

### Platform coverage

| Platform | Mechanism | Status |
|---|---|---|
| Linux | Parse `/proc/<ppid>/stat` field 7 (`tty_nr`) → `/dev/pts/<minor>` for major 136 (pty multiplexer) | ✓ |
| macOS | `ps -p <ppid> -o tty=` → `/dev/<tty>` (no `/proc` available) | ✓ |
| Windows | Requires Win32 `AttachConsole(parentPID)` + `WriteConsoleW` (or a native helper binary) | not yet — silent no-op |

VS Code Extension chat tabs use their own internal rendering (read `ai-title` directly from CC) and don't need this feature.

### Why this instead of Claude Code itself

Anthropic closed the upstream feature request to emit OSC 2 from Claude Code ([anthropics/claude-code #21409](https://github.com/anthropics/claude-code/issues/21409) "not planned"; [#18326](https://github.com/anthropics/claude-code/issues/18326) closed). The plugin already monitors `ai-title` events for peer-name purposes, so it's the natural place to put the OSC emission.

### Opt-out

Set `CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE=0` (or `false`) in the environment before starting Claude Code if you'd rather not have your tab titles overwritten by the plugin.

### Tests

- 17 new unit tests in `tests/unit/terminal-title.test.ts` covering: tty_nr decoding (single-byte minor, high minor with bit-split, comm with embedded parens, malformed input, no-tty case), OSC 2 file write (UTF-8 titles with special chars), env-var opt-out parsing, Windows platform dispatch.
- All existing 213 tests updated to pass `emitTerminalTitle: false` so they don't pollute the test-runner's tty.
- 230/230 pass.

## [0.5.5] — 2026-06-11

Patch release fixing real-time push delivery on Windows-native Claude Code.

### Fixed

- **Windows push channel silently fell back to piggyback.** Chokidar's default backend on Windows (`ReadDirectoryChangesW`) sporadically misses `ADD` events for files arriving via atomic `temp → rename`, especially with antivirus in the loop. Empirically confirmed: a message arrives in the receiver's `~/.claude-bridge/inbox/<id>/pending/`, but the watcher never fires — the message gets delivered via piggyback on the recipient's next tool call instead of inline as a `<channel>` tag. End-user effect: "I started Claude with `--channels` and channels said enabled, but messages still feel like they're queued."

  Fix: force `usePolling: true` (200 ms interval) on Windows only. Linux/macOS keep native inotify/FSEvents — no regression. Polling adds at most ~200 ms latency vs. ~0 ms native, still orders of magnitude faster than waiting for the recipient's next tool call.

### Why polling and not a smarter Windows backend

`ReadDirectoryChangesW` is the official native backend and has known atomic-rename event delivery gaps that aren't fixable from userland. Chokidar's docs explicitly recommend `usePolling` for reliability on Windows, especially with atomic writes. We use atomic writes throughout (temp + rename for inbox messages), so polling is the right call.

### Verification

- 213/213 unit tests pass on all platforms.
- Behavior unchanged on Linux/macOS (native events, sub-ms delivery).
- Windows behavior fixed (polling, ~200 ms delivery).

## [0.5.4] — 2026-06-06

Patch release adding diagnostic context to peer-resolution errors so agents and users can tell *typo* from *expired heartbeat* when something doesn't match.

### Added

- `peer_ask` and `peer_chat_read` `peer_not_found` errors now ship a `details` object with:
  - `activePeers[]` — id + name (+ displayName if different) snapshot of *currently* active peers (the snapshot the resolver actually used, not a re-read).
  - `hint` — a short note explaining that heartbeat-based discovery (`ONLINE_THRESHOLD_MS = 30s`) can drop peers between calls and recommending `peer_list` re-check / address by id.
- `peer_reply` `original_not_found` now ships a `details.hint` pointing at `peer_inbox_read` to drain pending if the original message was push-delivered but not yet drained.

### Why

Triggered by a user report on Windows where `peer_ask "marketing"` returned `peer_not_found` despite `peer_list` having shown five peers with that exact name moments earlier. Code-level analysis confirmed both calls use the same `listActivePeers()` source — the disparity was timing: heartbeats from idle v0.5.2 peers expired between the two calls. Without the snapshot in the error response, the agent couldn't tell *who IS active now* without making yet another `peer_list` call (potentially yielding yet a third snapshot).

### Verification

- 213/213 unit tests pass (+2 new tests covering the new details shape).
- Typecheck clean, biome clean.
- Backwards-compatible: only adds optional `details` fields on already-existing error responses; existing consumers ignoring details aren't affected.

## [0.5.3] — 2026-06-06

Patch release fixing Windows identity resolution for paths with spaces, dots, or non-ASCII characters, plus the public-marketplace distribution flow.

### Fixed

- **Windows identity stuck at `cwd-slug` for paths with spaces/dots/non-ASCII chars.** Our `encodeProjectDir()` only replaced path separators (`:`, `\`, `/`) — but Claude Code on Windows replaces *every* non-`[a-zA-Z0-9-]` character with `-`, per-character, no collapsing. So `o:\MICRONIC Přerov s.r.o\Marketing` was encoded by us as `o--MICRONIC Přerov s.r.o-Marketing` (spaces / `ř` / dots preserved) while Claude Code wrote the JSONL into `o--MICRONIC-P-erov-s-r-o-Marketing`. We never found the JSONL → couldn't read ai-title → fell back to `cwd-slug`. With all chats in the same folder colliding to the same slug, peer routing by name became unusable on Windows. Same fix also applies on Linux for paths with spaces (rare but possible).
- **Public github marketplace install path.** Two regressions discovered after v0.5.2: (1) `.claude-plugin/marketplace.json` was missing, so `/plugin marketplace add github.com/michalekz/claude-bridge` failed; (2) when added, the initial source `"."` was rejected as "unsupported source type" — the string-path form only accepts subdirectories. Fixed by adding `marketplace.json` with an object self-source `{"source": "github", "repo": "michalekz/claude-bridge", "ref": "v0.5.3"}`. The documented install commands now work end-to-end on a clean Claude Code.

### Added

- 6 new unit tests in `tests/unit/paths.test.ts` covering Windows paths with spaces, dots, Czech diacritics, literal dashes; Linux paths with spaces and dots.

### Notes

- The Windows fix is meaningful because real-world Windows project paths typically contain spaces ("My Project", "Program Files"), dots ("s.r.o"), and (in non-English locales) diacritics. Without it, `peer_list` on Windows produces a single ambiguous name across all chats from the same folder — orchestration is still possible by UUID, but `peer_ask { to: "name" }` becomes unusable.

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

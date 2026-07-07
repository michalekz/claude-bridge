# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.9.0-alpha.1] — 2026-07-07 (pre-release)

⚠ **Pre-release for internal live-testing only.** Not the full v0.9.0.
Beta (PostToolUse OAuth hook + `peer_set_rate_limit_guard`) and RC (bundled
SessionStart hook + banner + `claude-bridge-setup` skill) still pending.

### Breaking change (partial)

`peer_context_status` is now live-data-only. All heuristics removed:

- `settings-json-1m-tag` — removed (JSONL bare-id ambiguity is now moot, we read `context_window_size` directly)
- `explicit-1m-tag` — removed
- `canonical-lookup` for context detection — removed (canonical model table kept in `model_info` tool as read-only reference)
- `empirical-heuristic` — removed
- `unknown-model-fallback` — removed

New output shape:
- `hasLiveData: boolean` — true when `~/.claude-bridge/live/statusline.json` is readable
- `contextLimitSource: "statusline-stdin" | "no-live-data"` (was 5-way enum)
- `effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | null` (new — from CC 2.1.119+ stdin)
- `claudeCodeVersion: string | null` (new — from CC stdin)
- `setupPointer: string` (only when `hasLiveData: false`) — instructs the user how to install the statusLine wrapper

### Added

- **`bin/claude-bridge-statusline`** — chained statusLine wrapper. Install by setting `settings.json.statusLine.command` to `node ${CLAUDE_PLUGIN_ROOT}/dist/statusline.cjs`. Optional passthrough to user's existing statusLine (e.g. benabraham's) via `CLAUDE_BRIDGE_UNDERLYING_STATUSLINE` env var — subprocess with stdin forward, stdout stream-through.
- **`src/parser/live-data.ts`** — shared reader/writer for `~/.claude-bridge/live/{statusline,oauth-api}.json` envelopes.

### Removed (dead code)

- `src/parser/settings.ts` + tests
- `detectContextLimit` / `detectContextLimitWithSource` from `src/parser/context-usage.ts`
- JSONL usage-field scan (context-usage.ts no longer imports parseSessionFileRaw)

### Still pending for v0.9.0 stable

- beta: PostToolUse hook + OAuth API fallback (`bin/claude-bridge-refresh-limits`), `peer_set_rate_limit_guard` tool
- rc: bundled SessionStart hook + `bin/setup-check` + banner, `claude-bridge-setup` skill
- docs: `docs/SETUP-LIVE-DATA.md` (EN + CS), `docs/HOOKS-STATUSLINE-ARCHITECTURE.md`
- rate_limit_status refactor to read `live/{statusline,oauth-api}.json` primary sources (still reads fossil `.usage_cache.json` in alpha)

### Tests

- 282/282 pass (dead heuristic tests removed, +13 new live-data path tests)

## [0.8.3] — 2026-07-07

### Fixed — CREDITS and tool description factual correction

Static analysis of [benabraham/claude-code-status-line](https://github.com/benabraham/claude-code-status-line) v5.4.0 (during v0.9.0 recon) revealed that our pre-v0.8.3 documentation contained a load-bearing factual error:

- We described `~/.claude/.usage_cache.json` as **"Claude Code's own cache"**.
- In reality: **the file is written by the status-line project itself**, not by Claude Code. Writes happen only inside `fetch_usage_data()` (line 731-735 of the status-line source), which is a **deprecated OAuth API fallback path** kept for CC versions older than 2.1.80.
- On any modern CC install (2.1.80+), `rate_limits` are sent to statusLine hook via **stdin JSON per render**; the fallback code path never fires; the cache file **stops refreshing shortly after install**.

**Concrete effect:** `rate_limit_status` in v0.8.0-v0.8.2 reads a fossilized secondary cache belonging to a third-party project. The 36-hour-stale cache surfaced by Zdeněk on 2026-07-07 was not an edge case — it is the steady state on any current Claude Code install with the status-line project installed.

Fixed in this release (docs only, no behavior change):

- **`CREDITS.md`** — status-line attribution rewritten with the correct data ownership model (benabraham writes the cache, not CC).
- **`rate_limit_status` tool description** — leads with the "not CC's cache" clarification and points at v0.9.0 as the architectural fix.
- **`src/parser/rate-limits.ts` file header** — documents the deprecated fallback path and points forward to `docs/HOOKS-STATUSLINE-ARCHITECTURE.md` (which ships with v0.9.0).

### Coming in v0.9.0

**Breaking change.** The fossil-cache read will be removed. Live data sources:

1. Plugin-owned statusLine wrapper writing `~/.claude-bridge/live/statusline.json` on every render (primary; autoritative `rate_limits` + `context_window` from CC stdin).
2. PostToolUse hook calling `/api/oauth/usage` (secondary; throttled).
3. If neither is configured → `hasLiveData: false` with pointer to `docs/SETUP-LIVE-DATA.md`.

All context-limit heuristics in `peer_context_status` (`empirical-heuristic`, `unknown-model-fallback`, `settings-json-1m-tag`, `explicit-1m-tag`, `canonical-lookup` for context detection) will be **removed** in favor of authoritative `context_window.context_window_size` from CC stdin. Reference metadata via `model_info` tool remains.

### Tests

- 313/313 pass (no code behavior change).

## [0.8.2] — 2026-07-07

### Fixed — `rate_limit_status` misleading data from expired windows

Bug reported by Zdeněk Michálek + jira-architect (HMH) from first real-world use: `rate_limit_status` returned a 36-hour-stale cache showing `week: 96% CRITICAL` with `hoursUntilReset: -32.5` (past). The utilization number described a DEAD window; consumers reasoned about it as if it were live state.

The `cacheAgeSeconds` field alone wasn't enough — agents don't reliably cross-check it against `resetsAt`. This release adds a deterministic verdict instead of a caveat.

### Added — `staleness` verdict + per-bucket `windowExpired`

- **`windowExpired: boolean`** on every `RateLimitBucket` (session, week) and `ScopedLimit` — true when `resetsAt < now`. Deterministic, no heuristics.
- **`staleness`** on the tool root (new enum `"fresh" | "stale" | "expired-window"`):
  - `fresh` — cache < 5 min old, no expired windows. Trust everything.
  - `stale` — cache older but session + week windows still current. Absolute utilization is orientational; `resetsAt` and window boundaries remain reliable.
  - `expired-window` — one or more buckets have `windowExpired: true`. Utilization describes a dead window; consult `/rate-limits` in Claude Code or wait for the next cache refresh event.

**Priority:** `expired-window` dominates the age check. A 60-second-old cache with a past `resetsAt` is still `expired-window` — window integrity beats freshness.

### Tool description update

`rate_limit_status` description now documents the three staleness levels + when to trust which fields (per Zdeňkovo dodatek from approval msg `mrakpgr6-6dd16214`).

### Deferred (v0.9.0)

- **Exploration:** find the live data source Claude Code's status line uses (evidently fresh, unlike `.usage_cache.json`). Candidates: statusLine hook payload (leading), other `~/.claude/*.json` file, CC IPC, or direct API call. Recon-first, not a promise.

### Tests

- 306 → 313 (+7 covering windowExpired flags on session/week/scopedLimits, three staleness verdicts (fresh/stale/expired-window), and the "fresh cache + dead window" corner case where window integrity beats age).

## [0.8.1] — 2026-07-07

### Fixed — authoritative `[1m]` detection via `~/.claude/settings.json`

Follow-up patch to v0.8.0 context-limit detection. Discovery during post-release verification:

- JSONL `message.model` = bare id (e.g. `"claude-fable-5"`). Anthropic's API response strips the `[1m]` suffix.
- `~/.claude/settings.json.model` = **with** `[1m]` (e.g. `"claude-fable-5[1m]"`) — authoritative user configuration.

Result: `peer_context_status` couldn't tell a 200k Haiku 4.5 session from a 1M Haiku 4.5 `[1m]` session from JSONL alone. v0.8.1 reads `settings.json` once per `readContextUsage` call and uses it as the priority-1 signal.

### New `contextLimitSource` value

- **`settings-json-1m-tag`** (new, priority 1) — `~/.claude/settings.json.model` carried `[1m]`. Authoritative.
- `explicit-1m-tag` (priority 2) — JSONL model string carried `[1m]`. Rare (API strips it) but kept as legacy path.
- `canonical-lookup` (priority 3) — settings model, then JSONL model, normalized against the canonical table.
- `empirical-heuristic` (priority 4) — unchanged.
- `unknown-model-fallback` (priority 5) — unchanged.

### API surface

`detectContextLimitWithSource(jsonlModel, tokensUsed, settingsModel?)` — third argument added, backwards-compatible (undefined ≡ no settings signal, falls through to legacy chain).

`readClaudeSettings()` — new helper in `src/parser/settings.ts`. Returns `null` on missing / unreadable / malformed settings.json so callers don't need to distinguish.

### Behavior notes

- Settings.json is read **once per `readContextUsage` call**, not cached. Cost is one small file read (~1.5 KB in typical setups). Acceptable given `peer_context_status` isn't called on the hot path.
- Cross-peer: `settings.json` is USER-scoped, so all peers on the same POSIX account share the same signal. Cross-user machines see the caller's own settings — same limitation as `rate_limit_status`.

### Tests

- 280 → 306 (+26: 8 new `settings.ts` tests, 7 new `detectContextLimitWithSource` variants covering settings-json interaction, 3 new `readContextUsage` integration paths, plus refactored suite mocks `node:os.homedir` so tests are isolated from the dev/CI machine's `~/.claude/settings.json`).

## [0.8.0] — 2026-07-07

### Added — `rate_limit_status` MCP tool

New tool exposing account-scoped rate limits, read from Claude Code's own usage cache at `~/.claude/.usage_cache.json`. **USER-scoped** — all peers on the same POSIX account share exactly one set of rate limits.

Discovery credit: inspired by [benabraham/claude-code-status-line](https://github.com/benabraham/claude-code-status-line) (MIT). Their status-line tool taught us the structure. Our tool is complementary — agent-facing (JSON, cross-peer-aware) rather than human-facing (ANSI terminal).

Output fields:
- **`session`** (5-hour window) — utilization (0-1), resetsAt, hoursUntilReset, severity, isActive
- **`week`** (7-day window) — same shape
- **`scopedLimits[]`** — per-model / per-surface breakdowns (e.g., "Fable weekly: 11%")
- **`spend`** — cost cap details when `enabled=true` (usedAmountUsd, limitUsd, currency, severity)
- **`extraUsage`** — extra credits pool when `is_enabled=true`
- **`perModelWeekly`** — non-null per-model weekly quotas (opus / sonnet / oauthApps / cowork / omelette)
- **`rawExperimental`** — passthrough for internal codenames (tangelo, iguana_necktie, ...) that may become active in the future
- **`cacheAgeSeconds`** — Claude Code refreshes the cache only on specific events (session start, `/rate-limits`, threshold crossing), NOT per-turn. Consumers should reason about staleness.

Behavior when the cache file doesn't exist: returns `{ hasCache: false, cachePath }` — graceful degrade for accounts that have never invoked `/rate-limits` or aren't logged in.

**Manager use case:** before dispatching a long task, `rate_limit_status` shows whether the account has weekly headroom + when the 5-hour session refreshes. Combined with `peer_context_status` (per-peer context %), the orchestrator has full visibility to pre-empt autocompact AND rate-limit exhaustion.

### Naming convention update

New pattern documented in `docs/NAMING-CONVENTION.md`: **`<resource>_status`** without `peer_` prefix for account-scoped tools (single-result, not per-peer). First member: `rate_limit_status`. Justified because rate limits are per-user, not per-peer — the parallel `peer_rate_limit_status` would be misleading.

### Fixed — `peer_context_status` unknown-model fallback

Bug found by Zdeněk Michálek + jira-architect (HMH) on 2026-07-07: **Claude Sonnet 5** (new frontier model with 1M window) was missing from the canonical table. Fallback to `STANDARD_LIMIT` (200k) inflated `percentUsed` by 5× — a session at real 16% showed as 76-78% ("medium risk" bucket), triggering unwarranted context-management escalations.

Two coordinated fixes:

1. **Metadata table updated** — added Claude Sonnet 5 (1M context) + refreshed related entries. Sonnet 4.6 marked superseded.
2. **New field `contextLimitSource` on `peer_context_status` output** — explicit trace of how `contextLimit` was derived:
   - `canonical-lookup` — model matched the table (trust the ratio)
   - `explicit-1m-tag` — model string carried `[1m]` (trust)
   - `empirical-heuristic` — model unknown but tokens > 200k, so it must be a 1M variant (trust)
   - `unknown-model-fallback` — **⚠ model unknown, tokens ≤ 200k, defaulted to 200k; `percentUsed` may be artificially inflated**

Reactive heuristic alone (>200k tokens → assume 1M) doesn't help below the threshold, so the flag is the load-bearing safety net for future frontier models: `percentUsed` is still returned, but the source tells the consumer whether to trust the ratio. Absolute `tokensUsed` remains reliable in every case.

### Tests

- 265 → 280 (+15 covering real-world sample parse, spend/extra-usage/per-model/codenames toggles, file I/O).

## [0.7.6] — 2026-06-30

### Changed

- Role-skill documentation update: expanded the cross-role "confidence without substance" guidance in the bundled role playbooks with a further worked example. No code changes; skill content only.

## [0.7.5] — 2026-06-30

### Changed — `claude-bridge-role-manager`: post-compaction recipe

Added guidance for re-onboarding a role after a context compaction:

- **Worker peers** re-align against durable artifacts (locked docs, code). The standard recipe (`peer_list`, `peer_inbox_read`, reload canonical docs) is enough.
- **Managers / orchestrators** also need the live thread: who is waiting on what, the intent behind decisions, the cross-cutting view. That lives in the conversation, not the docs, so docs alone are insufficient.
- A low `/context` percentage right after a compaction is a warning sign that only a lossy summary was loaded. A compact summary is for orientation, not for reasoning; load the full material before deciding.

A shared post-compaction self-check ("is real material in my context, or just pointers to it?") was added to both bundled role skills.

No code changes; skill content only. Tool set unchanged (13 tools, same APIs).

## [0.7.4] — 2026-06-30

### Fixed — `peer_context_status` undercount for fresh / post-clear sessions

`peer_context_status` significantly undercounted token usage for sessions that had recently gone through cache invalidation (after `/clear`, autocompact, or session start), in some cases reporting a few percent when the real figure was over 80%.

- **Root cause:** v0.7.0–v0.7.3 read `cache_read_input_tokens` alone. That works for mature cached sessions where `cache_read` dominates, but in a freshly filling cache most input lands in `cache_creation_input_tokens` while `cache_read` is tiny, so the reported percentage collapsed toward zero.
- **Fix:** `tokensUsed = cache_read + cache_creation + input + output` — the total tokens in the context window after the last assistant turn. This matches `/context` across both fresh and mature sessions.

### Tests

- 263 → 265 (+2 covering the full-formula sum and missing-field handling).

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

Two role playbooks for multi-chat orchestration now ship with the plugin:

- **`claude-bridge-role-manager`** — a playbook for an agent orchestrating 2–N worker peers. Covers dispatch patterns, gating by reversibility / blast-radius / outward-facing impact, verify-don't-guess, treating worker output as data rather than authorization, hub-and-spoke contracts plus mesh consults, handling crossed async messages, a FREEZE-at-ready-for-gate convention, and managing upward to the human. A detailed PLAYBOOK.md adds dispatch templates, pre-flight downstream isolation, anti-patterns, cross-machine handoff, and peer-death recovery.

- **`claude-bridge-role-memory-keeper`** — a lighter playbook for a dedicated memory-keeper peer in teams of 3+. Five principles (single-writer / route-to-keeper, pointer-not-duplicate, doc-wins-on-conflict, verify-before-write with dedup across senders, reconcile after each coordination round) plus the write and reconcile workflows.

### Changed

- **Bundle rebuilt** so the self-read fix from v0.6.1 actually ships (the published bundle had been stale).

- **Naming convention documented** (`docs/NAMING-CONVENTION.md`) — MCP tools are snake_case; skills use `claude-bridge-role-*` for role-based playbooks and `claude-bridge-*` for operational ones.

- **`claude-bridge` skill updated** — removed stale references to the `self_read` error (removed in v0.6.1).

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

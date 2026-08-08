# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — development channel

_Nothing yet._

## [0.11.6] — 2026-08-08

### Typing into a terminal that belongs to a person

The control plane delivers some things by typing them: `/compact`, a wake
prompt. Until now it typed on top of whatever was already in the box. Someone
starts a sentence, walks away, the daemon arrives — and Enter submits the two
glued together. The human loses the thought; the peer gets a command with a
stranger's words on the front.

Zdeněk's instruction, 2026-08-07: clear first, then send — and put it in the
tool, not in the callers, because a rule each caller must remember is a rule
that holds until the next caller. It now lives in `TmuxDriver.sendKeys`, which
every injection goes through.

**Everything below was measured before it was written**, against Claude Code
v2.1.224 in tmux on a 188-column pane. Three of the measurements contradicted
what the author believed at the time, and one of them turned out to be a defect
that was already shipping.

#### One `C-u` was never going to be enough

`C-u` kills to the start of the display ROW, not of the input. A 4971-character
draft lost exactly 184 characters per stroke — pane width minus the box frame.
`Escape` does not clear the box at all.

So the literal reading of "clear the line first" would have deleted one visual
row of a wrapped draft and appended the payload to the remainder — the exact
harm the instruction exists to prevent. The clear now loops, in batches, and
terminates on an exact condition: box content always begins on the `❯` line and
shrinks from the bottom, so that line is empty if and only if the box is.

**If the line cannot be cleared, nothing is typed.** A draft we cannot clear is
a draft we would corrupt.

#### The human's work was never in danger — only their knowing about it

Claude Code keeps its own kill ring. `Ctrl+Y` restores a `C-u` exactly, survives
an intervening payload, an Enter and a completed agent turn, and **composes**:
402 characters cleared by twenty strokes came back whole on one press.

The author had argued at length that this feature would destroy human work. It
does not. What it does is make a person's text vanish without telling them, so
displacement is now announced on two channels — a `display-message` for whoever
is sitting there, a `peer_input_displaced` event for whoever comes back in an
hour. Neither is enough alone.

The notice is deliberately NOT folded into the payload. `/compact` takes free
text as its compaction instructions, so a sentence meant for a person would have
silently steered what the peer kept. **Payload belongs to the application,
notices belong to the human, history belongs to the log.**

#### Fixed: delivery could not be verified for payloads over ~190 characters

`paneContains` collapsed whitespace to single spaces before matching. tmux wraps
a long payload by putting a newline INSIDE it, and a collapsed newline is a
space the payload does not have.

Measured: the old rule rejected payloads of 200 and 400 characters that had
arrived perfectly, while accepting 300, 500, 600, 700 and 800 — passing or
failing according to where the wrap landed relative to the 40-character tail. A
verification layer whose verdict depends on the reader's terminal width is not a
verification layer. It now strips whitespace instead of collapsing it.

#### Payloads that cannot be delivered honestly are refused up front

- **Multi-line** — tmux turns every `\n` into Enter, submitting the payload in
  pieces.
- **Over 800 characters** — Claude Code collapses the input into a
  `[Pasted text #N]` placeholder. Measured by bisection: 800 lands literally,
  801 does not. This is decided by the arrival burst, not by bracketed-paste
  markers, so raw `send-keys` trips it exactly as a paste does — which is the
  opposite of what was argued before measuring. The text is not lost; the PROOF
  is, after which the send throws, Enter is never sent, and the payload sits in
  the box for the next caller to prepend to.

Both are checked before any tmux call, so a refused payload leaves the pane
exactly as it was found.

#### Also

- Text is sent with `-l --`. Without them a payload spelling a key name
  (`Enter`, `Tab`) is pressed rather than typed, and one starting with `-` is
  parsed as a tmux option. No caller trips this today; the point is that none
  can.
- The displaced draft is recorded exactly. Claude Code word-wraps its box and
  the space it breaks at survives in neither row — the captured pane does not
  contain that character at all — so rows are rejoined by width: one that
  stopped short was broken at a space, one that ran the full width was broken
  mid-word. Verified live against a 377-character draft containing both kinds
  of break.
- `peer-compact.ts` claimed to hold "the only send-keys path in the daemon". It
  stopped being true when `wake.ts` gained one, and nobody noticed, because the
  sentence was load-bearing for a charter §8 audit point and was maintained by
  memory. The count now comes from a `grep` the comment spells out.
- New: `docs/SEND-KEYS.md` — the measurements, the sequence, and the two limits
  this layer imposes. `docs/KNOWN-LIMITATIONS.md` gains the payload ceiling and
  the fact that box detection depends on one Claude Code character.

## [0.11.5] — 2026-08-07

### Not knowing is not the same as knowing it died

`peer_spawn` destroyed a session on the strength of an answer that could not
tell four different things apart. `readSessionPid` was `catch { return null }`:
an absent target, a five-second timeout, tmux failing to run, and unparseable
output all produced `null`, and `null` meant "the command exited immediately".
The handler answered by deleting the record and killing the session.

So a transient hiccup killed a peer that may have been running perfectly — and
took the pane with it. The pane is where the explanation lives. That is why the
failure reported at 07:05:59 could not be reproduced afterwards: seven attempts,
seven successes. **The tool tidies away exactly what an investigator needs.**

The probe now answers with three outcomes, not two:

- `pid` — something is running, here is its id
- `no-such-target` — the host states the session is not there. A fact.
- `unavailable` — we could not find out. Ignorance, and it used to be reported
  as the fact above.

The distinction is drawn from tmux's own TEXT rather than its exit status,
because tmux exits 1 for everything: a missing session and a broken socket are
indistinguishable by status alone. Every outcome carries the raw output — a
category tells you which box the failure fell into, only the raw text tells you
what happened.

Unknown cases fall towards `unavailable` deliberately: **mistaking a dead pane
for an unreachable one costs a retry; mistaking an unreachable one for a dead
pane costs a live peer.** When a default has to be chosen, choose the side where
being wrong is cheaper.

On `unavailable` nothing is destroyed. The record stays with `status: "unknown"`,
the session stays standing, and the error names the pane to inspect and hands
back what the host actually said. `team_reconcile` — which can measure again,
repeatedly and at leisure — decides.

Two cases guard the other edge, because a fix that overshoots is just a
different defect: `no-such-target` is still torn down, and a driver that reports
no probe at all still fails closed. Absent evidence is not evidence of
unavailability.

### The invariant

> **When you are not sure, do not destroy. Mark it, and hand it to the layer
> that can look again.**

It arrived independently in two domains within 24 hours — `windowIndex` (declare,
measure, do not assert) and now `peer_spawn` (cannot tell if it is running →
leave it standing). Two independent arrivals is what turns a decision about two
tools into a rule.

Tests 250 daemon (from 245), 402 MCP.

## [0.11.4] — 2026-08-07

### A test suite may not write outside a temp directory

At 06:37 a new test file went in without the `vi.mock("node:os")` homedir
isolation the other 34 files in that suite carry. `handleControlConfig`
persists through `applyStateChange` → `saveState` → `stateFilePath()`, which
resolves under `homedir()`. Five runs of the suite overwrote the live
control-plane registry, replacing 23 real peers with a fixture holding one
imaginary one.

Nothing failed. Every test stayed green. The fleet kept working, because
processes and tmux sessions do not depend on the registry — the loss surfaced
only because someone read a peer count afterwards.

The per-file mock is the right thing to write and it had been written correctly
34 times. That is exactly why it could not be the safeguard: a convention held
in memory fails the first time somebody is quick, and this failure was silent
and landed on the operator's machine. So the rule moved into `atomicWrite`,
where forgetting is not an option — under `VITEST`, a write outside `tmpdir()`
throws, and the message names the path and the likely cause.

Six cases prove the guard fires, because a guard nobody has watched fire is a
guard nobody should trust. One of them asserts that `VITEST` is set at all: a
safety test that passes vacuously is worse than none.

### The recovery window that closed quietly

Worth recording next to the fix. The tests destroyed the registry on DISK
between 06:37 and 06:44, while the running daemon still held all 23 peers in
MEMORY. Any daemon-side write would have restored them. At 06:45:10 a routine
restart — deploying the previous release — loaded the one-peer disk state and
discarded the memory.

For eight minutes the loss was reversible by a process nobody thought to ask.
After an incident, establish who still holds the truth before touching anything
that is running.

Recovery itself went through the tools rather than around them: `team_adopt`
rebuilt every team from reality, `team_release` dropped the fixture without
signalling its process, and the result was verified field by field against the
live tmux server — 23 records, 23 windows, matching ids, pids, teams and
labels, reconcile clean.

Tests 245 daemon (from 239), 402 MCP.

## [0.11.3] — 2026-08-07

Day one of the soak week. Everything here came out of writing the edge-test
matrix rather than out of running it — describing what a case SHOULD do is a
cheap way to notice that nobody had decided.

### An ack from a previous request was accepted as this one's answer

`pollForAck` tested one thing: does the file exist. Not when it was written,
not what it was for.

Measured on the live fleet 2026-08-06 — a run at 06:39 timed out at 06:41, the
peer finished its anchor at 06:41:39 and touched the ack anyway, and the next
run at 06:43 found that file and injected `/compact` in the same second. It read
as a success. Nobody had confirmed the anchor belonged to that request. A tool
whose entire purpose is to refuse a compact without a fresh anchor was accepting
a stale one.

The case had been filed in the matrix as "behaviour unknown". It was a defect.

Two mechanisms, closing different holes:

- **the sweep** — any ack already on disk is moved aside BEFORE the request is
  written, so everything appearing afterwards is fresh by construction. Stronger
  than comparing timestamps, because an empty directory needs no reasoning about
  clocks. The daemon also sweeps every leftover at startup, for the ack a
  crashed predecessor left behind.
- **the verdict** — catches what the sweep cannot: an ack that is recent but
  answers a different `threadId`, which is what two concurrent compacts on one
  peer produce. A bare `touch` is still accepted on freshness alone; the
  playbook has always said to touch the file, and refusing that would break the
  documented path to close a hole the sweep already closed.

`anchor_timeout` now says WHICH of the three happened — no ack, an ack that
predates the request, an ack for another thread. They lead to different next
steps, and for two days the tool reported only "the peer is not answering"
while the others were happening.

### The invariant that explains why there is no idle check

Written into the tool, verbatim: **the ack is itself the proof of idle.** A peer
only reaches its inbox between turns, so a peer that acked was by construction
not mid-generation. `peer_compact` therefore never injects into a running turn
without having to observe anything — which matters, because "idle" is not
reliably observable from outside. A busy peer simply does not answer and the run
ends in `anchor_timeout` with nothing injected. That is the correct outcome, not
an unhandled case.

### `team` is no longer settable

It looks like a field and behaves like an operation. Declaring a new team leaves
the record inconsistent in three places this tool cannot fix: `homeSession`
still names the old team so the next restart puts the peer back in the old tmux
session, the window does not move, and the derived label stops matching — which
is the exact regression v0.11.2 spent a release cleaning up. Moving a peer
between teams is lifecycle work and belongs with `team_adopt` / `team_release`.

### `unset` — withdrawing a declaration, which is not the same as emptying one

`control_config` could declare a value and never take it back. That mattered
more than it sounds: an UNDECLARED `windowIndex` reports no drift wherever the
window sits, while a declared one that disagrees with reality does. So "nobody
has said" and "somebody said nothing" are different states, and `set: {k: null}`
cannot express the first.

`unset: ["windowIndex"]` removes the key. Overloading `null` would have folded
the two together — the same conflation, one level up, that this release series
exists to undo.

### And a note about a version number

The guard-key prohibition in `control_config` cited v0.11.1 as the release that
would unify the three setter write paths. v0.11.1 came and went on other work.
The note now binds the condition to the WORK rather than to a number, so a
slipped version cannot be read as permission.

Tests 239 daemon (from 221), 402 MCP.

## [0.11.2] — 2026-08-06

### Fixing the writer did nothing about what it had already written

v0.11.1 corrected the label computation and made an explicit `label` outrank the
derived one. Both changes are right, and together they left the fleet exactly as
broken as before: v0.11.0 had already stored the fully qualified name AS the
label, so the stored garbage now outranked the correct derivation.

Measured on the etl canary at 17:24, after deploying the fix — windows still
`etl-dev`, `etl-velitel`. The fix would have been reported as working by anyone
who checked the code instead of the windows.

Correcting the code that writes a value and correcting the values already
written are two jobs. It is easy to believe the first is both, and the belief
survives right up until someone looks.

`revokeDerivedLabels` clears them once, on an exact signature: a label identical
to the fully qualified name of a peer that HAS a team prefix is what the broken
path produced and what the correct path never would. A deliberately chosen short
name, a team-less peer, a name that does not carry its team prefix — all
untouched.

### One-time repairs are now a list

Two of them arrived within two hours, and there will be more. `repairsApplied`
records them by id. These are not `stateVersion` migrations: the shape does not
change, only whether a value written by an older daemon can be believed. Version
numbers answer "can I read this"; repair ids answer "should I trust this".

Tests 221 daemon, 402 MCP.

## [0.11.1] — 2026-08-06

Two defects found in the v0.11.0 fleet roll, minutes after it finished, by
looking at what the roll had actually produced rather than at whether it had
reported success. It reported success. Both defects are in `peer_restart`,
building its spawn request from an incomplete reading of the record.

### The windows renamed themselves back

All 22 rolled peers came back as `ai-kb-dev` rather than `kb-dev`. `peer_spawn`
labels a window from `windowLabelFor(displayName, team)`, and `peer_restart`
never passed a team — so the label fix shipped the day before held only until
the first restart.

That fix covered `team_layout` and direct spawns and left the restart path
alone, where it sat unnoticed because nothing had restarted through it since. A
fix applied at some call sites is a fix the untouched site will undo, and the
untouched site here was the one a fleet roll uses.

An operator's declared `label` now also wins over the derived one, and the
window name comes from the same value the record stores rather than a second
derivation of it — computing it twice is how the two get to disagree.

### A restart stamped a provenance it had not earned

Every one of those 22 records then claimed `harvestedAt` = the restart time, for
an environment sampled at adoption the previous day. `peer_spawn` stamped
whenever it was handed an `envBase`, and a restart hands it values copied out of
the record. The carry-forward guard only fired when a previous stamp existed —
and records migrated out of v1 deliberately had none.

So the release built to stop measurements masquerading as intent invented a
provenance, using the field written to prevent exactly that, within hours of
shipping it.

The rule is now stated at the field and enforced at the boundary: **a stamp is
written only by a fresh harvest from something live. Passing stored values from
one record to the next is a copy, and a copy never earns a stamp.** Empty stays
empty across any number of restarts, because "we do not know when this was read"
does not become knowledge by being carried further. `peer_spawn` takes an
explicit `envHarvestedAt` with three distinguishable states — absent (fresh
harvest, stamp it), a string (carried, provenance known), `null` (carried,
provenance unknown).

### Every stamp written before this release is revoked, once

No earlier daemon could tell a harvest from a copy, so no stamp one wrote says
anything about when those values were read — only about when they were last
passed around. A one-time pass clears them all and records that it ran.

The revocation is by writer capability, not by timestamp window. Clearing
"stamps written between 17:06 and 17:09" would have fixed this fleet and left
the principle unstated. Empty is the honest value: a wrong timestamp is worse
than none, because it invites the "this looks fresh" reasoning the field exists
to prevent.

### On the tests

The first draft of the regression tests asserted against a helper that rebuilt
the spawn arguments the way the handler does. It would have passed against the
broken handler, because the hole was in the handler. Rewritten to drive the real
`peer_restart` and inspect what reaches the driver — a test written beside the
code checks what the code does; only a test written where the caller stands
checks what it should do.

Tests 220 daemon (from 212), 402 MCP.

## [0.11.0] — 2026-08-06

### A peer record now says whether it is a plan or a photograph

Every incident of 2026-08-05 was one defect wearing five hats: a value that had
been MEASURED, later replayed as a value that had been INTENDED. `spawnEnv` was
harvested from a live pane, frozen, and handed to every later relaunch as though
someone had asked for it. `homeSession` drifted at rename. Window names had no
field separating the identity from what is painted on the tab.

A flat record cannot express that difference, so it was carried in people's
heads, and people forget. `PeerRecord` is now `{ sessionId, desired, observed }`:

- **desired** — what an operator declared. Only the config path writes it. This
  is what a restart replays.
- **observed** — what the daemon measured. Never replayed as intent, and it
  carries `harvestedAt` when it was sampled from somewhere that can go stale.

`sessionId` belongs to neither: it is true whether or not anyone is looking.
Adding a field now requires deciding which kind it is, because the type will not
compile otherwise. That is the whole point — the rule is enforced by the
compiler rather than by memory.

`model` lands in both halves, deliberately. It is the one field that genuinely
serves both roles, and picking a side would have silently changed restart
behaviour for the entire fleet. `peer_restart` reads `desired.model` first and
falls back to `observed.model`, so a stated intent wins and a peer whose model
was switched at runtime is still not downgraded.

### A version bump would have discarded the fleet

`loadState` handled `stateVersion` older than the daemon by returning
`emptyState()`. It had never fired, so the cost stayed invisible: raising the
version today would have thrown away 23 adopted peers, and the daemon would have
come up looking healthy and empty.

There is now a real migration, it writes a timestamped backup of the original
before touching anything, and an unknown older version refuses to start rather
than wiping state. An operator can restore a backup; nobody can recover a
registry that was silently emptied at boot.

Verified against the live fleet before release: 23/23 peers, 391 field
comparisons, no value lost and none invented. `harvestedAt` is deliberately left
undefined on migrated records — we do not know when those values were sampled,
and stamping them with the migration time would manufacture exactly the kind of
provenance this release exists to prevent.

A stamp that disagrees with its content no longer crashes the daemon either.
A document labelled v2 holding v1 records made the load-time repair dereference
`observed` on undefined, taking the daemon down for the whole fleet at startup —
the one moment nobody can intervene. The content is checked instead of trusted.

### control_config — one tool for declaring intent

Zdeněk, 2026-08-05: *"ať nevymýšlí N dalších nástrojů do MCP, máme jich dost."*
The constraint is the design. A control plane grows one setter per knob if you
let it, each with its own validation and its own idea of what a dry run means.

`control_config` reads and writes the declared half of a record over a whitelist
(`label`, `windowIndex`, `model`, `accountProfile`, `team`), records every change
in `events.jsonl` with what it changed FROM, and supports `dryRun` on every call
rather than only the dangerous ones. It cannot write `observed` — an operator
must not be able to declare a peer alive. Destructive lifecycle operations stay
in `peer_stop` / `peer_restart` / `team_stop`; a tool that can both rename a
window and kill a fleet is one whose dry-run flag has to be right every time.

The behaviour lives in the daemon. The MCP tool is a schema and a forward, and
`claude-bridge-daemon config …` is the same function from a shell — for cron,
for scripts, and for a human whose Claude Code will not start. The CLI submits
an RPC request rather than editing `state.json`, because the daemon is that
file's single writer and a second one would race it on every call.

### `label`, and a windowIndex that is recorded rather than enforced

`desired.label` holds the short display name; `observed.name` remains the fully
qualified identity that routing and name-based resume depend on. Until v0.10.20
there was no such field, so `windowLabelFor` was called at each site that
painted a window and the sites that forgot painted the FQN.

`desired.windowIndex` is **stored, and drift is reported. No window is moved.**
Asserting it would make reconcile a writer against a surface a human also edits,
and a control plane that silently undoes a deliberate drag is the same defect
inverted — intent passed off as observation. The assertion lands in v0.11.1
behind an explicit opt-in.

Every drift entry carries both values and both ways out: `assert` (make the world
match the registry) and `adopt` (accept reality as the new intent). Naming only
the first tells an operator who moved a window on purpose that they were wrong,
and often reality is the newer information. `team_reconcile` now measures where
windows actually sit, and reports `windowIndexDrift` separately from the drift
that gates a fleet roll — folding a cosmetic disagreement into that count would
train an operator to ignore both.

### Deferred to v0.11.1, deliberately

The vscode/cursor projection adapter, the assertion half of `windowIndex`, the
verified `/model` switch, `homeSession` deprecation, and folding the three
`peer_set_*` guards onto one write path. Each touches the world or crosses a
package boundary; none belongs in the same release as a schema migration under
23 live peers. One risky change per release — when two ship together and
something breaks, you do not know which.

## [0.10.21] — 2026-08-06

### The wake message had the same defect, and it had it alone for longer

`wake.ts` built its envelope by hand and wrote it with a raw `atomicWriteJson`,
disagreeing with `MessageEnvelopeSchema` in the same five ways v0.10.20 fixed in
`peer-compact.ts`. `readEnvelope` `safeParse`s and returns null, so the peer's
inbox never listed it.

Waking therefore only ever worked by half: the key injection made the peer take
a turn, while the message saying WHY it had been woken was silently absent —
including the warning that its previous stop was forced and its anchor may be
mid-write. That warning is a safety instruction, and the sender believed it had
been given.

Two hand-rolled inbox writers, both wrong in the same five ways, is not two
accidents. Nothing writes into a peer's inbox except `writeEnvelope`, which
`parse`s and so fails at the writer rather than vanishing at the reader.

The payload is now text rather than a structured object, because the recipient
renders it as text — fields only a parser would reach were part of how this went
unnoticed for months.

A test had been asserting the broken shape as the contract. It looked for
`kind === "peer-wake"` and read `content.warning`, and passed all along on a
message no recipient could read. Rewritten rather than deleted, with the reason
in the file: it asserted the implementation it was written beside instead of the
requirement, and so held the defect in place.

### A window carries the short name, the record carries the full one

`peer_spawn` passed `displayName` straight through as the tmux window label, so
`mic-tester` got a window called `mic-tester` — the team prefix repeated on
every tab, inside a session already called `mic`.

The strip happens at the one call site that names a window, not in the driver.
A driver cannot tell a prefix that came from the convention from a name a caller
chose deliberately, and would shorten both; the team is known at the call site
and nowhere below it.


## [0.10.20] — 2026-08-06

### `peer_compact` had never once completed

The daemon built its anchor request by hand and wrote it with a raw
`atomicWriteJson`. That object disagreed with `MessageEnvelopeSchema` in five
places at once:

```
from     {sessionId, name}          expected a string
to       {sessionId, name}          expected a string
sentAt   absent                     the field was called `ts`
content  {instruction: "..."}       expected a string
kind     "compact-anchor-request"   not in the enum
```

The recipient reads its inbox through `readEnvelope`, which `safeParse`s and
returns null on failure, so `listPending` simply did not include the file. The
write succeeded, the watcher fired, the push pump ran, and nothing was
delivered — with no error at either end. Every run since v0.10.0-rc ended in
`anchor_timeout`, which reads as "the peer is not answering", and that is how
three people read it across two days: a deaf peer, an open TUI dialog, a
dropped `--channels` flag. Each was measured and disproved. Nobody looked at the
envelope, because nothing pointed at it.

The daemon now writes through `writeEnvelope`, which is the fix and the guard
at once: it `parse`s rather than `safeParse`s, so a malformed envelope throws at
the writer instead of vanishing at the reader. The writer knows what it meant;
the reader only knows that something did not fit.

A contract test holds the gap task #65 warned about — shared and the MCP server
are contract-tested against each other, but the daemon writing directly into an
inbox was not covered by either.

### The anchor timeout was set for work nobody had watched

With delivery fixed the peer still missed the window. First honest measurement:
request at 06:39:37, ack at 06:41:39 — **122 seconds**, on a peer that started
immediately. The default was 30.

That number was never tested against the real task, because no run had ever got
far enough to reach it. A peer is not pressing a button: it reads the request,
writes a compact anchor meant to survive the loss of its own context, and only
then touches the ack. Minutes, not seconds. Default raised to 300 s.

Verified end-to-end on a live adopted peer at 88% context:
`peer_compact_anchor_requested` → `peer_compact_inject` → `peer_compacted`,
with `/compact` visible in the pane.


## [0.10.19] — 2026-08-05

### Half a naming convention is worse than none

v0.10.18 taught the daemon to resolve a peer name like a hostname — full name,
then the short form inside the caller's team, then a globally unique short form.
Only the daemon learned it. The MCP server kept matching on the full name alone,
so the same word got two answers depending on which tool you reached for:

```
peer_restart velitel        ambiguous_peer — mic-velitel, plt-velitel, etl-velitel
peer_context_status velitel peer_not_found — and a list of twenty-three names
```

Found by running the tools against the renamed fleet. The suite was green
throughout, because nothing exercised the MCP resolver with a short name — the
convention was ratified and implemented on the same day, and the tests were
written where the code was, not where the users are.

`resolveTargetPeer` now performs the same four steps, and `peer_context_status`
— which had grown its own copy of the matching — calls it instead of repeating
it. Under the convention a peer's own team is the prefix of its own name, so the
caller carries its search domain in its identity and no new state is needed.


## [0.10.18] — 2026-08-05

### A duplicated peer name was resolved by picking the first match

Every lifecycle handler looked a peer up with
`Object.values(peers).find((r) => r.name === key)`, and `find` returns the first
one it meets. Names were never unique: the live fleet held two peers called
`admin` and two called `velitel`, because adoption before v0.10.15 took the name
from the tmux window, and windows are named per team.

So `peer_restart peer:"velitel"` stopped and respawned whichever record was
enumerated first — a destructive action on a silently wrong target, with nothing
in the result to show it. `team_restart` compounds it: it orders "velitel last"
by matching the name, so a duplicate skews the ordering a rollout depends on.

`team_adopt` already refused to guess in this exact situation, and said why —
"guessing would launder it". `peer_stop`, `peer_restart`, `peer_compact`,
`team_restart` and `team_release` now hold the same policy, from one resolver.

### Peer names resolve like hostnames

Ratified by the owner the same day: short names inside a team, fully qualified
names globally, and a collision forces the qualified form.

```
1. session id                    unique by construction, always wins
2. full name                     mic-velitel, unambiguous anywhere
3. short name, caller's team     velitel asked from mic means mic-velitel
4. short name, globally unique   tester, from anywhere
5. short name, several matches   refused, and the full names are named
```

Step 3 is the search domain, and it needs no new state: the request envelope
carries the caller, and the caller's record carries the team.

A fleet that does not follow the convention loses nothing. Where a name does not
carry its team prefix there is simply no short form, and only the full name
resolves — the same as a host with no domain suffix to strip.

The `ambiguous_peer` message offers the full names, not session ids, because
that is the answer the convention exists to give. Ids appear only when two peers
share a full name, where nothing else can separate them.

### A pushed message and an unsent one looked identical on disk

`pending/` means "not confirmed seen by the agent", not "not delivered". That is
deliberate — push is best-effort, and consuming on protocol success would lose
every message Claude Code never rendered — but it left the two states
indistinguishable, and the record of which was which lived in a `Set` for the
lifetime of one process.

It cost two peers hours on 2026-08-05: one diagnosed a peer as deaf from a file
in `pending/` that had been delivered and answered, and hours later so did
another, on a different peer. Of nineteen decidable pending files across the
fleet, seventeen had been delivered.

A push now leaves a note in `inbox/<peer>/pushed/<msgId>.json`, cleared when the
message is archived. It is provenance and nothing else: re-pushing after a
restart stays correct, because a push is still not evidence the agent saw it.

Written to a sidecar rather than into the envelope because rewriting a file in
`pending/` races with `consume` renaming it away, and the loser of that race
resurrects a message that was already archived.

`peer_list` reports `pending` and `pendingNeverPushed` per peer. The second is
the one worth chasing; the first, alone, never meant what it looked like.

## [0.10.17] — 2026-08-05

### `peer_compact` could not reach a single adopted peer

`sendKeys` was the last method still running its target through
`sanitizeSessionKey` instead of `parseHostTarget`. `@` is in
`UNSAFE_TARGET_CHARS`, so a window id was rewritten before tmux ever saw it:

```
target @1011  ->  tmux send-keys -t _1011  ->  can't find pane _1011
```

Every peer on the live fleet is keyed by window id, so this was all
twenty-three of them. It went unnoticed because peers the daemon spawns itself
get name-shaped keys, and those are the ones the tool was piloted against —
the same shape mismatch as the v0.10.6 window-target work, in the one method
that release did not touch.

A window id is canonical by construction and must pass through untouched;
`parseHostTarget` already knew that and `sendKeys` was not asking it.

## [0.10.16] — 2026-08-05

Peers relaunched by the daemon came up monochrome, and one of them was telling
everybody it lived in a pane that had been destroyed hours earlier.

### One allowlist was answering two different questions

`TERM`, `TMUX` and `TMUX_PANE` describe the **pane**, not the process in it.
They belong in `BASE_ALLOWLIST` — a peer needs all three to run — and they were
also being written into `PeerRecord.spawnEnv`, which outlives the pane it was
harvested from. The same list was serving "what may this peer carry" and "what
may be stored", and the second question has no stable answer.

Measured across the live fleet on 2026-08-04: `kb-ops` was harvested in pane
`%71`, relaunched into `%1011`, and kept `TMUX_PANE=%71` — a pointer to
something already gone. Twenty-one of twenty-three records had no `TERM` at
all, because the harvest that produced them ran against peers the v0.10.13
outage had already stripped.

Neither is reachable by editing the allowlist: `TERM` was in it the whole time.
Harvest and spawn are now separate — `harvestEnv` for what gets stored,
`sanitizeEnv` for what a process starts with — and records written by earlier
versions are repaired on load, because `spawnEnv` is captured once and replayed
by every later restart, so a bad value never expires on its own.

### `env -i` was discarding what tmux had set

The obvious fix — "drop them at harvest, tmux sets them itself" — was wrong,
and measuring it was the only way to find that out. tmux does set all three
for a new pane, but `env -i` runs **as** the pane's command and clears the
environment tmux prepared. Same pane, spawned both ways on tmux 3.4:

```
with `env -i`   PATH, HOME and nothing else
without         TERM=tmux-256color, TMUX=…, TMUX_PANE=%1029
```

So dropping them without replacing them would have swapped a wrong `TERM` for
no `TERM`, and quietly taken `TMUX` with it — a `tmux` command run inside a
peer could no longer find its own server.

The pane's own first command is the only process that knows the right answers,
so that is where they are read now: `sh -c` still holds what tmux set, restates
the three values on the `env -i` command line, and `exec`s, leaving no shell
between tmux and the peer so `pane_pid` still points at the peer itself.

## [0.10.15] — 2026-08-04

Two findings from the recovery of the v0.10.13 outage. Both were worked around
by hand at the time; neither should need a hand next time.

### Adoption took the label off the window instead of the peer's own name

tmux names a window after its command, so after the outage every window read
`claude`. Adoption reads the window name as the peer's name — so re-adopting
would have called all twenty-one peers `claude`, taking their identities with
it, and `team_restart`'s velitel-last ordering matches on the name. plt-designer
renamed twenty-one windows by hand before adopting, which is the only reason
the recovery ordered correctly.

The bridge registry already knows what each peer calls itself. Adoption now
takes the name from there, keyed on the session id it has already discovered,
and falls back to the window label only for a peer that never registered. A
peer's own claim about its identity beats a title somebody typed.

### `team_reconcile` accused the host of holding a stranger

A pane's pid is often a **shell**, with the peer as its child. Reconcile
compared the pane pid against the record's pid directly and reported
`pid_changed` — the drift kind it calls the dangerous one — for every peer
behind a launcher script. Two false alarms on the live fleet, on the only two
peers nobody had restarted.

Adoption already descends the ancestry to find the peer inside a pane;
reconcile now does the same before deciding the host holds someone else. When
the ancestry cannot be read it says nothing rather than accusing: a false
`pid_changed` sends an operator hunting a peer that is exactly where it belongs.

Tests 554 (+4), each verified by restoring the old behaviour. The reconcile fix
has a second test proving it did not also silence the real `pid_changed`.


## [0.10.14] — 2026-08-04

### Re-adopting a peer broken by v0.10.5 would have baked the breakage in

Found while preparing the recovery from the v0.10.13 outage, before running it.

v0.10.13 has adoption harvest the peer's own environment. For a peer already
relaunched with the daemon's `PATH`, that environment **is** the daemon's
`PATH` — so re-adopting the twenty-one broken peers would have recorded the
poison as if it were the cure, and the re-roll would have reproduced the
outage. Measured on the live fleet: the restarted peers carried a stock `PATH`
with no nvm while the two untouched ones still had the right one.

The remedy is derivable rather than guessed. `claude` lives in nvm's `bin`
directory and so does the `node` it needs, so the directory holding the
resolved command is exactly the one that must be on `PATH`. Adoption now
prepends it: no change for a healthy peer, repair for a poisoned one, and
nothing invented when the command is a bare name that says nothing about where
it lives.

Tests 550 (+3), verified by removing the prepend.


## [0.10.13] — 2026-08-04

### The relaunch environment came from the daemon, and took the fleet down

**This one caused an outage.** Twenty-one restarted peers lost their statusLine,
their hooks and their own MCP server at once — the whole fleet went
bridge-mute. Reported by plt-designer over tmux, because the bridge could no
longer carry the message.

v0.10.5 made a peer's environment explicit with `env -i`, which was right and
still is. Its **values** came from `process.env` — the daemon's — because that
was what was at hand. The daemon runs under systemd with a stock `PATH` and no
nvm, so every relaunched peer got a `PATH` without `node`:

```
statusLine → node not found
hooks      → fail
MCP server → cannot spawn  ⇒ the peer is bridge-mute
```

v0.10.11 resolved the peer's *command* through its own `PATH`, which fixed
`claude` and nothing else. The peer's environment as a whole was still the
daemon's.

**The whitelist decides which variables a relaunch gets. It was never supposed
to decide their values.** Adoption now captures the peer's own environment from
`/proc/<pid>/environ`, filters it through the same whitelist, and stores it as
`PeerRecord.spawnEnv`; a relaunch builds from that. Same names, right values.

The filter is unchanged and tested as such: a peer carrying
`ANTHROPIC_API_KEY` hands over its `PATH` and not its key. Changing where the
values come from must not reopen the billing incident v0.10.5 closed.

### Windows are named after the peer

tmux names a window after its command, so every peer's window read `claude` and
nobody could tell them apart. Noticed by the owner while the fleet was down.

Tests 547 (+2), verified by restoring the daemon's environment as the source.


## [0.10.12] — 2026-08-04

### A record that outlived a failed restart still claimed to be live

v0.10.11 kept the record when a restart failed, so an operator had something to
retry. It kept it saying `status: "live"` with the pid of the process that had
just died.

The restore ran only in the spawn-error branch. This failure happens later — on
the liveness check — and by then `peer_spawn` has already written a fresh
`live` record with the new pid. Keeping the row was right; keeping its claim
was not.

Every failure path after a successful spawn now marks the record `unknown` with
no pid: the liveness failure, and an identity mismatch too. The second matters
more than it looks — something *is* running there, just not the peer the record
names, so reporting it as that peer, live, would point every later lifecycle
call at a stranger.

`team_reconcile` caught it within seconds either way (`record is 'live' but pid
2902353 is not running`), which is why the pilot could continue. A net that
catches the fall is not a reason to leave the hole.

Tests 545 (+1), verified by removing the mark.


## [0.10.11] — 2026-08-04

Three findings from plt-designer's pre-rollout probe. All nine earlier findings
verified fixed in the same round; these came from asking a question none of the
pilots had asked.

Every sacrificial fixture so far used an **absolute** command. The whole fleet
runs a bare `claude`. That path had therefore never been exercised once, and it
is the one every peer takes.

### A bare `claude` does not resolve in the relaunch environment

Since v0.10.5 a peer's environment is built from nothing with `env -i`, using
the whitelist — whose `PATH` comes from the daemon. The daemon runs under
systemd with a stock `PATH` and no nvm:

```
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:…
$ env -i PATH=… which claude   →  nothing
```

The fleet records `command: "claude"` for all twenty-three peers, so **the
first peer of every group would have died and the roll would have stopped**.

Adoption now resolves `argv[0]` through the **peer's own** `PATH`, read from
`/proc/<pid>/environ` — by definition it knows where its own binary lives — and
records the absolute path. Unresolvable stays unresolved rather than guessed.

### A peer that was the only window of its session could not come back

Stopping the last window takes the session with it, so by relaunch time
`new-window -t <session>:` failed with "can't find session" and the peer was
simply dead with nothing to recover from. Every peer created by `peer_spawn` is
a single-window session, so this is the ordinary case rather than the exotic
one. A vanished home session is now recreated under the same name — not under
the peer's, which is the escape this release has already fixed twice.

### A failed restart lost the peer entirely

`peer_spawn` deletes the record when a spawn produces nothing, which is right
for a spawn: there was never a peer. For a restart there was, and dropping it
left an operator with nothing to retry — `team_release --team obetni2` answered
`team_not_found, knownTeams: []` and the peer had gone from the control plane
altogether. The record is now restored on failure as `status: "unknown"` with
no pid: kept, but not pretending.

Tests 544 (+5), each verified by restoring the old behaviour.


## [0.10.10] — 2026-08-04

### A peer whose window had already died still escaped its session

Found while testing v0.10.9 against the live host, in the fix shipped an hour
earlier.

v0.10.9 made `peer_restart` look up a peer's home tmux session **before** the
stop, which is right — but it looked it up from the live window. A peer whose
window had already gone (crashed, killed, exited on its own) had no window to
ask, so the lookup failed, the documented fallback fired, and the peer came
back as a session of its own. Measured: after a manual kill, `pw1` returned as
a standalone session `pw1` while the audit log dutifully recorded
`peer_restart_window_home_unknown`.

The warning was honest and the outcome was still wrong. On a fleet roll this is
not an edge case — it is every peer that died before its turn.

A peer's home no longer depends on its window surviving. `PeerRecord.homeSession`
is written at spawn and at adoption, when the answer is certain, and
`peer_restart` reads it from there. The live-window lookup remains only for
records written before this release.

Tests 539 (+1), verified by removing the record read: the case falls back to the
old behaviour and fails.


## [0.10.9] — 2026-08-04

Five findings from plt-designer's re-pilot of v0.10.7. Three of the five
v0.10.7 fixes were confirmed working; these are what the pilot found instead.

### The v0.10.6 window fix was written, shipped, and never ran

`peer_restart` looks up which tmux session an adopted peer lives in, so the
replacement can be created as a window there. The lookup sat **after** the stop
that destroys the window. It therefore found nothing every time, `inSession`
was always null, and every adopted peer was still relaunched as a session of
its own — `@652` in `obetni` came back as a standalone session `w1`.

Correct code in the wrong place is indistinguishable from no code, and only a
live pilot could tell. The lookup now runs before the stop, while the answer
still exists.

### A restart stripped the peer's provenance

`peer_spawn` writes a fresh record, so `team` and `adopted` did not survive a
restart: the pilot's restarted peer read `team: null, adopted: false` beside an
untouched sibling still carrying `team: "obetni", adopted: true`. A fleet roll
would have removed the team stamp from every peer it touched and left every
team-scoped operation with nothing to match on. Provenance is now captured
before the stop and restored after the spawn.

### `restarted: ok` over a corpse

A relaunch whose resume fails exits in about two seconds; tmux removes the
window and no session file is ever written. `spawn_produced_no_process` does
not see it — the process *did* start. The identity check found no session file
and, correctly, did not call that a mismatch — but it also let it pass.

"Absence of evidence is not evidence of absence" had to hold in **both**
directions. A restart now also confirms the process is still alive after a
settle, and that a peer which is supposed to register a session did register
one; failing either returns `restart_died_after_spawn`. Only Claude Code writes
a session file, so that half of the rule applies to `claude` and not to
whatever else a host might relaunch.

### `team_adopt` advertised an argument it refused

`hostSession` was in the tool's JSON schema and absent from the Zod validator
behind it, which rejected the key as unrecognised. I introduced it by running a
string replacement without checking that the pattern matched: it silently
changed nothing, and I reported the feature as delivered.

Fixed — and a **schema-parity test** now compares every daemon-backed tool's
advertised properties against its validator's accepted keys, printing the
offending names rather than a boolean. The two halves are hand-written in two
files, so drift is a question of when.

### `hostAlive: false` for peers that were plainly alive

`team_status` matched records against `listSessions()`, which reports tmux
SESSIONS only. Every window-keyed record — that is, every adopted peer — read
`hostAlive: false` while its window and its process were both there. Windows
are now folded into the lookup.

Tests 538 (+23), each verified by restoring the old behaviour. The liveness
check has two: one on the function and one on the handler, because a handler
that ignores a correct answer is exactly the failure this release opened with.


## [0.10.8] — 2026-08-04

### `peer_list.pid` named the wrong process

Reported as an aside in the v0.10.6 pilot and deferred by me as "a different
layer". That was a process reason, not a severity judgement, and the owner was
right to push back.

The heartbeat recorded `process.pid` — **this bridge server**, which is a child
of `claude` (`comm=MainThread`, parent `claude`). So the field every consumer
reads as "the peer" pointed at the bridge. Two consequences, and the second is
the serious one:

- Acting on it — inspecting, signalling, killing — reaches the bridge, not the
  peer.
- The server is replaced on every MCP reconnect, so a heartbeat can outlive its
  writer and name a **dead** pid. Linux reuses pids. Measured on the live fleet:
  1 of 26 heartbeats already pointed at a dead process; plt-designer saw
  2676018 where the peer was 1470502.

The peer's pid was always available: the bridge is spawned by Claude Code, so
`process.ppid` is the peer. `pid` now carries that, and the bridge's own pid
moves to `mcpServerPid` — present for diagnostics, explicitly never a lifecycle
target.

`team_reconcile` and `team_adopt` were unaffected: both read the process table
through `/proc` and walk ancestry, which is why the fleet reports stayed
correct while this field did not.

A heartbeat written by an older version keeps the old meaning until that peer's
server restarts. Heartbeats are rewritten every 5 s, so a peer converges as soon
as it reconnects — but a *stale* file from a dead server keeps the old semantics
indefinitely, which is exactly the case that was dangerous. The tool description
says so rather than leaving the reader to find out.

Tests 515 (+1), verified by making `peerPid()` fall back.


## [0.10.7] — 2026-08-04

Five findings from plt-designer's v0.10.6 pilot. Everything else the pilot
exercised passed and is unchanged — these are the parts that did not.

### An adopted peer lost its model

Real fleet argv: `kb-ops --model claude-opus-5`, `mic-velitel --model
claude-fable-5`. Adoption stripped `--model` from `spawnArgs` because
`peer_spawn` re-appends it — and then recorded `model: null`, so there was
nothing to re-append. Every adopted peer would have come back on the default
model.

Stripping is right; discarding is not. `--model` is now lifted out of argv into
`PeerRecord.model`, where `peer_spawn` finds it. `--resume` really is discarded:
the id it carries is the peer's own session, which the record already holds.

### Manual adoption produced records that could not be restarted

`mode: "manual"` matched the Claude process by `pid === panePid`. A pane's pid
is the **shell**; Claude is its child. Nothing matched, so every manually
adopted record had `command: null`, `spawnArgs: []`, `cwd: null` — adopted, and
unrestartable. Auto mode already walked the ancestry; manual now uses the same
walk.

### A restart could wedge a peer at an interactive prompt

`peer_restart` composed `--resume <record.sessionId>` unconditionally. For a
peer spawned under a stable name rather than a UUID — `obetni-w3` — that names
no transcript, so Claude Code opens its **Resume picker** and the peer sits
there waiting for a keypress. It then gets a fresh session id, and because the
pid still matches the record, everything downstream keeps reporting `live`
about an identity that has moved.

Two fixes, because either alone leaves half the problem:

- `--resume` is passed only for an id that names a transcript (a UUID).
- **The restart now verifies the peer came back as itself.** `~/.claude/sessions/<pid>.json`
  is read after boot and compared with the expected id; a mismatch returns
  `restart_identity_mismatch` and writes an error event, instead of `ok`. An
  unreadable file is not a mismatch — silence is not evidence.

The tool reported `restarted: ok` over the wedged peer. That is this release's
own defect wearing a new hat, and it is why the check exists.

### A restarted adopted peer moved out of its team's session

Adopted peers live in a window of a shared session. `peer_restart` relaunched
through `new-session`, so the peer came back as a session of its own —
`@548` became `@549` somewhere else entirely. The driver now takes an
`inSession` option and issues `new-window -P -F '#{window_id}'` when set,
returning the new window's id as the record's target. `peer_restart` supplies
the old window's parent session; if the window is gone it says so
(`peer_restart_window_home_unknown`) and falls back rather than guessing.

### Adoption could not be scoped

`mode: "auto"` swept every window on the host into a single team, so adopting
four families under four team names was impossible while manual adoption was
unusable. `team_adopt` now takes `hostSession` — a plain session name or a
`/regex/` — and the plan reports which filter was applied.

Tests 132 daemon (+13). The `--resume` case in the v0.10.2 suite asserted the
wedging behaviour as correct; it has been rewritten with an explanation rather
than deleted, and the non-resumable case added beside it.


## [0.10.6] — 2026-08-04

The eight-tool quality gate (see 0.10.6-rc.1 below) plus three lifecycle tools.
Together they close the set the owner named as the precondition for a stable
release.

### Three tools for the states a fleet actually gets into

**`team_release` — drop a peer from state without touching its process.**

The undo for adoption. `team_adopt` takes over peers the daemon did not start;
when it takes over the wrong one, the only exit until now was `peer_stop`, which
removes the record by killing the work — a running peer's life for a bookkeeping
mistake. Release is state-only and *cannot* signal anything. `dryRun` defaults
to true, unknown peers are named in `notFound` rather than skipped, and the
audit event records `processLeftRunning: true` so a later reader cannot mistake
a release for a stop.

**`team_reconcile` — compare belief against reality, and say the difference.**

Every defect in this release was a claim nobody checked against the world.
`state.json` is the same kind of claim one storey up: `status: "live"` is a
belief about a pid, and it goes stale the moment a process dies quietly. Four
kinds of drift:

```
dead          record says live, nothing behind the pid
host_missing  process alive, its tmux target gone
pid_changed   the target holds a DIFFERENT pid than the record
unmanaged     a Claude peer running with no record at all
```

`pid_changed` is the dangerous one — every lifecycle call on such a record would
act on a peer nobody meant. Deliberately stopped peers are state, not drift.

**Read-only by default.** `markDead: true` is the only write and only sets
`status: "unknown"` — never `"stopped"`, because nobody asked those peers to
stop and claiming a clean stop would invent the reason. It never deletes, kills
or adopts: deleting is `team_release`, killing is `peer_stop`, adopting is
`team_adopt`. A tool that both diagnoses and repairs gets run for the repair and
trusted for the diagnosis.

**`team_restart` — roll a team one peer at a time, stopping at the first
failure.**

A peer picks up an updated bundle when its process restarts, so a rolling
restart is how a new version reaches a fleet. This has the widest blast radius
in the daemon and is built on machinery that only became honest today —
`peer_restart` spent the morning reporting starts it had not performed, and
window targets were separated from session targets this afternoon. The defaults
reflect that:

- `dryRun` defaults to **true**, and the plan lists the order plus each peer's
  launch parameters, so an operator confirms they exist before anything stops.
- Peers with no recorded `command` are refused **up front**, not discovered
  mid-roll. Those relaunch as a bare `claude`, which resolves to nothing under
  nvm — the failure this release already fixed once.
- The roll **stops at the first failure** (`continueOnError` defaults false).
  Half a fleet running beats a whole one broken, and peers never attempted are
  named in `skipped`.
- A partial roll returns an **error, never `ok`**. Reporting success would leave
  the caller believing the roll-out finished — the same shape as the phantom
  restart this release opened with, at fleet scale.

Order is array order, or state order for a team, with any peer named velitel
deliberately last: the coordinator is the last down and the first to see the
others return.

### Also

`peer_chat_search`'s over-cap hint told a caller already on `scope='project'` to
"reduce by using scope='project'" — the tool not reading its own arguments
(found in the gate pilot: `/opt/hmh` is 824 MB and project *is* the narrow
scope). The advice now depends on the scope in use and points at
`peer_chat_read`, which takes the same query and has no cap.

Daemon test files no longer run in parallel. Several drive a real tmux server,
and since window enumeration became host-wide the suites saw each other's
fixtures — a failure that appeared only in the full run and never in isolation.

Tests 501 (+26), each verified by restoring the old behaviour.


## [0.10.6-rc.1] — 2026-08-04 (pre-release, development channel)

The four remaining tools from the 2026-08-04 MCP test. With `peer_restart`
(v0.10.2/.3) and the environment whitelist (v0.10.5), that closes the gate the
owner set for a stable release: every tool from that test fixed and measured.

Every one is the same defect: **the tool described behaviour it did not have.**

### `peer_chat_search` — two claims, neither true

The description said *"Self session is excluded (already in context)"*. Nothing
in the code excluded it. The premise was wrong as well: after an autocompact or
a `/clear`, a peer's own transcript holds a great deal its context does not,
which is exactly why `peer_chat_read` allows reading it. So the claim was
dropped rather than implemented — self stays in scope, is tagged `*(self)*` in
the output, and `includeSelf: false` exists for callers who mean it.

`Hits: X/Y` left the reader guessing what `Y` was. Not the scope, not the
sessions with a match — however many the loop reached before `maxMatches`
stopped it. Sessions never opened counted the same as sessions searched and
found empty:

```
Scope: 12 sessions in scope, 1 examined (0 MB) in 8 ms
Hits:  1 matches in 1 of the 1 sessions examined (truncated at maxMatches)
⚠ Incomplete: stopped at maxMatches=1 — 11 sessions in scope were never opened.
```

### `peer_chat_read` — counted through a filter and called it a total

`totalEventsScanned` came from a sweep through `parseSessionFile`, the
validating parser, which drops every line the schema rejects. Same root cause
as the `session_stats` undercount. Now two numbers, because they answer two
questions: `totalEvents` (every line, matches `wc -l`), `eventsParsed` (what
the schema could read), `unmodelledTypes` (the difference, named).

The description said "another peer's chat" while the code deliberately allowed
reading your own. The description was the part that was wrong, and now says so.

### `rate_limit_status` — richer data lost every comparison

The two live sources were **chosen between**, not combined. statusLine is
written on every render, so it was nearly always the newer capture and nearly
always won — carrying only `five_hour` and `seven_day`. Everything the
description promises from the OAuth capture (`scopedLimits`, including the
`weekly_scoped` per-model budget, plus `spend`, `extraUsage`, `perModelWeekly`)
reached no caller.

Worse, the statusLine path **invented** the fields it lacked, reporting
`severity: "normal"` and `isActive: true` unconditionally. Measured on live data:

```
before                              after
session 0.88  severity "normal"     session 0.89  severity "warning"
scopedLimits: absent                scopedLimits: weekly_scoped 0.42 (Fable)
                                    secondary: oauth-api, 158 s old, 5 fields
```

Sources are now composed: numbers from the newer capture, single-source fields
from the OAuth one, and `secondary` states which fields were borrowed and how
old that half is. Where nothing was measured, `severity` is `"unknown"` and
`isActive` is absent — an invented value is worse than a missing one.

### `team_adopt` — planned four peers on a fleet of twenty-three

It was not choosing. `listSessions()` reports `#{pane_pid}` per tmux SESSION —
the active pane of the active window, one pid however many windows the session
holds. The fleet runs one peer per window: four sessions, twenty-three windows.
Nineteen were never looked at, and `ambiguous: []` was true and worthless.

```
tmux list-sessions  → 4       tmux list-panes -a  → 23
```

Adoption now enumerates windows, and the plan reports `hostWindowsSeen` so
"4 planned" can never again be read without its denominator.

**A window is addressed by its tmux window id (`@42`), never by
`session:index`.** Found while writing the test: `renumber-windows` is `on`, so
killing window 2 of {1,2,3} renumbers 3 down to 2. An index is a position, not
an identity — a stored `hmh:5` would quietly come to mean a different peer. The
window id is assigned once and survives renumbering; `session:index` remains
only as a human-facing label.

The driver now knows which kind a target is, because `kill-session -t hmh:3`
does not kill window three — it kills the session `hmh`, and on this fleet that
is seven peers for one requested stop. Window kills go through `kill-window`,
and the linked-window guard is back: a window linked into another session is
**unlinked** rather than killed.

Adopted records carry `command`, `spawnArgs` and `cwd` read from `/proc`.
Without them the first daemon-issued `peer_restart` falls back to a bare
`claude`, which resolves to nothing under nvm — adoption would look complete
while the control layer was unusable at the moment it was first needed.
`--resume` and `--model` are stripped from the captured argv, since `peer_spawn`
appends its own.

Manual mapping accepts a window id, a `session:index` label, or a session name —
and a session holding several windows is reported as **ambiguous**, not resolved
by picking the first.

Tests 475 (+21), each verified by restoring the old behaviour.


## [0.10.5] — 2026-08-04

### The environment whitelist never reached the process it was protecting

Finding #4 of the 2026-08-04 MCP test asked for proof that `peer_spawn`
sanitizes the environment. There is none, because it did not.

`sanitizeEnv` composes the allowed variables correctly — `env-whitelist.test.ts`
has always passed and the function was never wrong. `TmuxDriver.spawn` then
handed the result to `execFile` as the environment of the **tmux client**.
A new pane does not inherit that. tmux's server is a long-lived process, and a
session it creates gets the SERVER's global environment plus the handful named
in `update-environment` (DISPLAY, SSH_\*, XAUTHORITY by default). Nothing given
to the client reaches the pane.

The whitelist was filtering something tmux never consulted.

Measured on tmux 3.4, with a completely empty client environment:

```
$ tmux show-environment -g | grep -c ANTHROPIC_API_KEY
1                                        ← a real key, in the server

$ env -i PATH=… HOME=… tmux new-session -d -s t -c /tmp "sleep 60"
              ↑ client environment entirely empty

$ tr '\0' '\n' < /proc/<pane_pid>/environ | grep -c ANTHROPIC_API_KEY
1                                        ← the pane has it anyway
                                           (plus 8 CLAUDE_* variables)
```

This is the 22 July billing incident — a stray `ANTHROPIC_API_KEY` pushing
usage onto API-key billing instead of the subscription — as a standing
condition rather than an accident, and it is why five of twenty-three peers
were found carrying the key. An earlier reading that blamed the restart method
was wrong; the difference was only which panes were created after the variable
entered the server.

The pane's environment is now built on the command line, from nothing:

```
tmux new-session -d -s KEY -c CWD -- /usr/bin/env -i K1=V1 K2=V2 … command args
```

`env -i` starts from an empty environment, so tmux's semantics stop mattering:
nothing is inherited and every variable present is one we chose. The path is
absolute because tmux resolves the command against the server's PATH, and the
PATH we chose is inside this command's own arguments — too late to help find
the binary that applies them.

Cleaning a running server (`tmux set-environment -gu`) fixes that server and
not the next one started from a contaminated shell. It is worth doing, and it
is not the mechanism.

Tests 456 (+2, one skipped without tmux). They read `/proc/<pid>/environ` of a
real child rather than the return value of `sanitizeEnv` — a test that asserts
on the function cannot fail the way production failed. Verified by removing the
`env -i` prefix: the regression case fails. Also confirmed end-to-end through
the real `TmuxDriver` against a deliberately polluted server — child environment
contained no `ANTHROPIC_*` and no `CLAUDE_*`, and exactly the ten whitelisted
variables.


## [0.10.4] — 2026-08-04

### `claude-bridge-daemon send` — a supported way in from outside the fleet

A relay that polls named Teams threads needs to deliver each new message to a
configured peer. It could write `inbox/<peer>/pending/<id>.json` itself; that
works, which is the problem.

`MessageEnvelopeSchema` is `.passthrough()`, so a writer that drifts from the
format **does not fail**. It writes a subtly wrong file, the watcher delivers
it, and the recipient gets something broken with no error on either side. Two
further requirements are invisible from the format alone:

- ids must be **time-prefixed base36** — the inbox has no index, order is the
  lexical sort of filenames, and a synthetic id delivers messages out of order
- `to` must be a **peer id**, never a display name — the id names the directory

```
claude-bridge-daemon send --to <peer-id|name> --from-label "teams:uzaverka" \
                          [--text <s> | --text-file <path|->] \
                          [--kind ask|reply|broadcast] [--thread <id>]

0  delivered (JSON with msgId on stdout, for the caller's cursor)
2  recipient not found, or a name matching more than one peer
3  malformed invocation
4  the write failed
```

Names resolve through the heartbeat files in `~/.claude-bridge/status/`. A name
matching two peers is **refused, not guessed** — picking one delivers somebody's
mail to the wrong peer, silently. Each injection writes an
`external_message_sent` audit event; the message body is not logged, since a
relay carries whatever the source thread said.

**Replying to an external sender now fails loudly.** External messages carry an
`external:` sender prefix, and `peer_reply` refuses them with
`sender_is_external`. Without it the reply went to
`inbox/external:<label>/pending/` — a directory no process drains — and
returned `ok`. The same confirmed-without-checking shape as the push that
reported `delivered` for a message nobody rendered.

The envelope, the id generator and the peer lookup moved to
`@claude-bridge/shared`, so the daemon does not become a third definition of the
on-disk format. A contract test in the MCP package feeds the shared writer's
output to that package's own reader schema; if the two drift, it fails.
Full unification is still task #65.

Tests 454 (+12), verified by breaking each: renaming a field in the writer fails
the contract test, disabling the reply guard fails the regression test.
End-to-end smoke on the live fleet: exit 2 for an unknown recipient, exit 3 for
an empty body, and a real message delivered through the channel.

## [0.10.3] — 2026-08-04

### `peer_restart` relaunched every peer with a command it had made up

Found by the pilot of the v0.10.2 `cwd` fix, an hour after that release.

`peer_restart` respawned peers with the literal string `"claude"`. Not an
absolute path degraded to a basename — the command was never carried at all,
in exactly the way `cwd` had not been carried, in the same handler, missed in
the same fix:

```ts
command: process.env["CLAUDE_BRIDGE_TEST_COMMAND"] ?? "claude",   // before
args: [],                                                         //   "
```

On an installation where `claude` is on the daemon's `PATH` this happens to
work. Under nvm — which is how this fleet runs — it is not, so the respawned
process died immediately and the restart failed with
`spawn_produced_no_process`.

**That failure is v0.10.2 working.** Before it, the same broken respawn
reported `outcome: ok` and left a phantom live peer. The fix did not make
`peer_restart` work; it made it audible, and the remaining half of the
omission surfaced within the hour instead of at the next incident.

`PeerRecord` now carries `command` and `spawnArgs` alongside `cwd`, and
`peer_restart` uses them. The stored arguments are the **caller's** list, not
the one the daemon computed — the computed list already has `--resume` and
`--model` appended, and storing that would append them again on every restart.

`peer_restart_cwd_unknown` is replaced by `peer_restart_launch_params_unknown`,
which names *which* parameters are missing from a pre-v0.10.3 record rather
than reporting only that something is. It has the same finite life: `peer_spawn`
records all three now, so the next fleet cycle fills them in.

Tests 76 daemon (+3), verified by restoring the hardcoded command — 2 of 3 fail
against it. The third covers the legacy-record warning, which the old code did
not emit at all.

## [0.10.2] — 2026-08-04

Three findings from the live MCP tool test of 2026-08-04
(`report-mcp-test-2026-08-04`), plus the rc series that preceded them.

Every one is the same defect class the rc.2 and rc.3 notes describe: **something
reports a result it never checked.** `peer_restart` reported a start it had not
performed; `model_info` reported prices and context windows nobody had compared
against the published ones; `session_stats` reported a total that was 13% short
because the lines it could not parse were subtracted rather than counted.

### `model_info` had drifted away from what Anthropic publishes

Reported as "`model_info` does not know `claude-opus-5`" (finding #5). It was
three errors, not one — the table had not been checked against a source since
it was written, so nothing said how far it had moved:

| | table said | actually |
|---|---|---|
| `claude-opus-5` | absent | 1M context, 128k output |
| `claude-sonnet-4-5` | 200 000 context | **1 000 000** |
| `claude-sonnet-5` | $3 / $15 per MTok | **$2 / $10 through 2026-08-31** |

The Sonnet 4.5 entry is the one with teeth. `peer_context_status` divides by
`contextWindow`, so a peer on Sonnet 4.5 was reported at full context while four
fifths of the window was still free — an autocompact alarm at 20% usage.

The Sonnet 5 price was documented and wrong at the same time: the `notes` field
already said "introductory pricing $2/$10 per MTok through 2026-08-31" while the
`pricing` field the tool actually reports said $3/$15.

Pinning that field to $2/$10 would have been just as wrong from 2026-09-01, so
pricing may now carry the date it lapses (`until` + `after`) and `model_info`
returns an `effectivePricing` resolved against the current date. This is
deliberately small: it stops a known number from rotting on a known day. Where
the numbers come from is unchanged and still hand-copied — see below.

Context window, max output and capabilities are verifiable against
`GET /v1/models`, which answers for a Claude Code subscription token. A fixture
of that response (11 models, captured 2026-08-04) is now in the suite, and the
table is asserted against it. Price and lifecycle are **not** in the API — not
in the collection, not in `GET /v1/models/{id}` — they are published only on the
docs pages, so they stay hand-copied for now. Sourcing them mechanically is
v0.10.3.

Tests +9. The membership check prints the missing ids rather than asserting a
boolean, which is how the absence of `claude-opus-5` survived the previous
tests.

### `session_stats` reported 13% fewer events than the file contains

Reported as 1 859 events against an independent recount of 2 393 (finding #4).

`countEventsByType` streamed through `parseSessionFile`, which drops every line
`SessionEventSchema` rejects — and with no `onValidationError` callback passed,
drops it without a trace. The schema is a nine-member discriminated union.
A live transcript carries fourteen types:

```
19 767 lines      counted 17 173      discarded 2 594  (13.1%)

pr-link              957 → 0     type not in the schema
mode                 814 → 0        "
permission-mode      713 → 0        "
file-history-delta    91 → 0        "
agent-name            51 → 0        "
last-prompt         1185 → 1182   KNOWN type, 3 lines failed field validation
```

Two loss channels, and the second is the one a type-level fix would have
missed. Counting no longer validates: `countEventsByType` counts the `type`
field as written. Verified against a live 20 020-line session — `total` now
equals `wc -l` exactly.

The gap is reported instead of absorbed. `session_stats` gained
`unmodelledTypes` (types Claude Code writes that the schema does not model, with
counts) and `malformedLines`. An empty `unmodelledTypes` is the normal case; a
non-empty one says the schema is behind, not that the count is short.

`mode` at 814 occurrences answers a standing question about "unknown mode" —
reading was never at fault, the type is simply absent from our schema.

The existing fixture could not have caught any of this: every type in it is
modelled. That is why it passed for eleven versions.

Tests +5, verified by restoring validation to the counter — all 5 fail against
it.

### `peer_restart` reported starting a peer it had not started

Found in live tool testing (`report-mcp-test-2026-08-04`, finding #1), not by the suite:

```
call   : peer_restart mcp-test-obetni-0804
answer : outcome ok | spawn{pid: null}
audit  : peer_stopped → peer_started → peer_restarted
reality: tmux session .......... does not exist
         claude process ........ none
         state.peers ........... status "live", pid null
```

A phantom live peer. `team_layout` treats it as running and will never resurrect it, and every report about it is a lie told with confidence.

Two independent defects, stacked — **A kills the process, B conceals it.** Both are fixed, because either one alone still leaves the tool broken:

**A — the peer was relaunched in the daemon's directory.** `peer_restart` passed `process.cwd()`, because `PeerRecord` had no `cwd` to read. `claude --resume <uuid>` cannot find a transcript belonging to another project, so the process exits immediately and tmux tears the session down behind it. `PeerRecord.cwd` is now persisted by `peer_spawn` and used by `peer_restart`.

**B — `alive` was asserted, never measured.** `TmuxDriver.spawn` returned `alive: true` as a literal after a `tmux new-session` that had not thrown — but tmux exits 0 as soon as the session exists, so a command that dies on the spot looks identical to one that runs. `readSessionPid` swallows every error and answers `null`. And `peer_spawn` never read `alive` at all: it set `status: "live"`, wrote a `peer_started` audit event, and returned `ok`. Now the driver reports `alive: pid !== null`, and a spawn with no process is an error (`spawn_produced_no_process`) that cleans up the state record, kills any empty session, and writes `peer_spawn_failed`.

The mock driver got the same treatment. A mock that always claims success cannot fail the way production failed, so it would quietly certify the very bug the tests exist to catch.

Raising only the floor — "return an error when `pid` is null", the obvious minimal fix — would have turned a reliable false success into a reliable failure. Better, still broken.

**Third instance of the same class in two days.** Writing the "spawn a missing binary" test made the suite emit an uncaught exception: `MockDriver` had no `error` listener on the child. `ENOENT` arrives as an **asynchronous event**, not as a throw from `spawn()`, so the surrounding `try/catch` never saw it and Node turned it into a process crash. Exactly the shape of the statusLine EPIPE fixed in rc.2, and of the push that reported `delivered` without delivering. The recurring sentence is: *an actor confirms success without checking the effect.*

`peer_restart_cwd_unknown` warns for peer records written before this release. It has a finite life — `peer_spawn` now records `cwd`, so the next fleet cycle fills it in naturally.

Tests 73 daemon (+4), verified by restoring the old logic — 2 of 4 fail against it.

## [0.10.2-rc.3] — 2026-08-04 (pre-release, development channel)

### The phantom peer id

A peer came up under a session id that existed nowhere: not in any
`~/.claude/sessions/*.json`, not as a transcript, nowhere on disk. It
corrected itself a few seconds later. Twice in one night, on two different
peers, always right after a controlled restart.

The id is never invented — `resolvePeerIdentity` reads it from
`~/.claude/sessions/<ppid>.json`. Both facts can only hold at once if the
file's contents changed underneath us, and that is what happens: on a
resumed session Claude Code first writes a **provisional** identity there (a
fresh session id plus an auto-generated name of the `<cwd-slug>-<2 hex>`
form — `claude-bridge-8d`, `hmh-71`, `micronic-0f`), then replaces the id
with the resumed one moments later.

A server booting inside that window adopts an id that is about to stop
existing, and everything downstream inherits it: the heartbeat under
`status/`, the inbox directory, the row other peers see in `peer_list`. Mail
addressed to it is written to a directory nobody drains — and on disk it
looks delivered. Observed: this peer registered as `99e371a7` while Claude
Code held `fb749bc6`, and told another peer to use the phantom.

The pre-existing retry (`resolvePeerIdentityWithRetry`, ~3 s) only covers an
**absent** file. A provisional one is present and well-formed, so nothing
retried.

**Fix:** when the parent process was launched with `--resume <path>/<uuid>.jsonl`,
that uuid is the session id. It is fixed at launch and cannot drift, so this
closes the window rather than narrowing it. Read from `/proc/<ppid>/cmdline`;
where `/proc` is unavailable (macOS, Windows) the cross-check is skipped and
behaviour is exactly as before, as it is for sessions that were never resumed.

Retrying until the two sources agreed was the first version of this fix. It
was rejected on a number that turned out to be wrong: "the window runs to
~15 s, past the ~3 s retry budget". Measured directly afterwards, the window
is **~2 s** — two independent captures, 00:33:04→00:33:06 and
00:33:24→00:33:26. The 15 s came from conflating *when the phantom was
noticed* with *how long it lasted*, so the retry approach would probably
have worked after all.

Preferring `--resume` is still the better fix — it closes the window instead
of narrowing it, and adds no startup delay — but the reasoning originally
given for rejecting the alternative did not hold.

Direct evidence of the mechanism, captured live rather than inferred:

```
00:33:04  new  pid 1420859  id=53a70457-…  name=claude-bridge-f9
00:33:06  CHANGED          id → fb749bc6-…  (name unchanged)
```

Note the name does not change — Claude Code rewrites only the id, which
refines the description above: the file is created with a provisional *id*
alongside the final auto-generated name.

After the fix, neither provisional id registered anything: no `status/`
heartbeat, no inbox directory, and `peer_list` showed the correct id from
the first call.

Verified against the live fleet before landing: all 21 running peers already
agree between the two sources, so in steady state the check does nothing.

Tests: `identity-provisional-session.test.ts`, 8 cases, verified by restoring
the old logic — 2 fail against it. Totals 421 (345 MCP, 69 daemon, 7 shared).

## [0.10.2-rc.2] — 2026-08-04 (pre-release, development channel)

### Messages could be archived without ever being shown

Found in live operation during the plugin-identity migration, not by a test.

A peer stopped receiving mail. The messages were on disk in `inbox/<peer>/done/`, the sender saw a successful send, and `peer_inbox_read` answered `count: 0`. Nothing anywhere reported an error.

The chain:

1. A message arrives; the inbox watcher calls `pumpInboxToChannel`, which calls `channel.push()`.
2. `push()` returns `delivered: true`. That only means `server.notification()` did not throw — it says **nothing** about whether Claude Code rendered anything. The id goes into `pushedMsgIds`. The pump correctly leaves the message in `pending/`.
3. Claude Code drops the notification silently. In this case because the renamed plugin identity was not in the org-managed channel allowlist, but any drop does it.
4. The next tool call runs `piggybackInbox`, which consumes the message (`pending/` → `done/`) and then **skips it from the output block** because `pushedMsgIds` says it was already shown.

The message is gone: archived, invisible, unrecoverable by the agent. Evidence: msg `msdv3vmc`, sent 23:30:24, moved to `done/` at 23:34:04 (`ctime` — `mtime` preserves the sender's timestamp and is useless here).

**The delivery test cannot belong to the component doing the delivering.** Until a receiver-side acknowledgement exists, previously-pushed messages are still listed in the inbox block, marked `[already pushed to channel]`. A duplicate line is an annoyance; a lost message is data loss.

This is **not** a v0.10.2 regression — the code is unchanged since before v0.10.0-rc.2, so every version the fleet has run carries it. The rename only created the conditions that expose it. Rolling back would not have helped.

Tests: `push-silent-loss.test.ts`, 4 cases, verified by restoring the old logic — 2 of 4 fail against it.

Two existing tests had to be **reversed**, which is worth naming plainly: `piggyback dedup: messages delivered via push are drained but NOT re-rendered in block` and `when ALL pending messages were pushed, no INBOX block appended`. Both asserted the buggy behaviour as correct, so the suite stayed green while messages were being lost in production. A test that encodes an unverified assumption protects the assumption, not the user.

Totals: 413 (337 MCP, 69 daemon, 7 shared).

### Operational note discovered alongside it

`allowedChannelPlugins` in an org's **Managed Settings** (claude.ai → Admin settings → Claude Code) overrides the user's `~/.claude/settings.json`, and is read at Claude Code **startup**, not live. A plugin whose identity is missing there has its channel notifications dropped without an error. Renaming a plugin — including switching between the stable and development channel entries — therefore needs the new identity added to the managed allowlist and every peer restarted.

## [0.10.2-rc.1] — 2026-08-03 (pre-release, development channel)

### Memory — the leak a user reported, and what measurement said about it

A user reported that the MCP server's memory grows the longer a peer runs, and proposed moving shared resources into the daemon to avoid paying for a Node runtime 23 times over. Both halves were measured before either was acted on.

**Measured:** 24 MCP processes held **6 798 MB PSS**, and `PSS ≈ RSS` (within 5 %) — so it was private heap, not shared pages. Regression across the fleet: `RSS ≈ 60 MB + 4.7 × JSONL_MB`. The control sample settled it: the **daemon, after 256 hours, held 3 MB**. Same Node, same machine — so neither the runtime nor shared code was the cause.

**Cause:** a 5-second timer in `mcp/context.ts` called `readLatestTitleFromJsonl`, which did `readFile(whole file)` + `split` + `JSON.parse` per line. On a 229 MB transcript one pass took **2 755 ms against a 5 000 ms interval**, so passes stacked, each holding ~1 GB, with no in-flight guard.

**Fix:** one streamed pass on first read, then a `{mtimeMs, size, offset}` cache and only the bytes appended since. Invalidated when the file shrinks below the offset or its mtime moves backwards. Interval relaxed 5 s → 60 s with an in-flight guard.

```
identity scan, 44 MB transcript, 20 ticks
  peak RSS      894 MB → 96 MB     (delta 847 → 20 MB, 42×)
  steady tick   411 ms → 0.05 ms
  CPU per peer  8.2 %  → 0.0001 %
```

Two candidate fixes were **rejected on measurement**, one of them mine: naive `readline` streaming used 3.4× the memory for zero speedup, and stream-with-`break` leaked outright — an abandoned `for await` over a `readline.Interface` never closes the stream, costing +150 MB RSS, 5 file descriptors and 5 libuv handles per 5 abandonments, surviving GC.

`peer_chat_search`'s prefilter was also reading whole files to lowercase them (two full copies, since V8 cannot lowercase in place). Now chunked with a 1 KB overlap and an early return. Honest numbers: an early match goes `+265 MB / 472 ms → +1 MB / 3 ms`, but the **no-match worst case is only 2× better and the same speed** (`+177 MB / 525 ms → +89 MB / 512 ms`). The real win is that peak stopped tracking file size at all — a 219 MB file now costs +46 MB.

On the user's second proposal: after this fix a shared runtime would reclaim roughly **0.9 GB of the original 7 GB (13 %)**, so it is worth re-measuring on clean numbers rather than building now.

### Hygiene — nothing in the workspace had an expiry

Measured on the platform machine after ~10 weeks: `inbox/<peer>/done/` held **12 686 files / 57 MB** (oldest 2026-05-25), `live/statusline/` 49 files, and there were **79 orphaned `.tmp` files**, oldest 2026-07-07. The temps are the visible symptom of a real hazard: `atomicWrite` writes then renames, so a process killed between the two leaves the temp forever — and `sweepStale` filters on `.json`, walking straight past them.

A sweep now runs at MCP startup, throttled to once per 6 hours across all peers on the machine. Below is every directory in the workspace against what the sweep does with it, and what `dryRun` reports on the live machine — so that a rule saying "nothing to do" can be told apart from a directory no rule covers. The first version of this table had that hole: `control/requests/done/`, `control/results/` and `control/*-ack/done/` were in the audit and in no rule, and their zero would have read as clean.

| directory | inventory (2026-08-03) | retention | dry-run | reading |
|---|---|---|---|---|
| `inbox/<peer>/done/` | 12 662 files, 20 MB content / 57 MB on disk, oldest 2026-05-25 | 30 d | **2 197** | rest is newer |
| `inbox/<peer>/pending/` | 31 files, oldest 2026-05-26 | **never** | 0 | invariant, not a TTL |
| `live/statusline/` | 51 files, oldest 2026-07-23 | 14 d | **0** | oldest is 11 days — nothing is due yet |
| `.tmp` orphans | 79 files, oldest 2026-07-07 | 1 h | **79** | all of them |
| `control/requests/done/` | 34 files | 7 d | ┐ | |
| `control/results/` | 34 files | 7 d | ├ **55** | 14 remaining are from today |
| `control/compact-ack/done/` | 1 file | 7 d | ┘ | |
| `control/requests/*.json`, `control/*-ack/*.json` | live protocol | **never** | 0 | one level above the swept paths |
| `control/events.jsonl` | 33 KB | rotates at 16 MB | — | separate mechanism, below |
| `status/` | 99 files | — | 0 | owned by `registry/peers.ts` `sweepStale` |
| `guard/`, `notify/`, `live/*.json` | live state | **never** | 0 | no expiry by design |

Overrides: `CLAUDE_BRIDGE_RETAIN_DONE_DAYS`, `CLAUDE_BRIDGE_RETAIN_STATUSLINE_DAYS`, and `CLAUDE_BRIDGE_HYGIENE=off` to disable the sweep entirely. **`pending/` is never swept at any age** — an invariant, not a default, with a test that was checked by removing the guard and watching it fail.

**Total the first sweep removes on the platform machine:** 79 temps + 2 197 archived messages + 55 spent RPC files = 3.98 MB. Nothing was deleted to produce these numbers. Anyone who wants a longer archive should set the retention variable *before* updating.

### Crashes and hangs in the hook path

- **EPIPE killed the statusLine wrapper.** `child.stdin.write()` does not throw when the child has already exited — it emits `error` on the stream, and unhandled that is a hard process crash which the surrounding `try/catch` never sees. Any underlying statusLine command that ignores stdin (`echo` suffices) killed the wrapper on *every render*, and the crash landed before the live-data capture was written, so telemetry was silently lost too. Same defect in the `refresh-limits` PostToolUse hook, where it meant a failed tool call for the user. Both now have `error` listeners; the curl one never logs the body, which holds the bearer token.
- **The passthrough had no timeout.** A blocking statusLine command hung the wrapper, and CC's status bar with it. Bounded at 10 s, then `SIGKILL`.
- **`events.jsonl` never rotated.** The alpha comment said rotation "lives in F2"; F2 never came. It looked harmless at 33 KB after 256 idle hours — but the re-entrancy bug above would have written ~12 000 entries from a single `team_stop`. Now rotates at 16 MB (`CLAUDE_BRIDGE_EVENTS_MAX_BYTES`), keeping 3 generations, by rename only so no written entry is ever truncated away. Concurrent writers are serialised.
- **Symlink refresh had a TOCTOU window.** `setup-check` did unlink-then-symlink, leaving an interval where the link did not exist. 23 MCP servers run this at startup, so the windows overlap, and anything CC renders inside one fails for no diagnosable reason. Now symlink-to-staging then `rename`, which replaces atomically.
- Dropped a redundant `mkdir` per statusLine render — `atomicWrite` already creates the parent.

### The daemon no longer runs from the git working tree

`install --systemd` rendered `ExecStart` with whatever path the installer was invoked from. On this machine that was `/opt/claude-bridge/servers/claude-bridge-daemon/dist/daemon.cjs` — inside the repo. **A `git checkout` was therefore a silent deploy**: change branch, restart the service, and the daemon runs whatever the tree now holds, with nothing announcing it and `control_status` reporting a version that no longer describes the running code.

Install now copies the bundle (and the unit template) to `~/.claude-bridge/bin/`, writes `bin/deployed-from.json` recording source, version and timestamp, and points the unit there. `uninstall --systemd` removes the copy so a later `systemctl --user start` cannot resurrect it.

Two defects surfaced while building this, both caught before the change shipped:

- **The installer never actually restarted anything.** It ran `systemctl start`, which is a no-op on an active unit — so every install over a running daemon rewrote the unit file and left the **old process** alive. Observed directly: `MainPID` unchanged after an install, still executing the previous `ExecStart`. This one predates today; the deployed-binary change only made it visible. Now `restart`, which also starts an inactive unit.
- Running `install --systemd` from the *deployed* copy could not find the unit template — lookup is anchored at `argv[1]` and nothing was deployed beside the binary. The template now travels with it. The same path would also have had `copyFile` write a file onto itself, truncating the binary being executed; guarded.

### Tests

+27 against the pre-v0.10.2 baseline of 382 — **409 total: 333 MCP, 69 daemon, 7 shared**. Three were checked by breaking the fix and confirming failure: removing the `pending/` guard fails the invariant test, removing the EPIPE listener fails 2 of 3 passthrough tests, and the `restart`-vs-`start` assertion fails against the old verb.

## [0.10.1-rc.2] — 2026-08-03 (pre-release, development channel)

Team lifecycle completed, plus three latent daemon defects found by a memory audit the same day. Everything below is on the `claude-bridge-dev` marketplace channel; the stable channel is untouched.

### Blocker fixes — found by audit, proven by measurement

**Re-entrant request dispatch.** `processQueue` was fired from a 250 ms `setInterval` with no in-flight guard, and `markRequestDone` ran *after* `dispatch` — so a request stayed in `requests/` for as long as its handler worked, and every tick picked it up again. Never fired in production only because all 33 requests to date completed in under 15 ms. `team_stop` would have changed that: it waits up to 120 s **per peer**, so a five-peer team nobody acks is ~2400 overlapping handlers, each writing its own inbox messages and firing its own tmux children.

Fixed two ways: a re-entrancy guard (`packages/shared/src/reentrancy-guard.ts`, shared because the MCP server's identity timer needs the same thing) and claim-before-dispatch. The claim uses the id derived from the *filename*, not the envelope — a mismatch would make the rename miss and re-dispatch forever. Semantics are now at-most-once, which is correct here because the handlers are not idempotent: a crash mid-dispatch surfaces as a caller timeout rather than a silent repeat.

Measured against the live loop with the real handler: **1 stop-request message with the fix, 7 without** (one per tick).

**Unbounded tmux calls.** All six `execFile` invocations lacked a timeout, so a wedged tmux left the promise pending forever — child, pipes and the whole await chain pinned. Combined with the poll loop that was fd exhaustion in minutes. Now 5 s for queries, 10 s for create/destroy, `SIGKILL`.

**Tombstones blocked team resume.** `team_layout apply` filtered on `!stateIds.has(sessionId)`, and a stopped peer keeps its record — so every tombstone read as "already running" and a slept team could never be brought back. That is the exact round trip the tombstone exists for.

### Team lifecycle

- **`team_stop`** — controlled sleep, not a mass kill. Each peer gets a `stop-request` in its inbox, parks its work and acks via `control/stop-ack/<sessionId>.json`; only then is it killed. No ack within `anchorTimeoutMs` (default 120 s) and the peer **keeps running**, reported as `skipped`, unless `force:true`. Members first, `role:"velitel"` last.
- **`team_layout` resume + wake** — a resumed session is silent: `--resume` restores the process but nothing runs until a turn is triggered, so an inbox message alone is never read. Observed live on 2026-08-02, when every peer came back and sat at the prompt. Waking is therefore both a durable `peer-wake` inbox message and a key injection. A forced previous stop carries an explicit warning that the anchor may be mid-write.
- **`team_adopt`** — takes over peers the daemon did not spawn, the case where an external launcher left `state.peers` empty while eleven peers were live and every lifecycle tool answered `peer_not_found`. Identity comes from `~/.claude/sessions/<pid>.json`. **`dryRun` defaults to true.** Two Claude processes under one pane are reported `ambiguous`, never guessed.

### Verified send-keys

On 2026-08-02 a `/exit` was sent to a peer, tmux reported success, and the keystrokes never arrived — no transcript trace, empty input box — after which the script hung 13 minutes with no log line. `sendKeys` now cancels copy-mode, sends the text alone and **confirms it is visible in the pane before pressing Enter**, retries once, then throws. Every attempt, including ones where tmux itself failed, is appended to `control/logs/sendkeys-<sessionKey>.log`. `peer_compact` and the wake path inherit this unchanged.

### Version drift — a user-visible bug

The version lived in six hand-edited places and had split three ways. Worst: `src/mcp/server.ts` carried `const SERVER_VERSION = "0.9.4"` as a literal, unbumped since v0.9.4, so **every peer misreported its version in `peer_list`** and the MCP server announced 0.9.4 to Claude Code across five releases. `plugin.json` is now the single source, `scripts/release.mjs` writes the rest, and the server reads its `package.json` at build time. `.githooks/pre-push` enforces it.

### Deliberately NOT done

The planned linked-window guard. Measured first: link a window from session A into B, then `kill-session A` — the window survives in B untouched. The hazard is specific to `kill-window`, which this driver never issues. Reasoning is recorded at the class doc comment so it does not get re-added.

### Tests

**371 pass** (59 daemon + 305 MCP + 7 shared). New coverage worth naming:

- Acceptance against the **real** `runDaemon` and its live 250 ms interval, observable = stop-request messages actually written to disk. Verified to fail (7 vs 1) when the fixes are reverted.
- Smoke over the **real tmux server**: spawn → stop with ack → resume with wake → adopt, each step judged by tmux rather than by our own bookkeeping. Display name deliberately contains a colon, the character that broke rc.1.
- Three verified-send tests against a real pane, including copy-mode recovery and a killed pane, which must throw rather than return void. That last one exposed a real gap on first run — the tmux error escaped before the audit line was written, so a dead-pane send left no trace at all.

## [0.10.0-rc.2] — 2026-07-23 (pre-release, hotfix rc.1 test findings)

Two bugs found during the small-team live test of v0.10.0-rc.1 (designer msg `mrxk13qd`, 7/10 passed). Both stem from the same class of problem — the daemon and the host driver disagreed on what a session name looks like — but they surfaced independently.

### T1 — session names with `:` / `.` broke tmux target syntax

Test used `displayName: "rc-test:alice"`. tmux silently rewrote the session name to `rc-test_alice` on `new-session`, but the daemon kept using the raw string as the `-t` target for every follow-up op. Result: `hostAlive:false` immediately after spawn, `send_keys_failed "can't find window: alice"` in the compact step (because `-t rc-test:alice` was parsed as `session:window`), and `host_kill_failed` in cleanup.

**Fix**: `sanitizeSessionKey()` in `hosts/driver.ts` — one canonical form (`[A-Za-z0-9_-]`, everything else → `_`) used by both drivers. `TmuxDriver.spawn()` and `MockDriver.spawn()` canonicalize on entry, return the canonical key in `SessionHostRecord.sessionKey`; every other driver op (`hasSession`, `kill`, `sendKeys`, `verifyKilled`) canonicalizes input as a defense-in-depth no-op. `peer-spawn.ts` persists `record.sessionKey` (canonical) to `state.peers[].tmuxTarget` so every subsequent handler dispatch feeds the driver the target it already owns. `state.peers[].name` keeps the raw user-facing displayName untouched.

### T2 — peer_stop was not idempotent → state stuck on `stopping`

When `driver.kill()` failed (as it did in T1 because the target was wrong), the peer was left in `state.peers[].status = "stopping"`. Re-running `peer_stop` produced the same error, so state couldn't be reconciled with a tool — operator had to reach for a shell.

**Fix**: `TmuxDriver.kill()` and `MockDriver.kill()` now check `hasSession()` first and return success without a `kill-session` call if the target isn't there. On a real kill attempt that races with something else removing the session, they re-probe and swallow the error. From the handler's perspective a kill either succeeds or throws for a real reason (`supervisor_respawn` still surfaces loudly).

### Tests

- New file `tests/rc2-regression.test.ts` (4 tests):
  1. `sanitizeSessionKey` unit — `rc-test:alice` → `rc-test_alice`, `hmh.node.1` → `hmh_node_1`, `proj/team 2` → `proj_team_2`, clean names left alone.
  2. Spawn stores canonical `tmuxTarget` in state.peers; `name` keeps raw; `team_status.hostAlive:true`; `peer_compact.sendKeys` receives canonical; `peer_stop` cleans state.
  3. `driver.kill("ghost")` on a non-existent session returns success (no throw).
  4. `peer_stop` succeeds and clears state even after the host session vanished externally (regression fixture for T2).
- Updated `tests/rc-acceptance.test.ts` peer_compact happy-path assertion — sendKeys spy now expects the canonical key (`compact_target`, not raw `compact:target`).
- Full workspace test totals: **336 pass** (305 MCP + 29 daemon + 2 shared).

### Version + docs

- Daemon `0.10.0-rc.0` → `0.10.0-rc.2` (skipping `.1` — the marketplace-only bump did not touch daemon code).
- Plugin `0.10.0-rc.1` → `0.10.0-rc.2`. Marketplace `source.ref v0.10.0-rc.1` → `v0.10.0-rc.2`; marketplace description records the T1/T2 hotfix.
- `docs/architecture.md` — no ADR change; ADR-008 already gates stable release on owner GO after clean run.

### What still gates stable

Clean re-run of `docs/RC-TEST-SCENARIO.md` (10/10 pass) at the small-team level, then owner GO. No F2 items in scope.

## [0.10.0-rc.1] — 2026-07-23 (pre-release, marketplace publish)

Marketplace publication of the v0.10.0-rc line. Owner GO 2026-07-23 večer (Zdeněk in designer session `mrxitydc`) — outward-facing gate opened explicitly.

- `.claude-plugin/plugin.json` — version `0.9.4` → `0.10.0-rc.1`, description updated to describe the optional daemon component.
- `.claude-plugin/marketplace.json` — `source.ref` `v0.9.4` → `v0.10.0-rc.1`, marketplace `version` bumped to `0.10.0-rc.1`, description rewritten to explain daemon opt-in path + rc-not-stable disclaimer.
- No code changes vs. `v0.10.0-rc` — this tag is a metadata-only bump so the marketplace can point at a self-consistent tag (previous `v0.10.0-rc` still had `plugin.json.version: 0.9.4`, which would surface as a version mismatch in `/plugin list`).

**Stable release** (`0.10.0` — marketplace stable, main-branch merge, HMH deployment) remains gated on a separate owner GO. The rc lets users opt in early via `install --systemd`.

## [0.10.0-rc] — 2026-07-23 (pre-release)

### Added — peer_compact + team_layout + offline-subscriber delivery (fáze 3/3)

Rc closes the MVP scope. Alpha shipped the daemon skeleton, beta connected it to real peer lifecycle, rc adds the orchestrated `/compact` path, declarative team reconcile, lifecycle event routing into inboxes, and user-facing setup docs.

**Marketplace stays at 0.9.4** — the daemon distribution model is fully opt-in via `install --systemd`. Promotion to stable + marketplace ref bump remains an owner decision (per designer's mrxg4nsh directive).

### `peer_compact` orchestrated injection (§5.3 zadání)

New `src/handlers/peer-compact.ts`:
1. Write bridge inbox message to the peer with `kind: "compact-anchor-request"` (skippable via `skipAnchorRequest:true` for tests / manual paths).
2. Poll `~/.claude-bridge/control/compact-ack/<sessionId>.json` within `anchorTimeoutMs` (default 30 s, `ackPollMs` default 500 ms).
3. On ack: emit `peer_compact_inject` event (charter §8 audit checkpoint) → `driver.sendKeys(sessionKey, "/compact")` — the **only** send-keys path in the daemon.
4. Consume the ack file into `compact-ack/done/` and emit `peer_compacted` + lifecycle event to subscribers.

Timeouts return `anchor_timeout` with a `peer_compact_anchor_timeout` audit event; send-keys errors return `send_keys_failed`. Drivers without send-keys (`NotSupportedByDriverError`) surface as `sendkeys_unsupported`.

### AUTO compact-watchdog framework — DEFAULT OFF

`src/config.ts` reads `~/.claude-bridge/control/config.json`:

```json
{
  "compactWatchdog": {
    "enabled": false,
    "warnAtPercent": 0.85,
    "criticalAtPercent": 0.95
  }
}
```

`enabled` defaults `false`. Only the operator flips it — the reasoning is documented in `docs/SETUP-DAEMON.md` (charter §8 amendment: send-keys injection is the most sensitive daemon operation, we want manual runs first).

### `team_layout` declarative reconcile

New `src/handlers/team-layout.ts`:
- Reads `~/.claude-bridge/control/teams/<team>.json` (or accepts an inline spec).
- `apply:true` (default) → dispatches `peer_spawn` for every peer in the spec not currently in `state.peers`. Extras (in state, not in spec) are KEPT.
- `prune:true` → also dispatches `peer_stop` for extras.
- `apply:false` → plan-only diff (`plannedSpawn`, `plannedStop`, `keptExtras`), no mutation.

Returns `{spawnedOk, spawnedFailed, stoppedOk, stoppedFailed, keptExtras}`. Partial failure → `team_layout_partial_failure` err with the same fields. Emits `team_layout_reconciling` (plan) + `team_layout_applied` (result) audit events.

### Offline-subscriber lifecycle delivery

New `src/event-subscribers.ts` reads `~/.claude-bridge/control/subscribers.json`:

```json
{
  "subscribers": [
    { "peerId": "keeper-uuid", "events": ["peer_started", "peer_stopped", "peer_compacted"] }
  ]
}
```

For each matching event, the daemon writes a `lifecycle-event`-kind message into the subscriber's bridge inbox (`~/.claude-bridge/inbox/<peerId>/pending/`). Persistent — survives peer sleep, drained on next bridge tool call (piggyback). Owner-only writable file; agents can read but not mutate. Wired into `peer_started`, `peer_stopped`, `peer_compacted` events; `peer_crashed` lands in F2 alongside crash detection.

### MCP wire (bridge → daemon)

`servers/claude-bridge/src/mcp/control-plane.ts` gains two more tools:
- `peer_compact` — with `anchorTimeoutMs`, `ackPollMs`, `skipAnchorRequest`, `reason`, and standard `wait/timeoutMs`
- `team_layout` — `team`, `apply`, `prune`, `inline`, `wait/timeoutMs`. Default `wait:true` — reconcile is a query.

Bridge total MCP tools = 21 (was 19 in beta).

### Acceptance tests — 5 PASS

**Vitest** (25/25 daemon tests, +4 for rc):
1. **team_layout apply without prune** — spawns missing peers, keeps extras. `keptExtras` correctly populated.
2. **team_layout prune:true** — extras removed, `stoppedOk` populated.
3. **offline-subscriber delivery** — subscribers config → peer_started event → lifecycle-event message in the subscriber's inbox with correct `kind`, `content.event`, `content.sessionId`.
4. **peer_compact orchestrace** — pre-write ack file → `handlePeerCompact` calls `driver.sendKeys(sessionKey, "/compact")` exactly once; ack file consumed (moved to `done/` or unlinked).
5. **peer_compact anchor_timeout** — no ack file → sendKeys spy asserts NOT called; result `anchor_timeout`.

**Live smoke** (daemon 0.10.0-rc.0 installed via systemd, verified in this repo):
- `control_status` alive, heartbeat fresh, `daemonVersion:"0.10.0-rc.0"`.

### Docs

- `docs/SETUP-DAEMON.md` — user-facing setup guide (install, layout, config files, tools table, audit events, uninstall, troubleshooting).
- `docs/architecture.md` — ADR-008 status updated with alpha/beta/rc progression; stable release explicitly gated on owner GO.

### Version bump

- Daemon `0.10.0-beta.0` → `0.10.0-rc.0`. Bundle 158kB → 174kB (rc handlers + config + subscribers).
- Plugin stays at 0.9.4 for marketplace. Daemon distribution is opt-in via `install --systemd`.

### Not in scope for rc (F2+)

- `peer_crashed` detection + crash policy (restart / wait / escalate)
- Telemetry cache (`control/telemetry/<sessionId>.json`) as source #1 in `contextLimitSource` chain
- Account profiles (`peer_login`, `~/.claude-bridge/control/accounts/`)
- GO-registr verification (`authRef` gating for destructive ops)
- Rate-limit window detection + revive
- Extended acceptance: end-to-end multi-peer team spawn from `teams/hmh.json` on a real machine

### Coordination

Milestone report `[milestone] v0.10.0-rc — SHIPPED` posted to designer thread `control-plane-zadani-2026-07-23` at release. STOP-gate after rc: stable + marketplace + HMH deployment are Zdeňkovo rozhodnutí — no further daemon work without his GO.

## [0.10.0-beta] — 2026-07-23 (pre-release)

### Added — peer lifecycle + fork-guard + SessionHostDriver (fáze 2/3)

Alpha shipped the daemon skeleton (lock, state, RPC, events, systemd install). Beta connects it to real Claude Code processes: **spawn, stop, restart, team_status** with a proper host-driver abstraction and the hard-earned safeguards from the 22.-23. 7. 2026 incidents.

### SessionHostDriver abstraction (§6/10 zadání)

- New `servers/claude-bridge-daemon/src/hosts/`:
  - `driver.ts` — `SessionHostDriver` interface (`hasSession / spawn / kill / listSessions / sendKeys?`)
  - `tmux-driver.ts` — Linux / macOS / WSL2 MVP. Kills sessions by **name** so daemon restart can re-attach (§6/6 state recovery). `kill()` polls post-kill for the respawn class of failure — bg-pty-host lesson from msg mrxe9t7d — and throws a distinctive error the handler surfaces as `supervisor_respawn`.
  - `mock-driver.ts` — in-memory driver for tests; `hostRespawnHook` option simulates supervisor respawn so acceptance tests can exercise the detection path.
- Lifecycle handlers never call tmux directly — all traffic flows through the driver interface (§6/10).

### Env whitelist (§6/8 zadání — blacklist nestačil dvakrát)

`src/env-whitelist.ts` composes a fresh env for every spawn:
- `BASE_ALLOWLIST` — PATH, HOME, USER, TERM, LANG, LC_*, TMPDIR, TMUX, XDG_*, …
- `HARD_STRIP_PREFIXES` — `ANTHROPIC_`, `CLAUDE_`, `CC_`, `CLAUDE_CODE_` — stripped even when the caller explicitly allows them
- `overrides` — the daemon may inject `CLAUDE_CONFIG_DIR` (subscription profile) but nothing else in the Claude/Anthropic namespace

Closes the 22. 7. regression where `ANTHROPIC_API_KEY` from the operator's shell hitched a ride into a resumed session and pushed billing onto API credits.

### fork-guard (§5.1 zadání)

`src/handlers/fork-guard.ts` refuses a spawn/resume when either:
- daemon state records the sessionId as `live` or `starting`, or
- the host driver still holds the sessionKey (catches supervisor respawn immediately after a crash-restart cycle)

Emits `peer_spawn_rejected` with the specific reason (`state_live` vs `host_alive`) so the audit trail shows which safeguard fired.

### Handlers (split from monolithic `handlers.ts`)

New `src/handlers/` directory:
- `context.ts` — HandlerContext (`state, hostDriver, daemonVersion`)
- `state-writer.ts` — `applyStateChange` funnels every mutation through atomic save
- `control-status.ts` — read-only daemon summary (from alpha, kept)
- `peer-spawn.ts` — fork-guard → sanitized env → driver.spawn → state + `peer_started` event
- `peer-stop.ts` — mark stopping → driver.kill (tears down the whole tree + post-kill verify) → state delete → `peer_stopped` event. Emits `peer_stop_respawn_detected` (error level) when the driver catches a bg-pty-shaped supervisor
- `peer-restart.ts` — snapshot record → peer_stop → peer_spawn with `--resume` and carry-over of model + account profile
- `team-status.ts` — read-only aggregation of `state.peers` + `driver.listSessions()`; `verbose:true` for full fields

### MCP wire (bridge → daemon)

`servers/claude-bridge/src/mcp/control-plane.ts` gains three tools:
- `peer_spawn` — fire-and-forget or `wait:true` opt-in poll (§4.3)
- `peer_restart` — same semantics; carries model/account profile from state unless overridden
- `team_status` — default `wait:true, timeoutMs:5000` (read query → callers expect data, not an ack)

All three return `daemon_not_running` + `setupPointer` when the daemon isn't installed. `peer_stop` was already wired in alpha; the request envelope shape didn't change.

### Acceptance tests — 4× PASS

**Live smoke on real tmux** (post-install verification, not vitest):
1. `team_status` — peerCount:0
2. `peer_spawn` (sleep 60) → new tmux session `beta-smoke-window` (verified `tmux list-sessions`)
3. `team_status` — 1 peer, `hostAlive:true, hostPid:<matches spawn>`, status `live`
4. `peer_stop` → tmux `kill-session` → post-kill verify PASS (no respawn)
5. Post-stop `team_status` — peerCount:0, tmux session gone

**Vitest coverage** (21 daemon tests, all pass):
- **sanitized-env spawn** (22. 7. regression) — process.env with `ANTHROPIC_API_KEY` + `CLAUDE_CODE_SESSION_ID` set → MockDriver's spy on `spawn.env` confirms both stripped, PATH preserved
- **fork-guard state_live** — pre-populated `state.peers[X].status = "live"` → spawn refused with `session_already_live`
- **fork-guard host_alive** — orphan session in driver (state empty) → spawn refused with `session_already_live`
- **bg-pty respawn coverage** — MockDriver `hostRespawnHook` re-inserts session after kill → daemon surfaces `supervisor_respawn` error (state stays `stopping`, alarm-loud event)
- **concurrent (serialized) requests** — sequential dispatch of duplicate peer_spawn → first ok, second `session_already_live` (daemon queue is sequential via for-await; this test mirrors that)
- **happy path** — spawn → team_status shows peer with `hostAlive:true` → stop cleans state

### Version bump

- Daemon: `0.10.0-alpha.0` → `0.10.0-beta.0`. Bundle size 24kB → 158kB (zod schemas). Daemon is a background service; bundle size does not affect steady-state cost.
- Plugin: stays at 0.9.4 for the marketplace (daemon distribution + activation via `install --systemd` is opt-in; nothing about the marketplace-facing plugin has changed).

### Not in scope for beta (F2 / rc)

- Compact watchdog (`peer_compact`)
- Telemetry cache (`~/.claude-bridge/control/telemetry/<sessionId>.json`) — plugin still uses v0.9.4 dual-source chain
- Account profiles (`peer_login`, `~/.claude-bridge/control/accounts/`)
- Lifecycle events streamed into bridge inboxes of offline subscribers
- GO-registr verification for gated ops — daemon prints authRef but doesn't verify yet

### Coordination

Milestone report `[milestone] v0.10.0-beta` posted to designer thread `control-plane-zadani-2026-07-23` at release. STOP-gate before rc respected — no rc work until designer takeover.

## [0.10.0-alpha] — 2026-07-23 (pre-release)

### Added — control-plane daemon MVP (fáze 1/3)

**Motivace.** Provozní incidenty autonomního HMH týmu 22.–23. 7. 2026 (noční zánik 6 peerů, kontaminovaný spawn, umřelá telemetrie, tichý crash cronu, ruční orchestrace) prokázaly, že správu životního cyklu Claude Code procesů nelze udržet na uživateli. Ratifikované zadání `/opt/hmh/docs/agent-platform/control-plane-zadani-2026-07-23.md` v3 vymezuje samostatnou opt-in komponentu — control-plane daemon — jako řešení. Alpha ships MVP core (fáze 1/3), beta a rc následují.

### Workspace layout

Repo přechod na npm workspaces:
- `packages/shared/` — `@claude-bridge/shared` (paths, atomic-write, structured logger s pid trace, control-plane path helpery per §4.3 zadání)
- `servers/claude-bridge/` — existing MCP server, unchanged v alfě (import migrace se plánuje v v0.10.0-beta/rc)
- `servers/claude-bridge-daemon/` — nový daemon package, opt-in artefakt distribuovaný v pluginu

Root `package.json` s `workspaces: ["packages/*", "servers/*"]`. Pre-push hook (`.githooks/pre-push`) rozšířen o iteraci přes všechny workspace balíčky (biome + tsc + vitest per package).

### Daemon core (`servers/claude-bridge-daemon/`)

- **Bundle** `dist/daemon.cjs` (~24 kB) přes esbuild, entry `src/index.ts`
- **CLI příkazy:** `run`, `install --systemd`, `uninstall --systemd`, `status`, `version`, `help`
- **Lock file** `~/.claude-bridge/control/daemon.lock` — atomic write s payload `{pid, startedAt, procStart}`. Stale-lock takeover přes `kill(0, pid)` + `/proc/<pid>/stat` fingerprint na Linuxu (per §6/6 zadání — state recovery kdykoliv restart)
- **State machine** `~/.claude-bridge/control/state.json` s `stateVersion: 1`. Loader refuses to open state written by a newer daemon (no silent downgrade, per §7 zadání)
- **Requests inbox** `~/.claude-bridge/control/requests/<id>.json`, konzumace přes rename do `requests/done/` (vzor pending/done z bridge inbox v0.2.x)
- **Results envelope** `~/.claude-bridge/control/results/<id>.json` — outcome, finishedAt, data / error
- **Events audit log** `~/.claude-bridge/control/events.jsonl` — append-only NDJSON s pinned polem `schemaVersion, ts, pid, level, event, by, requestId, details` (per §4.3)
- **Heartbeat** `~/.claude-bridge/control/heartbeat` — mtime advertisement (touch every 5 s). Stale > 30 s = `daemon_not_running` signal
- **Structured logger** — stderr NDJSON s pid trace field (per §6/5 lesson v0.9.3)
- **Signal handling** — SIGTERM/SIGINT = graceful (drain + release lock + emit stopped event), SIGHUP = reload stub (beta), SIGPIPE = ignore, stdin EOF = ignore (per §6/3, v0.9.3 lekce)

### Systemd instalace

- Šablona `servers/claude-bridge-daemon/src/templates/claude-bridge-daemon.service`
- `install --systemd` render + write do `~/.config/systemd/user/`, `daemon-reload && enable && start`
- ExecStart používá aktuální `process.execPath` (nvm/asdf compat)
- `Restart=always` + `RestartSec=2s` — základ pro kill-test acceptance

### Alfa handlery

- `control_status` — vrací daemon health + state summary
- `peer_stop` — MVP stub: neexistující peer → `peer_not_found`, existující peer → `not_implemented_in_alpha` (plná implementace v0.10.0-beta per §5.2)

Bez handlerů = `unknown_tool` s výčtem supported tools.

### MCP wire (bridge strana)

Nové nástroje v `servers/claude-bridge/src/mcp/tools.ts`:
- `control_status` — read-only probe daemonu (lock + heartbeat + state.json). Vrací `daemon_not_running` + `setupPointer` když daemon není nainstalovaný — žádný crash, žádný auto-start
- `peer_stop` — fire-and-forget (default) nebo `wait: true, timeoutMs: N` opt-in poll (per §4.3 zadání). Vrací `{ requestId, queuedAt }` v obou režimech

MCP server bundle regenerován, tests 305/305 pass (nulová regrese).

### ADR-008 a docs

- Nový `docs/architecture.md` monolit s ADR indexem (slot ADR-007 rezervovaný pro Agent Teams pivot, ADR-008 plný text — control-plane daemon vedle file-based filozofie)
- Amendment `docs/HOOKS-STATUSLINE-ARCHITECTURE.md` — scope note k „no daemon" pasáži + úprava „Why not IPC / daemon / socket?" (upřesnění, že platí pro data/messaging plane; process lifecycle řeší ADR-008)

### Acceptance testy alfa

**Kill-test PASS** (přiložen do milestone reportu do designer threadu — output.log v alfa post-mortem):
- initial daemon (pid A) processes control_status request → result envelope OK
- `kill -9 <pid A>` → systemd `Restart=always` respawn (pid B)
- Stale lock takeover: nový daemon detekuje mrtvý pid + procStart mismatch → cleanup + acquire (pid B)
- state.json persisted → recovery po restartu
- post-crash request → result OK
- events.jsonl audit: 12 events pinned schema (daemon_started × 2, request_received/completed × 2, lifecycle boundaries)

**End-to-end request pipeline PASS:**
- peer_stop s nonexistent peerem → `outcome:error, code:peer_not_found` v `results/<id>.json`
- request přesunut do `requests/done/`
- 4 events zaznamenané (request_received → peer_stop_rejected → request_completed)

**Unit tests:** 10/10 pass v daemon package (lock acquire/refuse/takeover, state bootstrap/roundtrip/version mismatch, rpc dirs/read good/reject bad/markDone/writeResult).

### Kompatibilita

- Bez daemonu plugin funguje beze změny — nulová regrese pro stávající uživatele
- Uninstall příběh: `daemon uninstall --systemd` zastaví service, odstraní unit, `daemon-reload`. Setup-check detekce „služba běží, plugin pryč" plánována v F2 (setup-check rozšíření o daemon symlink)
- Cross-platform matice per §9 zadání: Linux MVP; macOS launchd + Windows Task Scheduler ship v F3+. Windows uživatelé zatím používají WSL2

### Coordination

Ratifikováno v designer thread `control-plane-zadani-2026-07-23`. Milestone report `[milestone] v0.10.0-alpha` s přiloženým kill-test výstupem posílán do threadu při release. STOP-gate před beta: čeká na designer převzetí alfa reportu.

## [0.9.4] — 2026-07-23

### Added — JSONL fallback for `peer_context_status` (no single point of failure)

**Motivation.** Zdeněk 23. 7. 2026: „vazba na CLI by měla být jen fallback, mělo by to fungovat i samostatně. Je to nespolehlivé." Evidence — na test-ai1 zamrzlý symlink na 0.9.0-alpha.2 → celá render-chain telemetrie mrtvá (`hasLiveData:false`), tým měřil kontext z obrazovek. Ratifikováno v control-plane zadání v3 (2026-07-23) §10 jako závazný design pravidlo.

**Design princip.** Telemetrie kontextu nesmí mít jediný bod selhání. Statusline render-chain (wrapper → symlink → per-session file) může selhat v každém kroku — plugin musí mít nezávislý autoritativní zdroj.

### Dual-source priority chain

1. **`statusline-stdin`** — statusLine capture `live/statusline/<sessionId>.json`. Autoritativní když je k dispozici (`context_window_size` + `used_percentage` + `total_input/output_tokens` přímo z CC's API mirror). Beze změny proti v0.9.1.
2. **`jsonl-canonical`** (nové) — JSONL scan `readContextFromJSONL()` sumuje `cache_read + cache_creation + input + output` z posledního assistant eventu; `canonicalContextLimit(model, tokensUsed)` použije canonical Anthropic model table (reuse `lookupModel` z v0.7.3+) pro `contextLimit`. Deterministic pro známé modely.
3. **`no-live-data`** — oba zdroje suché (fresh session bez assistant eventu ani statusline capture).

### `contextLimitCaveat` sub-field (jen v `jsonl-canonical` větvi)

Když je model v canonical tabulce, `caveat: "canonical-match"` — trust full. Když model není v tabulce:
- `empirical-guess-1m` — tokens > 200k → assume 1M variant (empirical safety net z v0.8.0)
- `unknown-model-default-200k` — tokens ≤ 200k → conservative 200k default, ⚠ `percentUsed` může být inflated pro genuine 1M model

Návrat fallback flagů z v0.8.x jako EXPLICITNĚ OZNAČENÝ SUB-FIELD (ne top-level `contextLimitSource` value), aby konzumenti viděli jednu primární třídu zdroje a caveats jako podřízený detail.

### `turnInProgress` flag (§10 Zdeněk 23. 7.)

Detekce probíhajícího tahu — když poslední event v JSONL je `user` s timestamp > last assistant event, agent je mid-turn a `tokensUsed` je spodní hranice. Signál pro konzumenty (compact watchdog jedná stejně jen na hranicích tahů). Null v statusLine větvi (statusLine reflects request-time snapshot, nemá separate turn-progress).

### §6/1 sessionId verifikace uvnitř souboru

`readStatusLineLive(sessionId)` nyní ověřuje `envelope.sessionId === sessionId` PO čtení per-session souboru, nikoli jen path. Přejmenovaný/corrupted soubor s cizím `sessionId` by dřív prošel jako valid data pro jinou session (byť velmi vzácný edge case). Fix: mismatch → `null` (treat as absent).

### Částečné odvolání v0.9.0 „live-data-only"

v0.9.0 breaking change odstranil BOTH heuristiky AND deterministický JSONL scan. **JSONL scan sám byl autoritativní** (matematicky správný součet usage tokens); heuristiky (`unknown-model-fallback`, `empirical-heuristic`) byly problém, ne JSONL scan. v0.9.4 vrací JSONL scan jako plnohodnotný fallback source, heuristiky se vracejí jen jako `contextLimitCaveat` — explicit signal of trust level.

### API changes

**Přidané pole na `peer_context_status` output:**
- `contextLimitCaveat?: "canonical-match" | "empirical-guess-1m" | "unknown-model-default-200k"` — jen v `jsonl-canonical` větvi
- `turnInProgress: boolean | null` — null v statusLine větvi

**`ContextLimitSource` enum rozšířený:**
- `"statusline-stdin"` (unchanged)
- `"jsonl-canonical"` (new)
- `"no-live-data"` (unchanged)

Backwards compat pro consumery, kteří checkli jen `contextLimitSource === "statusline-stdin"` — teď taky mají jasné `"jsonl-canonical"` jako second-primary source.

### Added — `src/parser/jsonl-context.ts`

Nový modul:
- `readContextFromJSONL(filePath)` — scan last assistant event usage + turnInProgress detection
- `canonicalContextLimit(model, tokensUsed)` — canonical lookup + heuristic fallback with caveat
- Reuses `lookupModel` z `model-metadata.ts` (žádné duplicate model table)

### Cross-peer JSONL access

`buildContextStatusEntry` v `tools.ts` nyní obnoveně volá `findSessions(peerId)` pro nalezení peer's JSONL file path (obnoveno z pre-v0.9.0 chování). JSONL fallback funguje pro cizí peery, nejen pro self.

### Tests

- 299 → 305 (+6 nových JSONL fallback testy: canonical-match, empirical-guess-1m, unknown-model-default-200k, turnInProgress, statusLine primary wins, both-dry returns null).
- Edge case test „statusLine bez context_window" updatnut — nová sémantika: fallthrough na JSONL, když JSONL taky chybí → null (místo dřívějšího hasLiveData=true s nulami).

### Coordination with control plane

v0.10.0 (daemon) přidá `"control-plane"` jako nejvyšší priorita v enum: `control-plane → statusline-stdin → jsonl-canonical → no-live-data`. Bez daemonu (v0.9.4) plugin je robustní sám. S daemonem plugin má ještě rychlejší přístup skrz daemon-owned telemetry cache (single-request read). Backwards compat plná — starý enum values zůstanou.

### Credit

Reported by Zdeněk 23. 7. 2026. Design ratified v control-plane-zadani-2026-07-23 v3 (§10 zpřísněno, §6/1 doplněno). Implementation: bridge-dev (tento release). Design pravidlo: **no single point of failure** — trvalá zásada pro budoucí telemetry features.

## [0.9.3] — 2026-07-10

### Fixed — Windows stdio probe-close crash-loop (claude-bridge unusable on Windows since v0.9.0)

**Severity: high, Windows only.** Reported by Zdeněk 2026-07-10 while onboarding a Windows Claude Code session. Root cause diagnosed by his Windows agent from CC MCP debug log.

### Symptoms

- `/mcp` shows `claude-bridge` as `failed`.
- MCP tools (`peer_*`, `rate_limit_status`, etc.) do not appear in the ToolSearch index.
- CC MCP debug log shows an endless cycle: `started, tools:15` → `Successfully connected in 110ms` → `hasTools:true` → `UNKNOWN connection closed after Xms` → respawn with new pid → repeat.
- Notifications (channel push) somehow work — because every short-lived reconnect re-pushes the backlog once.
- Not reproducible on Linux.

### Root cause

Windows CC harness spawns the MCP server, completes the `initialize` + `tools/list` handshake to discover capabilities, then **closes the stdio pipe**. Node.js sees `stdin` EOF, all listeners (data/error from MCP SDK) drain, event loop empties, process exits. CC reads the exit as "server crashed" and re-spawns — the tools/list result is lost from the session index in the process.

MCP SDK stdio server transport (`@modelcontextprotocol/sdk`) does not install any `stdin.on('end')` handler, and neither did our code. The plugin was effectively deleted from the session index on the first probe-close on Windows, at every CC startup.

Not a regression per se — pre-v0.9.0 claude-bridge was probably affected too, but the older tool set was less critical, and the pattern wasn't isolated until now.

### Fix

`startStdioServer` now installs:

1. **`setInterval` keep-alive** (60-second no-op ticks) to hold the event loop against EOF.
2. **`process.stdin.on('end')`** + **`.on('close')`** handlers that log and no-op, refusing to terminate the server just because the pipe closed.
3. **Shutdown** stays gated on explicit `SIGINT` / `SIGTERM` (CC's real shutdown path — always sent, on both platforms).

Linux impact: none. The probe-close pattern is Windows-only; on Linux, the pipe stays open until real shutdown, so keep-alive is a no-op and the stdin handlers never fire.

### Behavior after fix

Windows startup now:

- Server spawns, boots (~3s), attaches transport.
- CC probe: `initialize` + `tools/list` → server responds.
- CC closes probe pipe → server sees EOF but **stays alive**.
- CC opens the real persistent pipe → server accepts new stdio → tools stay registered.
- `/mcp` shows `claude-bridge` connected with 15 tools. `peer_*` calls work.

### Credit

Zdeněk's Windows agent parsed the CC MCP log and identified the probe-close pattern by comparing `UNKNOWN connection closed after Xms` timing with each subsequent spawn's pid delta. Without that log discipline the bug would still be misattributed to timeout / channel-plugin / bundled-hooks hypotheses (all three were considered and ruled out).

## [0.9.2] — 2026-07-09

### Fixed — v0.9.1 fix distribution broken by `/mcp reconnect` update flow

Follow-up to v0.9.1. Zdeněk + jira-architect observed 2026-07-09 that after the whole HMH team updated + reloaded + reconnected, only architect's own session had live data — six other peers reported `hasLiveData: false` even for their own self-reads. Root cause: **the `setup-check` SessionStart hook (which refreshes the version-tracking symlinks) does not fire on `/reload-plugins` + `/mcp reconnect`**. It only fires on a fresh CC session start.

Consequence: after the update, symlinks at `~/.claude/claude-bridge-statusline.cjs` and `~/.claude/claude-bridge-refresh-limits.cjs` still pointed at the previous version's bundle. The statusLine wrapper kept running the OLD binary, which wrote to the pre-v0.9.1 shared `live/statusline.json` (user-scoped). The new v0.9.1 MCP server correctly read `live/statusline/{sessionId}.json`, found nothing, and returned `hasLiveData: false` for most peers — only the single peer whose sessionId happened to match the shared file's content saw legacy-fallback data (which then flickered as other renders overwrote it).

### Fix

`startStdioServer` now runs `setup-check` inline immediately after backlog drain (non-blocking, best-effort). Since `/mcp reconnect` always spawns a new MCP server process, symlinks get refreshed on every reconnect, and the wrapper's next render uses the new binary.

- **`src/mcp/server.ts`**: dynamic import of `setup-check/main.ts` after startup, wrapped in try/catch. Failure logged as warning, never crashes the server.
- No SessionStart-only reliance. Both trigger points (real session start + MCP reconnect) refresh symlinks.

### Architecture lesson

Depending on external event delivery (SessionStart hook) for critical state updates is fragile — the event doesn't fire on all lifecycles that need it. Self-refresh on server startup is more robust because it aligns with the server's own lifecycle.

### No test changes

The startup call is idempotent (setup-check silently no-ops when setup is complete + version unchanged). Existing setup-check tests still valid.

### Migration for existing users

After updating to v0.9.2, `/plugin marketplace update` + `/reload-plugins` + `/mcp reconnect` will properly refresh symlinks. Then the next statusLine render writes to `live/statusline/{sessionId}.json` and `peer_context_status` returns clean per-session data.

Users who already have v0.9.1 broken symlinks: v0.9.2 fixes them automatically on the first reconnect.

## [0.9.1] — 2026-07-09

### Fixed — cross-session context contamination in v0.9.0

**Critical bug.** v0.9.0's chained statusLine wrapper wrote to a single user-scoped file `~/.claude-bridge/live/statusline.json`. Every session's statusLine render overwrote every other session's capture. `peer_context_status` for any peer therefore returned whatever was in the shared file — typically the last renderer's data.

Empirically observed by jira-architect (HMH) on 2026-07-09:
- `peer_context_status({to: 'all'})` returned identical `tokensUsed` across all 31 peers.
- `int-dev` ground-truth `/context` reported 83 %, but `peer_context_status` reported 40 % (**43 percentage-point delta**).
- Self-reads flipped model string between adjacent calls (`Opus 4.8` → `Opus 4.7`) because a different session's render overwrote the file between them.

### Root cause

`context_window` is **per-session** (each Claude Code chat has its own conversation, thus its own context tokens). `rate_limits` is **user-scoped** (per POSIX account). v0.9.0 conflated the two under one file, breaking `context_window` reads.

### Fix

- **`writeStatusLineLive`** now writes to `~/.claude-bridge/live/statusline/<sessionId>.json` (per-session partition).
- **`readStatusLineLive(sessionId)`** takes an explicit `sessionId` and reads that session's capture only. No cross-session bleed.
- **`readContextUsage(sessionRef)`** passes `sessionRef.sessionId` down, so `peer_context_status` for peer A never returns peer B's numbers.
- **`readLiveRateLimits`** uses new `findNewestStatusLine()` helper that scans the per-session dir and returns the newest envelope. Rate limits are user-scoped, so any recent capture reflects the account's current state.
- **StatusLine wrapper** reads `session_id` directly from CC's stdin payload (verified 2026-07-09 that CC 2.1.205+ includes it). Env-var fallback preserved for older CC.

### `tokensUsed` accuracy improvement

CC 2.1.205+ exposes `context_window.total_input_tokens` and `total_output_tokens` at the same level as `current_usage`. These are the exact same numbers CC's own `/context` header uses. `readContextUsage` now prefers `total_input + total_output` when available, falls back to summing `current_usage.*` fields for older CC.

### Legacy compat

If `~/.claude-bridge/live/statusline.json` exists (v0.9.0 shared file), `readStatusLineLive(sessionId)` uses it as fallback IFF its `sessionId` matches the requested one. Ensures upgrade path from v0.9.0 without waiting for a fresh statusLine render.

### Migration for users

No settings.json changes needed. The bundled `setup-check` SessionStart hook already refreshes symlinks on plugin update, and the new statusLine wrapper writes to the new per-session location automatically. The single shared file becomes cold data after the first per-session render.

### Tests

- 298 → 299 (+1 new: cross-session isolation test verifying `readContextUsage` for session A does NOT return session B's envelope when only B has written).

### Credit

Reported by Zdeněk Michálek + jira-architect (HMH) with concrete numbers (int-dev 83 % vs. 40 %) that unmistakably identified last-writer-wins. Same bug pattern as v0.8.3 fossil-cache surprise (secondary cache masquerading as authoritative data) — different mechanism, same design lesson: **user-scoped storage for per-session state is unsafe**.

## [0.9.0] — 2026-07-07

**Major release. Breaking change.** Live-data-only architecture replaces the v0.8.x heuristic chain and fossil-cache read. `peer_context_status` and `rate_limit_status` now source their data from Claude Code's own per-render stdin JSON (via a chained statusLine wrapper) plus a PostToolUse hook against Anthropic's OAuth `/api/oauth/usage` endpoint. When neither source is configured, both tools return `hasLiveData: false` with a `setupPointer` — no misleading numbers.

### Breaking changes

- **`peer_context_status`** — `contextLimitSource` enum reduced from 5 values to 2 (`"statusline-stdin"` | `"no-live-data"`). All heuristics REMOVED: `empirical-heuristic` (tokens > 200k → assume 1M), `unknown-model-fallback` (200k default when model unknown), `settings-json-1m-tag` (v0.8.1 `[1m]` detection via `~/.claude/settings.json`), `explicit-1m-tag` (v0.8.0 `[1m]` detection in JSONL), `canonical-lookup` for context detection. Output shape adds `hasLiveData`, `effortLevel`, `claudeCodeVersion`, `setupPointer` (when no live data).
- **`rate_limit_status`** — fossil `~/.claude/.usage_cache.json` read REMOVED (was benabraham's cache, not CC's — see CREDITS.md v0.8.3). Output shape adds `source` enum (`"statusline-stdin"` | `"oauth-api"` | `"no-live-data"`), `capturedAt`, `capturedAgeSeconds`, `hasLiveData`, `setupPointer` (when no live data). `staleness` verdict + per-bucket `windowExpired` preserved from v0.8.2.
- **`src/parser/settings.ts` removed** entirely (v0.8.1 helper for `~/.claude/settings.json.model` reading — no longer needed since `context_window_size` arrives via CC stdin authoritatively).
- **`detectContextLimit` and `detectContextLimitWithSource` removed** from `src/parser/context-usage.ts`. Canonical model table remains in `model_info` tool as read-only reference for agents that want model metadata, but NOT for context detection.

### Migration

Set up the two live sources (either via the bundled SessionStart hook or manually). See [docs/SETUP-LIVE-DATA.md](docs/SETUP-LIVE-DATA.md) for step-by-step instructions. Until setup is complete, both tools return `hasLiveData: false` — this is intentional and safer than the v0.8.x heuristic guesses.

### Added — live data pipeline

- **`bin/claude-bridge-statusline`** (`dist/statusline.cjs`) — chained statusLine wrapper. Reads CC stdin per render (`rate_limits`, `context_window`, `effort`, `model`, `version`), atomically writes envelope to `~/.claude-bridge/live/statusline.json`, then optionally spawns `CLAUDE_BRIDGE_UNDERLYING_STATUSLINE` command as subprocess with stdin forward + stdout stream-through. Preserves user's existing status line (e.g. benabraham's) transparently.
- **`bin/claude-bridge-refresh-limits`** (`dist/refresh-limits.cjs`) — PostToolUse hook. Reads OAuth token via `~/.claude/.credentials.json` or macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`). Token character-set validated to prevent HTTP header injection from a corrupted credentials file. Calls `/api/oauth/usage` via `curl --config` stdin — token never appears in `ps` or environ. Throttled to ~1/min via `~/.claude-bridge/live/last-oauth-refresh` marker. Writes rich response (spend, extra_usage, per-model quotas, structured limits, codenames) to `~/.claude-bridge/live/oauth-api.json`.
- **`bin/setup-check`** (`dist/setup-check.cjs`) + bundled SessionStart hook (`.claude-plugin/hooks/hooks.json`) — auto-activates on plugin install/update. Refreshes stable symlinks at `~/.claude/claude-bridge-{statusline,refresh-limits}.cjs` → cache dir. Auto-generates `~/.claude/claude-bridge-statusline-wrapper.sh` preserving user's original statusLine command. Prints a stderr banner with copy-paste snippets when setup is incomplete or version changed since last banner. Silent no-op when setup is complete and version unchanged. State file `~/.claude-bridge/setup-state.json`.
- **`src/parser/live-data.ts`** — shared reader/writer for `live/{statusline,oauth-api}.json` envelopes with lazy path resolution (respects mocked homedir in tests).
- **`src/parser/oauth-token.ts`** — token reader with platform-appropriate sources + safety validation.

### Added — new MCP tool

- **`peer_set_rate_limit_guard`** — account-scoped guard config for session (5h) + week (7d) utilization thresholds. Analog to existing `peer_set_context_guard` but USER-scoped (rate limits are per-account, not per-session). Defaults: session warn 0.85 / crit 0.95, week warn 0.75 / crit 0.90 (week is stricter because 7-day recovery hurts more than 5h). Config at `~/.claude-bridge/guard-rate-limits.json`. `rate_limit_status` output now includes `guard` field when configured.

### Added — new fields on `peer_context_status`

- **`effortLevel`** — `"low" | "medium" | "high" | "xhigh" | "max" | null`. From CC 2.1.119+ stdin `effort.level`. Reflects mid-session `/effort` changes, `null` on older CC or models without effort support.
- **`claudeCodeVersion`** — CC version string from stdin `version` field. Diagnostic aid for cross-peer compatibility checks.
- **`hasLiveData`** — boolean. True when the statusLine capture is readable and non-empty.
- **`setupPointer`** — string, present only when `hasLiveData: false`.

### Added — docs & skill

- **`docs/SETUP-LIVE-DATA.md`** (EN) + **`docs/cs/SETUP-LIVE-DATA.md`** (CS) — end-user setup instructions with copy-paste blocks, verification steps, troubleshooting section.
- **`docs/HOOKS-STATUSLINE-ARCHITECTURE.md`** — architectural explainer: data flow diagram, per-component responsibilities, failure-mode handling, rationale for file-based (not IPC / daemon) design.
- **`skills/claude-bridge-setup/SKILL.md`** — new bundled skill. Auto-triggers on "setup live data", "hasLiveData false", "install claude-bridge hooks" and related phrases. Decision tree for the four common failure modes (banner persists, hasLiveData=false after setup, rich fields missing, OAuth path never fires).

### Removed

- `src/parser/settings.ts` + `tests/unit/settings.test.ts`
- `detectContextLimit`, `detectContextLimitWithSource` functions from `src/parser/context-usage.ts`
- JSONL usage-field scan (`context-usage.ts` no longer imports `parseSessionFileRaw`)
- `readRateLimits(path)` signature in `src/parser/rate-limits.ts` — replaced by `readLiveRateLimits()` with no arguments (single canonical source)

### Tests

- 313 → 298 (net: -30 dead heuristic path tests, +15 live-data path tests covering statusLine capture, OAuth normalization, source priority, setup-check version comparison + config detection).

### Development

- Two new build targets in `package.json`: `build:refresh-limits`, `build:setup-check`.
- `dist/` gitignore updated to keep `dist/*.cjs` (previously only `dist/bundle.cjs`).
- 4 esbuild bundles now ship: `bundle.cjs` (MCP server ~795 KB), `statusline.cjs` (~8 KB), `refresh-limits.cjs` (~11 KB), `setup-check.cjs` (~11 KB).

### Verification (2026-07-07)

- End-to-end verified on maintainer setup: `peer_context_status` returns `contextLimitSource: "statusline-stdin"` with live model/effort/version fields; `rate_limit_status` returns `source: "statusline-stdin"` (immediately) and `source: "oauth-api"` (after ~60s PostToolUse throttle window elapses).
- Passthrough tested with benabraham's status-line (Python) as `CLAUDE_BRIDGE_UNDERLYING_STATUSLINE` — native ANSI rendering preserved, live capture happens in parallel.

## [0.9.0-alpha.2] — 2026-07-07 (pre-release, superseded by 0.9.0)

Continues the v0.9.0 breaking-change series. Alpha 1 shipped the statusLine wrapper + `peer_context_status` refactor; alpha 2 completes the rate-limits half.

### Breaking

`rate_limit_status` is live-data-only. Fossil `~/.claude/.usage_cache.json` read REMOVED.

New source priority (v0.9.0-alpha.2):
1. `~/.claude-bridge/live/statusline.json.rate_limits` (primary, per-turn from CC stdin)
2. `~/.claude-bridge/live/oauth-api.json` (secondary, throttled ~1/min via new PostToolUse hook)
3. Neither → `hasLiveData: false` + `setupPointer`

Newer capture wins when both are present. Older CC versions (< 2.1.80) that don't send `rate_limits` on statusLine stdin naturally fall through to the OAuth path.

Output shape changes:
- `source: "statusline-stdin" | "oauth-api" | "no-live-data"` (new, replaces `hasCache`)
- `hasLiveData: boolean` (was `hasCache`)
- `capturedAt`, `capturedAgeSeconds` (unchanged semantics — measures how old the live envelope is, not the fossil cache)
- `staleness`, `windowExpired` preserved from v0.8.2
- All richer fields (`spend`, `extraUsage`, `perModelWeekly`, `rawExperimental`, `scopedLimits`) only populated when the source is `oauth-api` — statusLine stdin doesn't carry them.

### Added

- **`bin/claude-bridge-refresh-limits`** — PostToolUse hook. Reads OAuth token from `~/.claude/.credentials.json` (or macOS Keychain), curl `/api/oauth/usage` via subprocess with `--config` stdin (token doesn't leak into `ps`), throttled to ~1/min via `~/.claude-bridge/live/last-oauth-refresh` marker. Never crashes — hook must be side-effect-only.
- **`src/parser/oauth-token.ts`** — token reader with platform-appropriate sources (macOS Keychain via `security find-generic-password`, Linux/Windows via credentials.json). Character-set validation prevents HTTP header injection.
- **`peer_set_rate_limit_guard` MCP tool** — new. Account-scoped guard config for session (5h) + week (7d) utilization thresholds. Analog to `peer_set_context_guard` but user-scoped (rate limits are per-account, not per-session). Defaults: session warn 0.85 / crit 0.95, week warn 0.75 / crit 0.90 (week is stricter since 7-day recovery hurts more than 5h). Config persisted to `~/.claude-bridge/guard-rate-limits.json`.
- **`bin/refresh-limits.cjs`** — new build target (11.2 KB esbuild bundle).
- **`src/parser/live-data.ts`** — added `readOAuthApiLive` + `writeOAuthApiLive` + lazy path helpers.

### Wiring (manual until v0.9.0-rc automates it)

Add to `~/.claude/settings.json`:

```json
"hooks": {
  "PostToolUse": [{
    "matcher": ".*",
    "hooks": [{
      "type": "command",
      "command": "node ~/.claude/claude-bridge-refresh-limits.cjs",
      "timeout": 6
    }]
  }]
}
```

Plus a symlink from `~/.claude/claude-bridge-refresh-limits.cjs` → cache dir's `refresh-limits.cjs` (analogous to the statusLine symlink introduced in alpha.1). v0.9.0-rc will maintain both symlinks automatically via a SessionStart hook.

### Tests

- 282 → 281 (rate-limits.test.ts rewritten for live-only shape: +6 normalizeFromOAuth cases, +5 normalizeFromStatusLine cases, +5 readLiveRateLimits priority cases; removed 15 fossil-cache path tests). Total net: -1 case but coverage of the new architecture is complete.

### Still pending for v0.9.0 stable

- rc: bundled SessionStart hook + `bin/setup-check` + banner, `claude-bridge-setup` skill (auto-maintains symlinks + generates wrapper script + detects underlying statusLine)
- docs: `docs/SETUP-LIVE-DATA.md` (EN + CS), `docs/HOOKS-STATUSLINE-ARCHITECTURE.md`
- Verification with jira-architect on HMH setup

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

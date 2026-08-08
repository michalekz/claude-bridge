# Known limitations

What this plugin does not do well yet, written down before you find out.

A limitation you read about here costs you an hour. The same limitation
discovered at 2am, undocumented, costs you your trust in the tool — and you
would be right to withdraw it. So this page is deliberately unflattering.

Everything below is measured on a live 23-peer fleet, not inferred. Where a
number appears, it was observed; where a cause is unknown, it says so.

---

## The control plane serialises every request

**What happens.** The daemon processes one request at a time. A long-running
operation blocks every other request — including read-only ones like
`control_status` — until it finishes.

**Measured** (2026-08-07): a `peer_compact` that waited 60 seconds for an anchor
held the queue for the whole minute. A `control_config` read submitted during
that window was picked up 2 ms after the compact ended. Its own work took 2 ms.
It had waited 60 seconds.

**How long operations can be:** `peer_compact` up to 300 s, `team_stop` up to
120 s per peer.

**What you will see.** Your call stops waiting and answers
`outcome: "pending"` with a `requestId`. The request usually completes
correctly afterwards.

**This part is fixed as of v0.11.10.** The timeout answer used to say
`ok: true, timedOut: true` and nothing else, which was wrong in both
directions — measured on 2026-08-08, one request reported that way completed
successfully 28 seconds later, and a `peer_compact` reported as timed out had
been recorded by the daemon as `ok` after 20.3 s. A wait that expires now says
so plainly, and `control_result` collects the real verdict:

```
control_result { requestId: "<the id from the pending answer>" }
  → outcome: settled | pending | unknown
```

A caller-side timeout has never cancelled anything server-side. **Do not
re-submit** a call that answered `pending` — the operation would run twice.

**Worse still: `claude-bridge-daemon status` reports health throughout.** It
reads a heartbeat file, not the queue. During a total blockage it answers in
60 ms and says everything is fine. *A heartbeat proves the process is alive. It
does not prove the process is serving.* If you are debugging a timeout, this
tool will send you looking for the fault in your own code.

**Until it is fixed:** if you orchestrate several agents, announce long
operations to the others first. On a shared machine, a series of compacts will
give everyone else timeouts on requests that are in fact succeeding.

**Status:** partly fixed. The timeout response is honest as of v0.11.10 and
`control_result` exists to collect the verdict. **The serialisation itself
remains**: a long operation still blocks read-only requests behind it, and
`claude-bridge-daemon status` still answers from the heartbeat rather than from
the queue. Separating read-only handlers from the serial loop is the remaining
work.

---

## `peer_compact` has been exercised very little

`peer_compact` asks a peer to write a durable anchor, waits for its
acknowledgement, and only then injects `/compact`.

It did not work at all between v0.10.0-rc and v0.11.0 — the message it sent
could not be read by the recipient, so every run ended in `anchor_timeout` and
was read as "the peer is not answering". Fixed in v0.11.0; a second defect
(a stale acknowledgement being accepted as the answer to a new request) was
fixed in v0.11.3.

**As of v0.11.5 the number of complete, unassisted cycles observed is small —
single digits.** Treat it as working but young. In particular:

- A peer writing a real anchor takes **minutes**, not seconds. Measured: 122 s
  on a peer with substantial context. The default timeout is 300 s for that
  reason; shortening it will produce `anchor_timeout` on work that is going
  fine.
- The acknowledgement is what proves the peer was idle — a peer only reads its
  inbox between turns. A busy peer simply does not answer in time and nothing is
  injected. That is the correct outcome, not a failure to handle the case.

---

## A spawn failure was observed once and never reproduced

On 2026-08-07 a `peer_spawn` reported `spawn_produced_no_process` 45 ms after
starting. Seven subsequent attempts under deliberately varied conditions — the
same working directory, a never-trusted directory, a missing directory, a
trivial command instead of Claude Code — all succeeded. **The cause is
unknown.**

Part of the reason it could not be investigated is now fixed: the tool used to
destroy the session on any unclear answer, which removed the pane holding the
explanation. Since v0.11.5 an unverifiable spawn returns `spawn_unverified`,
leaves the session standing, and tells you which pane to inspect.

If you hit this, capture the pane before doing anything else.

---

## `peer_spawn` does not put a peer in a team unless you say so

`team` is an optional argument. Omit it and the peer is created successfully —
and stays outside every team-scoped operation. `team_status`, `team_reconcile`
and `team_restart` will not see it.

Nothing warns you. The spawn looks like a success because it *is* a success;
it is just a success with a consequence nobody mentions.

**Status:** open. Either pass `team` explicitly, or adopt the peer afterwards
with `team_adopt`.

---

## Declared window positions are recorded, not enforced

`control_config` accepts `windowIndex` and `team_reconcile` reports when the
declared position and the real one disagree. **Nothing moves the window.**

This is deliberate. A control plane that silently rearranges a terminal a human
also edits would be making an intent out of an observation — and the human who
dragged that window would have no way to find out why it moved back. Asserting
the layout will arrive behind an explicit opt-in.

Every drift report carries both values and both ways out: `assert` (make the
world match the declaration) and `adopt` (accept reality as the new
declaration).

Note that restarting a peer destroys and recreates its window, so it moves to
the end of the session. Window ORDER therefore drifts on every fleet roll.

---

## The registry and the fleet are independent

`state.json` is the daemon's record of which peers exist. The peers themselves
are tmux sessions and processes, and they do not depend on that record.

This is mostly a good property — losing the registry does not stop any agent
working — but it has a sharp edge: **the control plane can be completely wrong
without anything appearing to be broken.** A registry that lost every entry
still leaves 23 agents happily working, and you find out when you run
`team_status` and see one peer.

`team_reconcile` compares the two and is cheap. Run it after anything unusual.
`team_adopt` rebuilds the registry from what is actually running, which is the
correct recovery when the two have diverged.

---

## A spawned peer has two identities, and they never meet

**What happens.** `peer_spawn` takes the peer's `sessionId` as an argument. For
a resume that is a real Claude Code session UUID. For a fresh spawn the schema
says "stable name for a new spawn" — so the caller invents a string, and the
daemon keys its whole registry on it.

Meanwhile the Claude Code process that starts inside that pane mints its own
session id, and the daemon never learns it. The two identities coexist for the
life of the peer:

| Who is asked | Answer for the same running process |
|---|---|
| `team_status` (daemon registry) | `tst-c` |
| `peer_list` (bridge) | `tst-c-3e`, id `e8197b26-f873-40fb-afec-4e370b5c0997` |
| tmux | session `tst-c`, window `@2226`, pane pid 2249670 |

Both are "right". Nothing reconciles them, and nothing can: the daemon's key was
never a measurement, it was a wish.

**Measured on the live fleet** (2026-08-08): 25 of 26 registry keys are genuine
session UUIDs. The one that is not is the only peer created by `peer_spawn`
rather than adopted. Adoption reads identity off reality, so it cannot get this
wrong; spawn is the only path that invents one.

**Why it is usually invisible.** Lifecycle operations address a peer by its tmux
target, which is correct either way, so `peer_compact`, `wake`, `peer_stop` and
`peer_restart` all work on such a peer. What fails is anything that has to
cross-reference the two sides — reading a spawned peer's context, matching a
daemon record to a bridge message, or a human comparing two tool outputs and
concluding one of them is broken.

**A second, independent cause made it visible.** The peer's name, `tst-c-3e`, is
not the bridge's invention either. Claude Code derived it: its session file
records `"nameSource": "derived"`, and the shape is the working directory's
basename plus two opaque characters. That derived name is present for every
session nobody has renamed — 2 of 26 here — but it is normally hidden, because
the bridge prefers the transcript title. This peer has no transcript at all
(no project directory exists for its working directory), because nothing has
ever spoken to it. So the fallback name surfaced.

Put together: the identity was wrong from the moment of spawn, and it took a
peer that had never held a conversation for anyone to see it.

**The shape of the defect.** `PeerRecord` was split into `desired` and
`observed` in v0.11.0 precisely because intent and measurement are different
kinds of claim. `sessionId` was left outside that split, and it belongs on the
`observed` side: **only the peer can mint its own session id.** Accepting it as
an argument is the same confusion, one level up from where it was fixed.

**Until it is fixed:** address spawned peers by their tmux target, and do not
expect `team_status` and `peer_list` to agree about them. `team_adopt` rebuilds
the registry from reality and will replace an invented key with the real one.

**Status:** open (task #86). The peer that reproduces it is being kept alive
untouched.

---

## Injected payloads are one line and at most 800 characters

Anything the control plane types into a pane — `/compact`, a wake prompt, a
custom `wakePrompt` you pass in — goes through one function that refuses
multi-line payloads and payloads over 800 characters, before touching tmux.

Both refusals exist because the alternative is worse than an error: a newline
becomes an Enter that submits the payload in pieces, and Claude Code collapses a
longer burst into a `[Pasted text #N]` placeholder that makes delivery
unverifiable. `docs/SEND-KEYS.md` has the measurements.

**Status:** by design, but the ceiling is real. A caller that needs to deliver a
long instruction should write it to the peer's inbox and inject only a short
prompt telling it to read.

---

## Reading the input box depends on one Claude Code character

The clear-before-send hygiene finds the input box by its prompt marker, `❯`
(U+276F). That is Claude Code's rendering choice, not a contract.

If a future version draws a different marker, the daemon stops recognising the
box. It does not break — it treats the pane as "not a Claude Code input box",
sends a single `C-u` and proceeds — but it **stops being able to prove the line
was clear**, and a wrapped draft could once again end up prefixed to a payload.

The failure is silent by construction: everything keeps working, only the
guarantee is gone. If you upgrade Claude Code and something about injected
commands looks wrong, check `inputLine` in
`~/.claude-bridge/control/logs/sendkeys-*.log` — a sudden run of
`not-an-input-box` on panes that are plainly running Claude Code is the tell.

---

## Platform support is uneven

- **Linux + tmux** — what the fleet runs on, and where everything above was
  measured.
- **Windows** — the MCP server works; the control-plane daemon has no host
  driver, so peer lifecycle tools are unavailable. Last verified end to end at
  v0.9.3.
- **macOS** — expected to work like Linux, not currently exercised.

---

## Two definitions of the message schema

The MCP server and the daemon each carry their own copy of the envelope schema
and of several path helpers. A contract test holds them together, but they are
genuinely two definitions. If you fork this, change both.

**Status:** open (task #65).

---

## Where the honest record lives

`~/.claude-bridge/control/events.jsonl` records every request, its outcome and
its duration. It has repeatedly turned out to be more reliable than the tool
output — including for the maintainers. When a report and this file disagree,
believe the file.

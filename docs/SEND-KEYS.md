# Typing into someone else's terminal

The control plane delivers some things by typing them into a pane: `/compact`
for `peer_compact`, a re-onboarding prompt for a wake. Those panes belong to
people, and a person may have a half-written sentence sitting in the box.

Every injection goes through one function — `TmuxDriver.sendKeys` — and this
page is what that function knows. All of it was measured on 2026-08-08 against
**Claude Code v2.1.224** in tmux on a **188-column** pane. Nothing here is
inferred from documentation; two of the numbers contradicted what the author
believed before measuring.

---

## The sequence

| # | Step | Fails how |
|---|------|-----------|
| 1 | Refuse an undeliverable payload | Throws before any tmux call — the pane is untouched |
| 2 | Cancel copy-mode if the pane is in it | Ignored; a pane in copy-mode swallows input silently |
| 3 | Clear the input line and prove it is clear | Throws if it cannot be cleared |
| 4 | Send the text alone, confirm it is visible | Retries once, then throws |
| 5 | Send Enter | — |

Step 4 before step 5 is the v0.10.1 rule and it stands: text is checked while
the line is still uncommitted, so a failure costs nothing.

---

## A newline picks the route (v0.11.26)

```
payloadRoute(keys)    →   "typed" | "pasted"
refusePayload(keys)   →   "carriage-return" | "too-long-to-type"
                          | "beyond-measured-paste" | null
```

tmux turns every `\n` in a `send-keys` argument into Enter, so a multi-line
payload typed that way is **submitted in pieces**. Measured 2026-08-09, the same
four-line payload:

| route | what reached the peer |
|---|---|
| `paste-buffer` without `-p` | three user messages, fourth line orphaned in the box |
| `paste-buffer -p` | **one** user message of four lines |

`-p` brackets the paste, so the client reads the newlines as content. That is
the whole difference, and it is why a newline used to be an outright refusal:
until the paste route existed there was no way to deliver one honestly.

**Carriage return stays refused.** Nothing was measured about how Claude Code
counts `\r`, and the paste route proves delivery by comparing a count. Send
`\n` only.

## When the box stops showing the payload

Claude Code replaces a collapsed paste with a placeholder. Two triggers,
either one is enough — both measured 2026-08-09 on 2.1.226:

| payload | what the box shows |
|---|---|
| 15 chars, 2 line breaks | the text, on three rows |
| 1 500 chars, 2 line breaks | `[Pasted text #7 +2 lines]` |
| 7 chars, 3 line breaks | `[Pasted text #4 +3 lines]` |
| 1 200 chars, 0 line breaks | `[Pasted text #6]` |

**The count is LINE BREAKS, not lines.** A four-line payload reports `+3`. The
contract was first drafted expecting `+4`; the pane refuted it, and a verifier
written to the draft would have rejected every correct delivery.

So the verification has three outcomes rather than two:

| verdict | meaning | Enter? |
|---|---|---|
| `input-line` | the payload itself is in the box | yes |
| `pasted-placeholder` | a placeholder whose count matches what was sent | yes |
| `pasted-line-count-mismatch` | something is in the box, and it is not this | **no** |

`pasted-placeholder` is deliberately **weaker** than `input-line` and is named
so a log reader can tell: it proves a paste of the right size arrived, not that
this text arrived. That is the strongest claim the client leaves available once
it collapses the text, and overstating it in the log would be worse than the
weakness itself.

**The 800-character ceiling belongs to the typed route only.** Over it, the
placeholder carries no count at all — `[Pasted text #6]` — and the delivery
becomes unprovable. Pasted payloads of 4 019, 16 019 and 60 023 characters all
arrived reporting `+5 lines` exactly; 60 000 is where the evidence stops, not
where the mechanism does, and past it the send is refused rather than guessed.

**Retry only into an empty box.** The retry was written for a pane that had not
settled. Once the box holds something that fails to verify, sending again
cannot improve it and can make it strictly worse: a second paste stacks a
second placeholder, and the count then disagrees by construction — turning a
recoverable "did not arrive" into an unrecoverable "arrived twice".

---

## Clearing the input line

**`C-u` kills to the start of the display ROW, not of the input.**

| Draft | One `C-u` removes |
|-------|-------------------|
| 4971 chars on a 188-column pane | exactly 184 — the pane width minus the box frame |
| 740 chars (4 full rows + 4) | 4 — the last row was 4 characters long |

So a single `C-u`, which is what "clear the line first" literally asks for,
would delete one visual row of a wrapped draft and append the payload to the
rest. `Escape` does not clear the box at all (609 characters in, 608 after).

The clear therefore loops, in batches of 4 strokes per tmux round trip
(measured: three `C-u` in one call kill three rows), up to 40 strokes ≈ 7 000
characters. A stroke against an already-empty box is a no-op that leaves the
kill ring intact, so over-sending within a batch is free.

**Termination is exact, not heuristic.** The box's content always begins on the
marker line (`❯`, U+276F) and shrinks from the bottom, so the marker line is
empty if and only if the whole box is.

**If it cannot be cleared, nothing is typed.** A draft we cannot clear is a
draft we would corrupt, and the error names the pane to look at.

---

## The human's work is recoverable — and they are told so

Claude Code keeps its own kill ring. Measured:

- `Ctrl+Y` restores a `C-u` **exactly**
- it survives an intervening payload, an Enter, and a completed agent turn
- it **composes**: 402 characters cleared by twenty strokes came back whole, from
  the first character, on one press

So the daemon is not destroying anything. What it is doing is making a person's
text vanish without telling them, and that is fixed with two channels:

| Channel | Reaches | Lifetime |
|---------|---------|----------|
| `tmux display-message` on the target | whoever is sitting there now | 8 seconds |
| `peer_input_displaced` in `events.jsonl` | whoever comes back in an hour | permanent |

Neither is sufficient alone.

> **The notice must never be folded into the payload.** The payload is addressed
> to the application in the pane. For `peer_compact` it is `/compact`, which
> takes free text as its *compaction instructions* — a sentence meant for a
> person would silently steer what the peer keeps. For a wake it is a prompt for
> the agent. **Payload belongs to the application, notices belong to the human,
> history belongs to the log. Never mixed.**

---

## Two details that are easy to get wrong

**Send text with `-l --`.** `send-keys -t X Enter` presses Enter; it does not
type the word. A payload starting with `-` is parsed as a tmux option. `-l`
(literal) and `--` (end of options) remove both. The Enter at step 5 is sent
*without* `-l`, because there the key is what is wanted.

**The capture is taken with `-e`, and the stripping is ours** (v0.11.38). Until
then it was `capture-pane -p`, which returns clean text and needed no
stripping. The escapes had to come back for one reason: Claude Code draws a
PROMPT SUGGESTION in an empty box, and in a clean capture that suggestion is
byte-for-byte a person's unsent sentence. On 2026-08-28 the hygiene phase spent
all 40 strokes trying to clear 47 characters nobody had typed and then refused
the send — a safeguard against typing on a human's text, fired by text the
machine had written to itself.

A suggestion is drawn DIM (SGR 2); human text is not. So `decodeCapture` reads
the escapes and returns two views of the same instant:

| view | what it is | who reads it |
|---|---|---|
| `plain` | byte-identical to the old `capture-pane -p` | delivery predicates, the log |
| `withoutGhosts` | every dimmed character replaced by a space | "is the box empty", "what draft is in it" |
| `ghostChars` | non-blank characters that blanking removed | the log, so the two views can differ visibly |

Three measurements shape the decoder, and all three are in its comment:
dim state **carries across rows** (a wrapped suggestion declares `ESC[2m` once,
so a per-line regular expression filters nothing); a capture region **declares
the state it starts in** (nothing is inherited from above it); and stripping
OSC + SGR and right-trimming each row **reproduces `capture-pane -p` byte for
byte**, which is why turning `-e` on did not disturb what the delivery
predicates read.

---

## Matching: strip whitespace, do not collapse it

`paneContains` removes **all** whitespace from both the capture and the payload
before comparing the last 40 characters. Collapsing it to single spaces instead
— which is what v0.10.1 through v0.11.5 did — breaks on wrapping, because tmux
puts a newline *inside* the text and the needle has no space there.

Measured on a 188-column pane, the collapsing rule rejected payloads of 200 and
400 characters that had arrived perfectly, while accepting 300, 500, 600, 700
and 800: it passed or failed according to where the wrap happened to land
relative to the tail. **A verification layer whose verdict depends on the
reader's terminal width is not a verification layer.**

The cost is that whitespace inside a payload is not verified. For a delivery
proof that is the right trade.

---

## Most messages never come through here

Worth knowing before you try to test this layer: a message to an **idle peer
with a live channel** is delivered over the channel socket and never touches
send-keys. Sending a `peer_ask` and then looking for a line in
`control/logs/sendkeys-*.log` finds nothing, and the natural conclusion — "the
send layer is broken" — is wrong.

Only two paths type into a pane:

| Path | When |
|------|------|
| `peer_compact` | after the anchor ack, to inject `/compact` |
| `wake` | to a peer that has just been resumed and has no live channel yet |

To exercise the layer deliberately, drive `TmuxDriver.sendKeys` directly
against a pane running Claude Code.

---

## If the environment changes

These numbers belong to a configuration, so re-run the checks after changing it
rather than assuming they carry.

They have survived one such change already. On 2026-08-08 `allow-passthrough`
and `extended-keys` were turned on (Anthropic's recommended tmux settings) and
every measurement was repeated against a live Claude Code pane:

| Measurement | before the flip | after |
|---|---|---|
| collapse boundary | 800 literal / 801 collapsed | unchanged |
| characters killed per `C-u` | 184 | unchanged |
| full clear→send→verify→Enter cycle, 377-char draft over 3 rows | 6 checks pass, draft recorded exactly | unchanged |

`extended-keys` in particular did not disturb Enter: the payload was submitted
and the agent acted on it.

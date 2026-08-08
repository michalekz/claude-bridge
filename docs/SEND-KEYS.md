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

## A payload is one line, and at most 800 characters

```
refusePayload(keys)   →   "multiline" | "too-long" | null
```

**Multiline.** tmux turns every `\n` in a `send-keys` argument into Enter. A
two-line payload submits the first line on its own and leaves the second
hanging in the box. If a multi-line payload is ever genuinely needed, the routes
are `Ctrl+J` (a newline that does not submit) or `load-buffer` +
`paste-buffer -p`; both need their own verification story because of the limit
below.

**Over 800 characters.** Claude Code collapses the input into a
`[Pasted text #N +X lines]` placeholder.

| Length | What lands in the box | Verifiable |
|--------|-----------------------|------------|
| 800 | the text, literally | yes |
| 801 | `[Pasted text #1]` | **no** |

The collapse is decided by the arrival burst, **not** by bracketed-paste
markers — raw `send-keys` trips it just as a paste does. This was measured
precisely because the opposite had been argued.

What is lost is not the text — the full string is in the box, behind the
placeholder — it is the **proof**. The pane no longer contains the payload, so
step 4 fails, Enter is never sent, and the text stays in the box for the next
caller to prepend to. Reported failure, actual success, booby trap left behind.
Hence: refused up front.

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

**`capture-pane -p` returns clean text.** No ANSI escapes, so no stripping is
needed before matching — and none is done. If anyone ever adds `-e` to capture
colours for an audit trail, they must add the stripping in the same change.

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

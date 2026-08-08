/**
 * Reading and clearing the Claude Code input box — the pure half.
 *
 * Everything here is a function of captured pane text, so it is testable
 * without a tmux server. The I/O half lives in `tmux-driver.ts`.
 *
 * WHY THIS FILE EXISTS
 *
 * The control plane types into terminals that a human is also using. Before
 * v0.11.6 it typed on top of whatever was already there: a half-written
 * question in the box became a prefix of the daemon's payload, and Enter sent
 * the mixture. Zdeněk's instruction (2026-08-07, via plt-velitel) was
 * "hygiene — first I clear, then I send keys", and that it belong to the tool
 * rather than to each caller.
 *
 * EVERY CONSTANT AND RULE BELOW WAS MEASURED on 2026-08-08 against Claude Code
 * v2.1.224 in tmux on a 188-column pane (peer `tst-b`). None of it is inferred
 * from documentation, and two of the measurements refuted what the author
 * believed at the time.
 */

/**
 * The prompt marker Claude Code draws at the start of its input box.
 *
 * U+276F HEAVY RIGHT-POINTING ANGLE QUOTATION MARK, followed by U+00A0.
 *
 * The box always renders, empty or not, and its content always BEGINS on the
 * marker line — a draft too long for one row wraps onto following rows that
 * carry no marker. So the marker line alone decides emptiness, and it decides
 * it exactly: content shrinks from the bottom, so the marker line is the last
 * thing to empty.
 */
export const INPUT_MARKER = "❯";

/**
 * Longest payload Claude Code will accept as typed text.
 *
 * Measured by bisection: 800 characters land literally, 801 are collapsed into
 * a `[Pasted text #N +X lines]` placeholder. Anthropic's terminal
 * documentation states the same number, and the measurement was run because
 * the author had argued the limit could not apply to us — we send raw
 * `send-keys`, not a bracketed paste, and the collapse is documented for
 * pastes. That argument was WRONG: Claude Code decides from the arrival burst,
 * not from paste markers.
 *
 * The consequence is not lost text — the full string is in the box behind the
 * placeholder — it is lost PROOF. The pane no longer contains the payload, so
 * delivery cannot be verified, `sendKeys` throws, Enter is never sent, and the
 * text sits in the box for the next caller to prepend to. Reported failure,
 * actual success, with a booby trap left behind.
 *
 * So an over-long payload is refused BEFORE anything is typed.
 */
export const PASTE_COLLAPSE_LIMIT = 800;

/**
 * How many `C-u` strokes to spend clearing a draft.
 *
 * `C-u` in the Ink TUI kills from the cursor to the start of the DISPLAY row,
 * not to the start of the logical input. Measured: a 4971-character draft on a
 * 188-column pane lost exactly 184 characters per stroke — pane width minus the
 * box frame — and a 740-character draft lost 4 on the first stroke, that row
 * being 4 characters long. `Escape` does not clear the box at all (609
 * characters in, 608 after).
 *
 * A naive single `C-u`, which is what the instruction literally asks for, would
 * therefore delete one visual row of a wrapped draft and append the payload to
 * the remainder — the exact harm the instruction exists to prevent.
 *
 * 40 strokes covers roughly 7 000 characters of draft on a wide pane. Beyond
 * that the send is refused rather than sent onto a human's text.
 */
export const MAX_CLEAR_STROKES = 40;

/** Strokes per tmux round trip. Measured: three `C-u` in one call kill three rows. */
export const CLEAR_STROKE_BATCH = 4;

/** Claude Code's own offer to undo a `C-u`, as it appears in the status row. */
export const KILL_RING_HINT = "Ctrl+Y to paste deleted text";

/**
 * What the input box held when we looked.
 *
 * `no-marker` is not a failure. It means we are not looking at a Claude Code
 * input box — a shell, a pager, a pane still starting up — and the caller
 * must not treat inability to parse a foreign TUI as grounds for refusing to
 * work.
 */
export type InputLineProbe =
  | { kind: "empty" }
  | { kind: "draft"; text: string }
  | { kind: "no-marker" };

/** Box-drawing rule that closes the input box. */
const RULE = /^[─-╿\s]+$/;

/**
 * Read the input box out of captured pane text.
 *
 * Emptiness comes from the marker line and is exact.
 *
 * The draft TEXT is un-wrapped geometrically rather than by guessing at the
 * indent: content on the marker line starts one column past the marker and its
 * separator, and the wrapped rows below line up with it, so each row is cut at
 * that same column. Stripping "one or two leading spaces" instead loses a space
 * that a wrap happens to land in front of — measured live, a 377-character
 * draft came back as 376.
 *
 * It is still evidence for a human reading the audit log, not a restore
 * mechanism. The restore is `Ctrl+Y`, and that one is Claude Code's own.
 */
export function readInputLine(captured: string): InputLineProbe {
  const lines = captured.split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.includes(INPUT_MARKER)) {
      at = i;
      break;
    }
  }
  if (at < 0) return { kind: "no-marker" };

  const markerLine = lines[at] ?? "";
  // The marker, then one separator column, then the content.
  const contentCol = markerLine.indexOf(INPUT_MARKER) + INPUT_MARKER.length + 1;
  const head = markerLine.slice(contentCol);
  if (head.trim().length === 0) return { kind: "empty" };

  const rows = [markerLine];
  let boxWidth = 0;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (RULE.test(line)) {
      // The closing rule spans the box, so it gives the inner content width.
      boxWidth = line.length - contentCol;
      break;
    }
    rows.push(line);
  }

  // Rejoin the rows. A row that stopped SHORT of the box width was broken at a
  // space, and that space is in neither row — Claude Code word-wraps, and the
  // captured pane simply does not contain the character. A row that ran to the
  // full width was broken mid-word, where nothing was consumed. Measured live:
  // ".konec" ended one row and "KONEC-lidske-prace" began the next, while a
  // 300-character unbroken run split with no space at all, both in one draft.
  const parts: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] ?? "";
    parts.push(raw.slice(contentCol).trimEnd());
    const wordWrapped = boxWidth > 0 && raw.length < boxWidth;
    if (i < rows.length - 1 && wordWrapped) parts.push(" ");
  }
  const text = parts.join("").trim();
  return text.length === 0 ? { kind: "empty" } : { kind: "draft", text };
}

/**
 * Is the injected text visible in the captured pane?
 *
 * ALL whitespace is removed from both sides before comparing, rather than
 * collapsed to single spaces. The difference is not cosmetic: a payload longer
 * than the pane is wrapped by tmux, which puts a newline INSIDE the text, and
 * collapsing turns that newline into a space that the needle does not have.
 *
 * Measured on a 188-column pane: the collapsing rule failed to recognise
 * payloads of 200 and 400 characters that had arrived perfectly, while
 * accepting 300, 500, 600, 700 and 800 — it passed or failed according to where
 * the wrap happened to land relative to the 40-character tail. The stripping
 * rule accepted all eight lengths. A verification layer whose verdict depends
 * on the reader's terminal width is not a verification layer.
 *
 * The cost is that whitespace within a payload is not verified. For a delivery
 * proof that is the right trade.
 */
export function paneContains(captured: string, keys: string): boolean {
  const strip = (s: string) => s.replace(/\s+/g, "");
  const needle = strip(keys);
  if (needle.length === 0) return true;
  const haystack = strip(captured);
  // Match on the tail: the head of a long draft may have scrolled off.
  const probe = needle.length > 40 ? needle.slice(-40) : needle;
  return haystack.includes(probe);
}

/** Why a payload may not be typed into a pane at all. */
export type PayloadRefusal = { reason: "multiline" | "too-long"; message: string };

/**
 * Refuse payloads the send layer cannot deliver honestly.
 *
 * MULTILINE — tmux turns every `\n` in a send-keys argument into Enter, so a
 * two-line payload submits the first line on its own and leaves the second
 * hanging. If a multi-line payload is ever genuinely needed the route is
 * `Ctrl+J` for a newline that does not submit, or `load-buffer` +
 * `paste-buffer -p`; both need their own verification story because of the
 * collapse limit above. Until then: a payload is one line.
 *
 * TOO LONG — see `PASTE_COLLAPSE_LIMIT`.
 *
 * Both refusals are checked before any key is sent, so a rejected payload
 * leaves the target pane exactly as it was found.
 */
export function refusePayload(keys: string): PayloadRefusal | null {
  if (/[\n\r]/.test(keys)) {
    return {
      reason: "multiline",
      message:
        "payload contains a newline — tmux sends each one as Enter, which would submit the payload in pieces. A payload is one line; see docs/SEND-KEYS.md.",
    };
  }
  if (keys.length > PASTE_COLLAPSE_LIMIT) {
    return {
      reason: "too-long",
      message: `payload is ${keys.length} characters — Claude Code collapses anything over ${PASTE_COLLAPSE_LIMIT} into a "[Pasted text]" placeholder, after which delivery cannot be verified. See docs/SEND-KEYS.md.`,
    };
  }
  return null;
}

/**
 * What the human is told when the control plane took their draft.
 *
 * Addressed to a PERSON, not to an operator reading logs: it names who did it,
 * why, and the one keystroke that undoes it. `Ctrl+Y` restores everything even
 * when the draft took dozens of strokes to clear — measured: 402 characters
 * cleared by twenty strokes came back whole, from the first character, on one
 * press.
 */
export function displacedDraftNotice(): string {
  return "⚠ claude-bridge cleared your unsent draft to deliver an automated command — press Ctrl+Y to get it back";
}

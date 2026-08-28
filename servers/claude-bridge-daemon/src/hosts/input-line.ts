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

/**
 * Reading a capture that still has its escape sequences — and why we now take one.
 *
 * MEASURED 2026-08-28, after `peer_compact` on peer `ai-bridge-dev` failed in
 * its send stage. The clear-verify reported 47 characters it could not clear,
 * and the "draft" it refused to type onto was never a draft: it was Claude
 * Code's own PROMPT SUGGESTION, the greyed-out sentence the client offers in an
 * empty box. `C-u` cannot clear it, because there is nothing in the box to
 * clear — so every stroke was spent and the send was refused to protect a
 * person's text that nobody had written.
 *
 * A suggestion is drawn DIM (SGR 2) and a person's text is not, so the two are
 * distinguishable — but only in a capture taken with `-e`, which keeps the
 * escape sequences. Without it the client's suggestion and a human sentence are
 * the same bytes. The fleet's delivery watchdog found this first and filters
 * the same attribute (/opt/hmh, commit dcc5fd5).
 *
 * THREE MEASUREMENTS SHAPE WHAT IS BELOW.
 *
 * 1. DIM STATE CARRIES ACROSS ROWS. A suggestion too long for one row declares
 *    `ESC[2m` on its first row only; continuation rows carry no sequence at all
 *    and the run closes at the end of the last one. A per-line regular
 *    expression therefore sees an unterminated run and filters NOTHING on a
 *    wrapped suggestion. That is why this is a state machine over the whole
 *    capture and not a substitution per line.
 *
 * 2. A CAPTURE REGION DECLARES THE STATE IT STARTS IN. Capturing only the
 *    continuation row of a wrapped run re-emits `ESC[2m` at its head, so no
 *    attribute is inherited from above the region. The state machine is
 *    complete with what it is handed.
 *
 * 3. STRIPPING OSC AND SGR AND TRIMMING EACH ROW'S TRAILING WHITESPACE
 *    REPRODUCES `capture-pane -p` BYTE FOR BYTE — checked on a static pane and
 *    on a live pane that did not change between the two reads. That equality is
 *    what lets `plain` keep feeding the delivery predicates unchanged: turning
 *    `-e` on changes what we can SEE, not what they read.
 *
 * Dimmed characters are BLANKED, not deleted, because `readInputLine` un-wraps
 * the box by column arithmetic — deleting would slide the rest of a row left
 * and take the geometry with it. Blanking is done per UTF-16 unit for the same
 * reason: one unit in, one unit out.
 */
export interface DecodedCapture {
  /** Byte-identical to what `capture-pane -p` would have returned. */
  plain: string;
  /** The same pane with every dimmed character replaced by a space. */
  withoutGhosts: string;
  /** Non-blank characters that blanking removed. 0 means the two views agree. */
  ghostChars: number;
}

/** OSC (hyperlinks), CSI (SGR among them), and two-character escapes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the subject — this reads terminal output
const ESCAPE_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;

/** An SGR sequence and its parameters — the only kind that changes dim state. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the subject — this reads terminal output
const SGR = /^\x1b\[([0-9;]*)m$/;

/**
 * Apply one SGR sequence to the dim state.
 *
 * Only three parameters matter: `2` turns dim on, `22` turns it off, and `0`
 * (as does a bare `ESC[m`) resets everything. Colours are the bulk of what
 * Claude Code emits and they leave dim exactly as they found it — which is why
 * a filter that keyed on "grey" would be wrong: the status row draws grey with
 * `38;5;246`, a colour, while a suggestion is an ATTRIBUTE.
 */
function nextDimState(current: boolean, params: string): boolean {
  let dim = current;
  for (const p of params.split(";")) {
    if (p === "" || p === "0") dim = false;
    else if (p === "2") dim = true;
    else if (p === "22") dim = false;
  }
  return dim;
}

/** Same length, same rows — only the characters go. */
function blankRun(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

function countVisible(text: string): number {
  return (text.match(/\S/g) ?? []).length;
}

/** tmux drops trailing whitespace per row without `-e`; with `-e` it does not. */
function trimRows(text: string): string {
  return text
    .split("\n")
    .map((row) => row.replace(/[ \t]+$/, ""))
    .join("\n");
}

export function decodeCapture(raw: string): DecodedCapture {
  const plain: string[] = [];
  const ghostFree: string[] = [];
  let dim = false;
  let ghostChars = 0;
  let at = 0;
  ESCAPE_SEQUENCE.lastIndex = 0;
  for (let m = ESCAPE_SEQUENCE.exec(raw); m !== null; m = ESCAPE_SEQUENCE.exec(raw)) {
    const text = raw.slice(at, m.index);
    plain.push(text);
    if (dim) {
      ghostFree.push(blankRun(text));
      ghostChars += countVisible(text);
    } else {
      ghostFree.push(text);
    }
    at = m.index + m[0].length;
    const sgr = SGR.exec(m[0]);
    if (sgr) dim = nextDimState(dim, sgr[1] ?? "");
  }
  const tail = raw.slice(at);
  plain.push(tail);
  if (dim) {
    ghostFree.push(blankRun(tail));
    ghostChars += countVisible(tail);
  } else {
    ghostFree.push(tail);
  }
  return {
    plain: trimRows(plain.join("")),
    withoutGhosts: trimRows(ghostFree.join("")),
    ghostChars,
  };
}

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

/**
 * Claude Code's stand-in for a payload it decided not to draw.
 *
 * TWO FORMS, and the difference carries the whole proof:
 *
 *   [Pasted text #7 +2 lines]   — the payload had 2 line breaks
 *   [Pasted text #6]            — the payload had none
 *
 * MEASURED 2026-08-09 on Claude Code 2.1.226, and the measurement refuted the
 * number this contract was first drafted with. A four-LINE payload reports
 * `+3 lines`: the count is LINE BREAKS, not lines. A contract written to
 * compare it against a line count would have rejected every correct delivery
 * and passed nothing.
 *
 * The `#N` is a per-session counter and increments on every paste, so it is
 * matched but never predicted.
 */
export const PASTED_PLACEHOLDER = /^\[Pasted text #(\d+)(?: \+(\d+) lines?)?\]$/;

/**
 * When Claude Code collapses a pasted payload instead of drawing it.
 *
 * MEASURED — two independent triggers, either one is enough:
 *
 * | payload                          | box                          |
 * |----------------------------------|------------------------------|
 * | 15 chars, 2 breaks               | the text, on three rows      |
 * | 1500 chars, 2 breaks             | `[Pasted text #7 +2 lines]`  |
 * | 7 chars, 3 breaks                | `[Pasted text #4 +3 lines]`  |
 * | 1200 chars, 0 breaks             | `[Pasted text #6]`           |
 *
 * The verifier does not use this to PREDICT which form to expect — it accepts
 * either and checks whichever arrived. The constant is here because the
 * boundary is a measured property of the client and belongs written down.
 */
export const PASTE_COLLAPSE_LINE_BREAKS = 3;

/** Line breaks in a payload — the number the placeholder reports. */
export function countLineBreaks(keys: string): number {
  let n = 0;
  for (const ch of keys) if (ch === "\n") n++;
  return n;
}

/**
 * How a payload has to reach the input box.
 *
 * `send-keys -l` turns every newline into Enter, so a multi-line payload typed
 * that way is SUBMITTED IN PIECES. Measured 2026-08-09: a four-line payload
 * pasted without bracketing produced three separate user messages in the
 * peer's transcript and left the fourth line sitting in the box. The same
 * payload through `load-buffer` + `paste-buffer -p` produced exactly one
 * message of four lines.
 *
 * So the newline is not a formatting detail, it is the choice of route.
 */
export type PayloadRoute = "typed" | "pasted";

export function payloadRoute(keys: string): PayloadRoute {
  return keys.includes("\n") ? "pasted" : "typed";
}

/**
 * WHERE the payload was found — the delivery contract.
 *
 * `input-line`, `no-input-box` and `pasted-placeholder` license an Enter; the
 * rest do not, and they are kept apart because they call for different actions.
 *
 * `pasted-placeholder` is DELIBERATELY WEAKER than `input-line` and is named so
 * that a log reader can tell. Under it the pane no longer holds the payload, so
 * what is proven is "a paste of the right size arrived", not "this text
 * arrived". That is the strongest claim the client leaves available once it
 * collapses the text, and overstating it in the log would be worse than the
 * weakness itself.
 */
export type DeliveryWhere =
  | "input-line"
  | "no-input-box"
  | "pasted-placeholder"
  | "pasted-line-count-mismatch"
  | "elsewhere-on-pane"
  | "absent";

export type DeliveryProbe = {
  delivered: boolean;
  where: DeliveryWhere;
  /** What the input box held when we looked — evidence for the log. */
  inputLine: InputLineProbe;
};

/**
 * Is the payload in the box we are about to submit?
 *
 * The old check was `paneContains(wholePane, keys)`, and it answered a
 * different question: "is this string visible anywhere on screen". Those two
 * questions come apart, and the difference is an Enter pressed on something
 * nobody verified — the command palette, a transcript line quoting the payload,
 * a line still being rendered. Verification that searches the whole screen
 * verifies VISIBILITY, not DELIVERY.
 *
 * MEASURED 2026-08-09 on Claude Code 2.1.226, and it settles a design question
 * the P0 brief got wrong: the slash palette does NOT carry the `❯` marker, and
 * it is drawn BELOW the box's closing rule. So with `/repro-marker` typed and
 * the palette open, `readInputLine` returns exactly `draft: "/repro-marker"`.
 *
 * That matters, because the brief asked for "and the pane is not showing a
 * palette". Implemented literally that would refuse every slash command
 * forever — `/compact` opens the palette by being typed. The palette is not the
 * hazard; submitting text nobody located is. So the contract is positional
 * only: the payload must be IN THE BOX.
 */
export function inputLineHolds(captured: string, keys: string): DeliveryProbe {
  const inputLine = readInputLine(captured);
  if (inputLine.kind === "draft" && paneContains(inputLine.text, keys)) {
    return { delivered: true, where: "input-line", inputLine };
  }
  /**
   * THE PAYLOAD IS IN THE BOX BUT THE BOX NO LONGER SHOWS IT.
   *
   * Claude Code replaces a collapsed paste with a placeholder, and from that
   * moment the content check above can never pass — the text is not on the
   * pane to be found. Before this branch existed the only honest answer was to
   * refuse multi-line payloads outright, because a send that reports failure
   * after actually succeeding leaves the text in the box for the next caller
   * to prepend to: reported failure, actual success, booby trap left behind.
   *
   * The placeholder is not nothing, though. It states how many line breaks it
   * swallowed, and that number is checkable against what we sent. So the
   * verdict here is a real verification of a smaller claim, not a shrug.
   *
   * A count that does NOT match is its own verdict rather than a plain
   * failure: it means something arrived that is not what we sent — a stale
   * placeholder from an earlier paste, or a payload that lost a line on the
   * way — and an operator needs to see which of those they are looking at.
   */
  if (inputLine.kind === "draft") {
    const m = PASTED_PLACEHOLDER.exec(inputLine.text.trim());
    if (m) {
      const declared = m[2] === undefined ? 0 : Number(m[2]);
      const sent = countLineBreaks(keys);
      return declared === sent
        ? { delivered: true, where: "pasted-placeholder", inputLine }
        : { delivered: false, where: "pasted-line-count-mismatch", inputLine };
    }
  }
  /**
   * NO CLAUDE CODE INPUT BOX — a shell, a pager, a pane still starting.
   *
   * `clearInputLine` already refuses to claim a verdict about a pane it cannot
   * parse, and the same restraint belongs here: a rule written for Claude
   * Code's TUI must not decide that a `bash` pane is undeliverable. The first
   * version of this function had no such branch and took six live-tmux tests
   * with it, every one of them sending into a plain shell.
   *
   * So we fall back to the pre-v0.11.25 whole-pane check — and NAME the
   * fallback, because a verdict reached by a weaker rule must not be
   * indistinguishable in the log from one reached by the strong rule. The
   * hazard this release exists for lives in the Claude Code box, and there the
   * strong rule always applies.
   */
  if (inputLine.kind === "no-marker") {
    return {
      delivered: paneContains(captured, keys),
      where: "no-input-box",
      inputLine,
    };
  }
  // Not in the box. Say whether the OLD check would have passed, because that
  // is the difference between "this release changed the verdict" and "the send
  // genuinely failed" — and an operator reading the log needs to tell them apart.
  const where: DeliveryWhere = paneContains(captured, keys) ? "elsewhere-on-pane" : "absent";
  return { delivered: false, where, inputLine };
}

/**
 * Largest pasted payload this contract has actually been measured against.
 *
 * MEASURED 2026-08-09: 4 019, 16 019 and 60 023 characters across six lines
 * each landed as one paste and reported `+5 lines` every time. The 800
 * character ceiling is a property of the TYPED route — of the arrival burst —
 * and does not apply here.
 *
 * The cap is therefore not a known failure point. It is the edge of the
 * evidence, and a payload past it is refused rather than sent on a guess.
 */
export const PASTE_ROUTE_MEASURED_LIMIT = 60_000;

/** Why a payload may not be delivered to a pane at all. */
export type PayloadRefusal = {
  reason: "carriage-return" | "too-long-to-type" | "beyond-measured-paste";
  message: string;
};

/**
 * Refuse payloads the send layer cannot deliver honestly.
 *
 * WHAT CHANGED, AND WHY IT WAS A REFUSAL FIRST.
 *
 * A newline used to be an outright refusal, because `send-keys -l` turns each
 * one into Enter and the payload goes in pieces. That is still true — measured
 * 2026-08-09, a four-line payload sent that way produced three separate user
 * messages and orphaned the fourth line — so the newline did not stop being a
 * hazard. It stopped being a REFUSAL because it now selects a route that
 * handles it: `load-buffer` + `paste-buffer -p`, whose result is verifiable
 * through the placeholder. See `payloadRoute` and `inputLineHolds`.
 *
 * CARRIAGE RETURN stays refused. Nothing was measured about how the client
 * counts `\r`, and the placeholder contract is a count — asserting a number we
 * never observed is exactly the failure this release exists to remove.
 *
 * TOO LONG TO TYPE — the 800 character ceiling now applies only to the typed
 * route, where exceeding it produces a placeholder carrying NO count and the
 * delivery becomes unprovable. See `PASTE_COLLAPSE_LIMIT`.
 *
 * Every refusal is checked before any key is sent, so a rejected payload
 * leaves the target pane exactly as it was found.
 */
export function refusePayload(keys: string): PayloadRefusal | null {
  if (keys.includes("\r")) {
    return {
      reason: "carriage-return",
      message:
        "payload contains a carriage return — how Claude Code counts it in a pasted-text placeholder has not been measured, so delivery could not be verified against it. Send \\n only; see docs/SEND-KEYS.md.",
    };
  }
  if (payloadRoute(keys) === "typed" && keys.length > PASTE_COLLAPSE_LIMIT) {
    return {
      reason: "too-long-to-type",
      message: `payload is ${keys.length} characters on one line — Claude Code collapses anything over ${PASTE_COLLAPSE_LIMIT} into a "[Pasted text #N]" placeholder that carries no line count, after which delivery cannot be verified. See docs/SEND-KEYS.md.`,
    };
  }
  if (keys.length > PASTE_ROUTE_MEASURED_LIMIT) {
    return {
      reason: "beyond-measured-paste",
      message: `payload is ${keys.length} characters — the paste route has been measured to ${PASTE_ROUTE_MEASURED_LIMIT}. This is the edge of the evidence, not a known failure; see docs/SEND-KEYS.md.`,
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

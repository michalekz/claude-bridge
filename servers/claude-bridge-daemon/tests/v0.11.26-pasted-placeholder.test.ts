/**
 * v0.11.26 — proving a delivery the pane no longer shows.
 *
 * Multi-line payloads were refused outright, because the only way to type one
 * submits it in pieces. The paste route fixes the sending; this file is about
 * the half that made the refusal necessary in the first place — once Claude
 * Code collapses a paste into `[Pasted text #N +M lines]`, the payload is not
 * on the pane, so the content check can never pass and a successful send
 * reports failure. Reported failure plus actual success is the worst of the
 * four outcomes: the text stays in the box for the next caller to prepend to.
 *
 * EVERY FIXTURE BELOW IS A REAL CAPTURE from Claude Code 2.1.226 on a
 * 200-column pane, taken 2026-08-09. The measurement refuted the number this
 * contract was first drafted with — see `the count is line BREAKS` below.
 */
import { describe, expect, it } from "vitest";
import {
  PASTED_PLACEHOLDER,
  countLineBreaks,
  inputLineHolds,
  payloadRoute,
} from "../src/hosts/input-line.ts";

/** A captured pane: the box, its closing rule, and the status rows below it. */
function pane(...boxRows: string[]): string {
  return [
    " ▐▛███▜▌   Claude Code v2.1.226",
    "▝▜█████▛▘  Haiku 4.5 · Claude Team",
    "─".repeat(140),
    ...boxRows,
    "─".repeat(140),
    "  rot",
    "  paste again to expand",
  ].join("\n");
}

describe("the placeholder states line BREAKS, not lines", () => {
  it("a four-line payload is reported as +3", () => {
    // THE REFUTED ASSUMPTION. This contract was drafted expecting `+4 lines`
    // for four lines. The pane said `+3`, and a verifier written to the draft
    // would have rejected every correct delivery and accepted nothing.
    const payload = "radek jedna\nradek dva\nradek tri\nradek ctyri";
    expect(countLineBreaks(payload)).toBe(3);
    const probe = inputLineHolds(pane("❯ [Pasted text #5 +3 lines]"), payload);
    expect(probe.delivered).toBe(true);
    expect(probe.where).toBe("pasted-placeholder");
  });

  it("a trailing newline counts", () => {
    // Measured: 'a\nb\nc\nd\n' — five lines by splitting, four breaks — came
    // back as `+4 lines`. The rule is the character, not the visual line.
    const payload = "a\nb\nc\nd\n";
    expect(countLineBreaks(payload)).toBe(4);
    expect(inputLineHolds(pane("❯ [Pasted text #3 +4 lines]"), payload).delivered).toBe(true);
  });

  it("seven lines is +6", () => {
    const payload = "a\nb\nc\nd\ne\nf\ng";
    expect(inputLineHolds(pane("❯ [Pasted text #2 +6 lines]"), payload).delivered).toBe(true);
  });
});

describe("a count that disagrees is its own verdict", () => {
  it("one line short is refused, and named", () => {
    // Not a plain failure: something IS in the box, and it is not what we
    // sent — a stale placeholder from an earlier paste, or a payload that lost
    // a line. An operator has to be able to tell that from "nothing arrived",
    // because only one of the two is safe to retry into.
    const probe = inputLineHolds(pane("❯ [Pasted text #5 +2 lines]"), "a\nb\nc\nd");
    expect(probe.delivered).toBe(false);
    expect(probe.where).toBe("pasted-line-count-mismatch");
  });

  it("a counted placeholder does not satisfy a payload that had no breaks", () => {
    const probe = inputLineHolds(pane("❯ [Pasted text #9 +5 lines]"), "one line only");
    expect(probe.delivered).toBe(false);
    expect(probe.where).toBe("pasted-line-count-mismatch");
  });

  it("a bare placeholder satisfies a payload that had no breaks", () => {
    // Measured: 1 200 characters on one line came back as `[Pasted text #6]`,
    // with no count at all. That is why the typed route still refuses over 800
    // — this form proves that SOMETHING was pasted, not that this was.
    const probe = inputLineHolds(pane("❯ [Pasted text #6]"), "x".repeat(1200));
    expect(probe.delivered).toBe(true);
    expect(probe.where).toBe("pasted-placeholder");
  });
});

describe("below the collapse threshold the strong rule still applies", () => {
  it("three lines are drawn literally and verified by content", () => {
    // Measured: 'x\ny\nz' rendered across three rows rather than collapsing.
    // The payload is on the pane, so the content check runs and the verdict is
    // the strong one — `input-line`, not `pasted-placeholder`.
    const probe = inputLineHolds(pane("❯ x", "  y", "  z"), "x\ny\nz");
    expect(probe.delivered).toBe(true);
    expect(probe.where).toBe("input-line");
  });

  it("length collapses a payload that line count would not", () => {
    // Measured: 1 500 characters over three lines came back as
    // `[Pasted text #7 +2 lines]`, while 15 characters over the same three
    // lines were drawn. Two independent triggers; the verifier does not
    // predict which fired, it checks whichever form arrived.
    const payload = `${"A".repeat(500)}\n${"B".repeat(500)}\n${"C".repeat(500)}`;
    expect(countLineBreaks(payload)).toBe(2);
    expect(inputLineHolds(pane("❯ [Pasted text #7 +2 lines]"), payload).delivered).toBe(true);
  });
});

describe("the placeholder is matched, never predicted", () => {
  it("the counter increments per paste and is not asserted", () => {
    // #1 … #10 were observed in one session. Pinning it would make the test
    // depend on how many pastes happened earlier in someone else's session.
    for (const n of [1, 5, 10, 137]) {
      expect(PASTED_PLACEHOLDER.test(`[Pasted text #${n} +3 lines]`)).toBe(true);
    }
  });

  it("prose that merely mentions a paste is not a placeholder", () => {
    // The whole point of v0.11.25 was that a payload visible somewhere on the
    // pane is not a payload in the box. A transcript line quoting the
    // placeholder must not license an Enter either.
    expect(PASTED_PLACEHOLDER.test("see [Pasted text #5 +3 lines] above")).toBe(false);
    expect(PASTED_PLACEHOLDER.test("[Pasted text]")).toBe(false);
    expect(PASTED_PLACEHOLDER.test("[Pasted text #5 +three lines]")).toBe(false);
  });

  it("singular is accepted — one break is still a placeholder shape", () => {
    // Never observed: the collapse needs three breaks or 800 characters, so a
    // single break only reaches this form through length. Accepted rather than
    // rejected because the grammar is the client's to choose, and a verifier
    // that fails on a plural it did not expect fails a correct delivery.
    expect(PASTED_PLACEHOLDER.test("[Pasted text #4 +1 line]")).toBe(true);
  });
});

describe("the route follows the payload", () => {
  it("a newline is the only thing that changes it", () => {
    expect(payloadRoute("plain")).toBe("typed");
    expect(payloadRoute("/compact")).toBe("typed");
    expect(payloadRoute("two\nlines")).toBe("pasted");
    expect(payloadRoute("trailing\n")).toBe("pasted");
  });
});

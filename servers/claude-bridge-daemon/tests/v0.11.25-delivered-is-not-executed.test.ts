import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchForCompact } from "../src/compact-verify.ts";
import { inputLineHolds, paneContains } from "../src/hosts/input-line.ts";

/**
 * v0.11.25 — a delivered command is not an executed command.
 *
 * THE INCIDENT (2026-08-09). The daemon injected `/compact` into a peer,
 * `sendKeys` returned, `peer_compacted` was written, and the tool reported
 * success. The peer compacted 5 min 52 s later, on a context that Claude Code's
 * own autocompact had already emptied — the second compression at 9 %.
 *
 * Two separate things were wrong, and this file pins both, because the old
 * suite could not have caught either:
 *
 *   ① VERIFICATION ASKED THE WRONG QUESTION. `paneContains(wholePane, keys)`
 *      answers "is this string visible anywhere", and Enter was pressed on the
 *      strength of that answer.
 *   ② SUCCESS WAS CLAIMED BY THE SENDER. `sendKeys` reports on a terminal. Only
 *      the peer's transcript can report on the peer.
 */

/**
 * A real pane, transcribed from a live capture (Claude Code 2.1.226, peer
 * `tst-p0:repro.1`, 2026-08-09).
 *
 * The detail that makes it a fixture worth having: Claude Code echoes a
 * SUBMITTED message back into the transcript **with the same `❯` marker** the
 * input box uses. So after any successful inject, the payload string stays
 * visible on the pane forever — and the pre-v0.11.25 check would call the next
 * attempt delivered without a single keystroke having landed.
 */
const PANE_ECHO_BUT_EMPTY_BOX = [
  "  1998",
  "  1999",
  "  2000",
  "✻ Baked for 20s",
  "❯ /compact",
  "● Přijato.",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────",
  "   Haiku 4.5  ██▊█████████ 23 % (50k/200k)   /tmp/p0-repro…",
  "  ⏸ manual mode on · ← for agents",
].join("\n");

/**
 * The same pane with the payload actually TYPED — and the slash palette open
 * below the box, which is what typing a slash command does.
 *
 * Measured: the palette rows carry NO `❯`, and they are drawn below the closing
 * rule. This fixture is the reason change ④ was not implemented as the brief
 * wrote it ("and the pane is not showing a palette") — that rule would refuse
 * every slash command there is, `/compact` included.
 */
const PANE_TYPED_WITH_PALETTE_OPEN = [
  "● Přijato.",
  "✻ Baked for 5s",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ /compact",
  "────────────────────────────────────────────────────────────────────────────────",
  "/compact                        Clear conversation history but keep a summary",
  "/compact-instructions           …",
].join("\n");

describe("① delivered means IN THE INPUT LINE, not anywhere on the pane", () => {
  it("the payload typed into the box counts, palette or no palette", () => {
    const probe = inputLineHolds(PANE_TYPED_WITH_PALETTE_OPEN, "/compact");
    expect(probe.delivered).toBe(true);
    expect(probe.where).toBe("input-line");
  });

  it("THE REGRESSION — an echoed payload with an empty box does NOT count", () => {
    // The old check. It passes, and it is why this test exists.
    expect(paneContains(PANE_ECHO_BUT_EMPTY_BOX, "/compact")).toBe(true);

    const probe = inputLineHolds(PANE_ECHO_BUT_EMPTY_BOX, "/compact");
    expect(probe.delivered).toBe(false);
    // Named, not merely false: `elsewhere-on-pane` is the case the previous
    // release called a success, and the log has to be able to say so.
    expect(probe.where).toBe("elsewhere-on-pane");
    expect(probe.inputLine.kind).toBe("empty");
  });

  it("a payload nowhere at all is `absent`, not `elsewhere`", () => {
    const probe = inputLineHolds(PANE_ECHO_BUT_EMPTY_BOX, "/never-typed-this");
    expect(probe.delivered).toBe(false);
    expect(probe.where).toBe("absent");
  });

  it("a pane that is NOT a Claude Code box still gets its payload delivered", () => {
    // A shell, a pager, a pane still starting. The first version of the rule
    // had no branch for this and took six live-tmux tests down with it — every
    // one of them sending into `bash`. A rule written for one TUI must not
    // decide that everything else is undeliverable.
    const shell = ["$ echo hello", "hello", "$ into-the-void"].join("\n");
    const probe = inputLineHolds(shell, "into-the-void");
    expect(probe.delivered).toBe(true);
    // Delivered by the WEAKER rule, and the verdict says which one — otherwise
    // a fallback result reads exactly like a verified one.
    expect(probe.where).toBe("no-input-box");
  });
});

/** Build a transcript file out of rows, the way Claude Code writes one. */
async function transcript(rows: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cbd-compact-verify-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");
  return path;
}

const enqueue = (at: string, content: string) => ({
  type: "queue-operation",
  operation: "enqueue",
  content,
  timestamp: at,
});
const compacted = (at: string, trigger: string, preTokens: number, postTokens: number) => ({
  type: "system",
  timestamp: at,
  compactMetadata: { trigger, preTokens, postTokens },
});

/** Short window + short poll: these assertions are about outcomes, not waiting. */
const FAST = { payload: "/compact", timeoutMs: 60, pollMs: 5 };

describe("② the outcome is read from the PEER's transcript", () => {
  it("a manual compact after the inject is the success", async () => {
    const path = await transcript([
      compacted("2026-08-09T09:00:00.000Z", "manual", 87_556, 10_822),
    ]);
    const out = await watchForCompact({ transcriptPath: path, fromOffset: 0, ...FAST });
    expect(out.kind).toBe("executed");
    if (out.kind !== "executed") return;
    expect(out.preTokens).toBe(87_556);
    expect(out.postTokens).toBe(10_822);
    expect(out.preemptedByAuto).toBeNull();
  });

  it("rows written BEFORE the inject are not ours", async () => {
    // A compact from the peer's past must not be read as an answer to a command
    // we sent afterwards — the stale-ack defect of v0.11.3, in a new place.
    const rows = [compacted("2026-08-09T08:00:00.000Z", "manual", 1, 1)];
    const path = await transcript(rows);
    const { stat } = await import("node:fs/promises");
    const offset = (await stat(path)).size;
    const out = await watchForCompact({ transcriptPath: path, fromOffset: offset, ...FAST });
    expect(out.kind).toBe("silent");
  });

  it("THE INCIDENT — queued, then autocompacted, then ours runs on top", async () => {
    // The 2026-08-09 sequence, in the order the transcript recorded it.
    const path = await transcript([
      enqueue("2026-08-09T07:31:44.942Z", "/compact"),
      compacted("2026-08-09T07:35:27.818Z", "auto", 1_001_614, 13_944),
      compacted("2026-08-09T07:39:58.978Z", "manual", 87_556, 10_822),
    ]);
    const out = await watchForCompact({ transcriptPath: path, fromOffset: 0, ...FAST });
    expect(out.kind).toBe("executed");
    if (out.kind !== "executed") return;
    // Executed, yes — but never as a plain success. Both halves survive into
    // the payload, because "it compacted" and "it compacted twice" are not the
    // same report.
    expect(out.queuedAt).toBe("2026-08-09T07:31:44.942Z");
    expect(out.preemptedByAuto).toEqual({
      at: "2026-08-09T07:35:27.818Z",
      preTokens: 1_001_614,
      postTokens: 13_944,
    });
  });

  it("queued and still queued when the window closes is NOT a success", async () => {
    const path = await transcript([enqueue("2026-08-09T07:31:44.942Z", "/compact")]);
    const out = await watchForCompact({ transcriptPath: path, fromOffset: 0, ...FAST });
    expect(out.kind).toBe("queued-unresolved");
    if (out.kind !== "queued-unresolved") return;
    expect(out.queuedAt).toBe("2026-08-09T07:31:44.942Z");
  });

  it("an autocompact with ours still pending is its own outcome", async () => {
    const path = await transcript([
      enqueue("2026-08-09T07:31:44.942Z", "/compact"),
      compacted("2026-08-09T07:35:27.818Z", "auto", 1_001_614, 13_944),
    ]);
    const out = await watchForCompact({ transcriptPath: path, fromOffset: 0, ...FAST });
    expect(out.kind).toBe("preempted-unresolved");
  });

  it("a queue entry for somebody ELSE's payload is not ours", async () => {
    // The peer's queue holds channel messages too. Matching on "something was
    // queued" would report every busy peer as holding our command.
    const path = await transcript([
      enqueue("2026-08-09T07:31:24.117Z", '<channel source=... kind="reply">'),
    ]);
    const out = await watchForCompact({ transcriptPath: path, fromOffset: 0, ...FAST });
    expect(out.kind).toBe("silent");
  });

  it("a half-written trailing row is not parsed until it is whole", async () => {
    // Claude Code appends; a poll can land mid-write. Reading the fragment as a
    // row would either throw or, worse, miss the row once it completes.
    const dir = await mkdtemp(join(tmpdir(), "cbd-compact-partial-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, '{"type":"system","compactMetadata":{"trigger":"man', "utf-8");
    const out = await watchForCompact({ transcriptPath: path, fromOffset: 0, ...FAST });
    expect(out.kind).toBe("silent");
  });
});

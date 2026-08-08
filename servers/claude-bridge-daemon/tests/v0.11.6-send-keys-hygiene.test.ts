import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.6 — the control plane types into panes that belong to people.
 *
 * Zdeněk, 2026-08-07: "hygiene — first I clear, then I send keys", and it
 * belongs to the tool rather than to every caller.
 *
 * Everything asserted here was measured against Claude Code v2.1.224 in tmux on
 * a 188-column pane before it was written. Three of those measurements
 * contradicted what the author believed:
 *
 *   - a single `C-u` does NOT clear a wrapped draft; it clears one display row
 *   - raw `send-keys` DOES trip the paste-collapse limit; it is not about
 *     bracketed-paste markers, it is about the arrival burst
 *   - the old whitespace-collapsing match failed on payloads that had arrived
 *     perfectly, and its verdict depended on the reader's terminal width
 */

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const TMUX = hasTmux();

const PANE_COLS = 188;
/** How a 188-column pane presents a draft too long for one row. */
function wrapped(text: string, cols = PANE_COLS): string {
  const rows: string[] = [];
  for (let i = 0; i < text.length; i += cols) rows.push(text.slice(i, i + cols));
  return rows.join("\n  ");
}

describe("reading the input box", () => {
  it("an empty box is empty — the marker line alone decides it", async () => {
    const { readInputLine } = await import("../src/hosts/input-line.ts");
    const pane = ["> some earlier transcript line", "──── tst-b ──", "❯ ", "────", " Opus 5  8 %"];
    expect(readInputLine(pane.join("\n"))).toEqual({ kind: "empty" });
  });

  it("a one-row draft is read back verbatim", async () => {
    const { readInputLine } = await import("../src/hosts/input-line.ts");
    const pane = ["──── tst-b ──", "❯ rozepsany text cloveka: ktery se nesmi ztratit. 3x", "────"];
    expect(readInputLine(pane.join("\n"))).toEqual({
      kind: "draft",
      text: "rozepsany text cloveka: ktery se nesmi ztratit. 3x",
    });
  });

  it("a WRAPPED draft is un-wrapped — the rows after the marker carry no marker", async () => {
    // This is why emptiness cannot be decided by "is there a marker line with
    // nothing after it": a 400-character draft occupies three rows and only the
    // first has the `❯`.
    const { readInputLine } = await import("../src/hosts/input-line.ts");
    const draft = `ZACATEK-${"z".repeat(380)}-KONEC`;
    const pane = ["──── tst-b ──", `❯ ${wrapped(draft)}`, "────", " Opus 5  8 %"];
    const probe = readInputLine(pane.join("\n"));
    expect(probe.kind).toBe("draft");
    expect(probe.kind === "draft" && probe.text).toBe(draft);
  });

  it("a word-wrapped row gets its space back; a mid-word break does not", async () => {
    // Claude Code word-wraps the box, and the space it breaks at is in NEITHER
    // row — the captured pane does not contain that character at all. Measured
    // live on a 377-character draft that came back as 376: ".konec" ended one
    // row and "KONEC-lidske-prace" began the next.
    //
    // The two cases are told apart by width: a row that stopped short was
    // broken at a space, a row that ran to the full box width was broken
    // mid-word and nothing was consumed. Both appeared in that one draft.
    const { readInputLine } = await import("../src/hosts/input-line.ts");
    const W = 40; // inner content width; the closing rule is W + 2 wide
    const pane = [
      "──── tst-b ──",
      `❯ ${"a".repeat(W)}`, // full width → broken mid-word
      `  ${"b".repeat(W)}`, // full width → broken mid-word
      `  ${"c".repeat(W - 6)}`, // short → broken at a space
      "  posledni slovo",
      "─".repeat(W + 2),
    ];
    const probe = readInputLine(pane.join("\n"));
    expect(probe.kind === "draft" && probe.text).toBe(
      `${"a".repeat(W)}${"b".repeat(W)}${"c".repeat(W - 6)} posledni slovo`,
    );
  });

  it("a pane that is not a Claude Code box says so instead of guessing", async () => {
    // A shell, a pager, a pane still starting. Inability to parse a foreign TUI
    // must not become a reason to refuse to work.
    const { readInputLine } = await import("../src/hosts/input-line.ts");
    expect(readInputLine("$ ls -la\ntotal 0\n$ ")).toEqual({ kind: "no-marker" });
  });
});

describe("proving the payload arrived", () => {
  it("THE REGRESSION: a wrapped payload counts as delivered", async () => {
    // Measured on a 188-column pane: the old rule collapsed whitespace to
    // single spaces, so tmux's wrap newline became a space the needle did not
    // have. It rejected 200- and 400-character payloads that had arrived
    // perfectly while accepting 300, 500, 600, 700 and 800 — pass or fail
    // according to where the wrap landed relative to the 40-character tail.
    const { paneContains } = await import("../src/hosts/input-line.ts");
    const payload = `${"x".repeat(184)}KONEC-SONDY-887x`;
    expect(payload.length).toBe(200);
    expect(paneContains(`❯ ${wrapped(payload)}`, payload)).toBe(true);
  });

  it("still refuses a payload that never arrived", async () => {
    const { paneContains } = await import("../src/hosts/input-line.ts");
    expect(paneContains("❯ \n────", "/compact")).toBe(false);
  });

  it("an empty payload is trivially present", async () => {
    const { paneContains } = await import("../src/hosts/input-line.ts");
    expect(paneContains("anything", "")).toBe(true);
  });
});

describe("payloads the send layer refuses to carry", () => {
  it("a newline would submit the payload in pieces", async () => {
    // tmux turns every `\n` in a send-keys argument into Enter: line one is
    // submitted on its own and line two is left hanging in the box.
    const { refusePayload } = await import("../src/hosts/input-line.ts");
    expect(refusePayload("first line\nsecond line")?.reason).toBe("multiline");
    expect(refusePayload("carriage\rreturn too")?.reason).toBe("multiline");
  });

  it("801 characters is where the proof disappears — 800 is not", async () => {
    // Measured by bisection, not read off documentation: 800 lands literally,
    // 801 becomes `[Pasted text #N]`. The text is still THERE; what is gone is
    // the ability to verify it, after which sendKeys throws, Enter is never
    // sent, and the payload sits in the box for the next caller to prepend to.
    const { refusePayload, PASTE_COLLAPSE_LIMIT } = await import("../src/hosts/input-line.ts");
    expect(PASTE_COLLAPSE_LIMIT).toBe(800);
    expect(refusePayload("a".repeat(800))).toBeNull();
    expect(refusePayload("a".repeat(801))?.reason).toBe("too-long");
  });

  it("the human-facing notice names the one keystroke that undoes it", async () => {
    // Measured: `Ctrl+Y` restored 402 characters cleared by twenty strokes,
    // whole and from the first character. The notice is addressed to a person,
    // so it says that and not "sendKeys issued C-u".
    const { displacedDraftNotice } = await import("../src/hosts/input-line.ts");
    expect(displacedDraftNotice()).toContain("Ctrl+Y");
    expect(displacedDraftNotice()).toContain("claude-bridge");
    expect(displacedDraftNotice()).not.toMatch(/C-u|send-?keys/i);
  });
});

describe("refusal happens before tmux is touched", () => {
  it("a bad payload fails on its own terms, not as a tmux error", async () => {
    // The target below does not exist. If the refusal ran after the first tmux
    // call the message would be about a missing session — and a rejected
    // payload would have disturbed a real pane on the way to being rejected.
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const driver = new TmuxDriver();
    await expect(driver.sendKeys("no-such-session-anywhere", "one\ntwo")).rejects.toThrow(
      /refused.*newline/s,
    );
    await expect(driver.sendKeys("no-such-session-anywhere", "b".repeat(900))).rejects.toThrow(
      /refused.*900 characters/s,
    );
  });
});

/**
 * The guarantee that matters, against a real tmux server: when the input line
 * cannot be emptied, NOTHING is typed. A draft we cannot clear is a draft we
 * would corrupt.
 */
describe.skipIf(!TMUX)("against a real tmux pane", () => {
  const sessions: string[] = [];
  let tempHome: string;

  function newSessionKey(label: string): string {
    const key = `cbtest-hyg-${label}-${process.pid}-${sessions.length}`;
    sessions.push(key);
    return key;
  }

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-hygiene-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const key of sessions) {
      try {
        execFileSync("tmux", ["kill-session", "-t", key], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  });

  it("refuses to type onto text it cannot clear, and says where to look", async () => {
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const driver = new TmuxDriver({ sendVerifyDelayMs: 120 });
    const key = newSessionKey("stuck");
    await driver.spawn({
      sessionKey: key,
      cwd: "/tmp",
      command: "cat",
      args: [],
      env: process.env as Record<string, string>,
    });

    // `cat` echoes what it is given, so this puts a line into the pane that
    // LOOKS like an input box with a draft in it — and that `C-u` cannot
    // remove, because it is committed output rather than an editable buffer.
    execFileSync("tmux", ["send-keys", "-t", key, "-l", "--", "❯ rozepsany text cloveka"]);
    execFileSync("tmux", ["send-keys", "-t", key, "Enter"]);

    await expect(driver.sendKeys(key, "/compact")).rejects.toThrow(
      /refused.*unsent text.*capture-pane/s,
    );

    // The payload must not be anywhere in that pane.
    const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", key], { encoding: "utf-8" });
    expect(pane).not.toContain("/compact");
    expect(pane).toContain("rozepsany text cloveka");

    // And the refusal is on the record, with the reason.
    const logPath = join(tempHome, ".claude-bridge", "control", "logs", `sendkeys-${key}.log`);
    const entry = JSON.parse((await readFile(logPath, "utf-8")).trim().split("\n").pop() as string);
    expect(entry.verdict).toBe("refused-input-not-clear");
    expect(entry.strokes).toBeGreaterThan(1);
  }, 20_000);

  it("a payload that spells a tmux key name is sent as TEXT", async () => {
    // Without `-l --`, `send-keys -t X Enter` presses Enter instead of typing
    // the word. No caller trips this today; the point is that none can.
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const driver = new TmuxDriver({ sendVerifyDelayMs: 400 });
    const key = newSessionKey("keyname");
    await driver.spawn({
      sessionKey: key,
      cwd: "/tmp",
      command: "cat",
      args: [],
      env: process.env as Record<string, string>,
    });

    await expect(driver.sendKeys(key, "Enter")).resolves.toBeUndefined();
    const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", key], { encoding: "utf-8" });
    expect(pane).toContain("Enter");
  }, 20_000);
});

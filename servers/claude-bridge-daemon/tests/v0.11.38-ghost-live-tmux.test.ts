import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { TmuxDriver } from "../src/hosts/tmux-driver.ts";

const execFileAsync = promisify(execFile);

/**
 * The same finding, driven through a REAL tmux pane.
 *
 * The unit tests above it prove the decoder. They cannot prove that the driver
 * ASKS for a capture that still has its escape sequences — and that gap is
 * exactly the shape of the mistake this project made on 2026-08-27, when a test
 * supplied its own override and proved a gate could open while nothing walked
 * through it. So this one paints a dimmed suggestion into a live pane and runs
 * the driver's own send path against it.
 *
 * The pane is not Claude Code, so the send still fails at DELIVERY — nothing
 * echoes the payload back into the box. That is fine and is the point: the
 * verdict has to move from "refused: the input line still holds N characters"
 * to a delivery failure, and the send-keys log has to record `was-empty` with
 * the dimmed characters counted separately.
 */

const haveTmux = await execFileAsync("tmux", ["-V"]).then(
  () => true,
  () => false,
);

const SESSION = "cb-ghost-live-test";
const ESC = "\x1b";
const GHOST = "Zvedni ten stable flip mostu";

/** A pane that draws Claude Code's empty box with a dimmed suggestion in it. */
const PAINT = [
  "clear",
  `printf '${ESC}[39m\\342\\235\\257\\302\\240 ${ESC}[2m${GHOST}${ESC}[0m\\n'`,
  "printf '%s\\n' '────────────────────────────────────────'",
  "sleep 120",
].join("; ");

describe("live pane: a dimmed suggestion no longer refuses the send", () => {
  afterAll(async () => {
    await execFileAsync("tmux", ["kill-session", "-t", SESSION]).catch(() => undefined);
  });

  it.skipIf(!haveTmux)(
    "clears nothing, refuses nothing, and counts the ghost",
    async () => {
      await execFileAsync("tmux", ["kill-session", "-t", SESSION]).catch(() => undefined);
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        SESSION,
        "-x",
        "120",
        "-y",
        "20",
        "sh",
        "-c",
        PAINT,
      ]);
      await new Promise((r) => setTimeout(r, 600));

      // Addressed by WINDOW ID, the way the daemon addresses peers: a
      // `session:window` string is canonicalised into a session name and would
      // resolve to nothing here.
      const windowId = (
        await execFileAsync("tmux", ["display-message", "-p", "-t", `${SESSION}:1`, "#{window_id}"])
      ).stdout.trim();
      const driver = new TmuxDriver({ sendVerifyDelayMs: 400 });
      const failure = await driver.sendKeys(windowId, "/compact").then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );

      // It must NOT be the hygiene refusal. Before this change it was exactly
      // that, and the payload never left the daemon.
      expect(failure).not.toMatch(/still holds/);

      const log = await readFile(
        join(homedir(), ".claude-bridge", "control", "logs", `sendkeys-${windowId}.log`),
        "utf-8",
      );
      const last = JSON.parse(log.trimEnd().split("\n").at(-1) ?? "{}");
      expect(last.inputLine).toBe("was-empty");
      expect(last.clearStrokes).toBe(0);
      // The suggestion is counted where it was seen, and the two sightings are
      // NOT added together: 24 dimmed characters on the pane must not be
      // reported as 48 just because two phases looked at the same box.
      expect(last.ghostCharsBeforeClear).toBe(24);
      expect(last.ghostCharsAtVerify).toBe(24);
    },
    40_000,
  );
});

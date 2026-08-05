import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { sanitizeEnv } from "../src/env-whitelist.ts";
import { paneCommand } from "../src/hosts/tmux-driver.ts";

const execFileAsync = promisify(execFile);

/**
 * Does the sanitized environment actually reach the process we spawn?
 *
 * `env-whitelist.test.ts` checks what `sanitizeEnv` RETURNS, and it always
 * passed — the function is correct. Nobody checked whether its output had any
 * effect on the child, and it did not.
 *
 * `TmuxDriver.spawn` handed the sanitized env to `execFile` as the environment
 * of the tmux CLIENT. A new pane does not inherit that: tmux's server is
 * long-lived and a new session gets the SERVER's global environment plus the
 * few variables in `update-environment`. Measured on tmux 3.4, 2026-08-04: a
 * session created with a completely empty client environment (`env -i`) still
 * produced a pane holding a real `ANTHROPIC_API_KEY` and eight `CLAUDE_*`
 * variables. The whitelist was filtering something tmux never read.
 *
 * These cases therefore read `/proc/<pid>/environ` of the actual child. A test
 * that asserts on the return value of `sanitizeEnv` cannot fail the way
 * production failed.
 */

const LEAK = "ANTHROPIC_API_KEY";
const CANARY = "test-key-value-that-must-not-reach-the-child";

async function environOf(pid: number): Promise<Set<string>> {
  const raw = await readFile(`/proc/${pid}/environ`, "utf-8");
  return new Set(
    raw
      .split("\0")
      .filter((s) => s.length > 0)
      .map((s) => s.slice(0, s.indexOf("="))),
  );
}

const haveTmux = await execFileAsync("tmux", ["-V"]).then(
  () => true,
  () => false,
);

const SESSION = "cb-env-reaches-pane-test";

describe("the sanitized environment reaches the process, not just the caller", () => {
  afterAll(async () => {
    await execFileAsync("tmux", ["kill-session", "-t", SESSION]).catch(() => undefined);
    await execFileAsync("tmux", ["set-environment", "-gu", LEAK]).catch(() => undefined);
  });

  it("paneCommand starts from nothing and names every variable explicitly", () => {
    const argv = paneCommand({ PATH: "/usr/bin", HOME: "/home/x" }, "/bin/sh", ["-c", "sleep 1"]);
    const script = argv[2] ?? "";
    // `-i` is the whole point: without it the child inherits, and inheritance
    // is what put the key in there.
    expect(argv[0]).toBe("/bin/sh");
    expect(argv[1]).toBe("-c");
    expect(script).toMatch(/exec (\/usr\/bin\/)?env -i /);
    expect(script).toContain("PATH='/usr/bin'");
    expect(script).toContain("HOME='/home/x'");
    // `exec` so no shell is left between tmux and the peer — `pane_pid` has to
    // keep pointing at the peer itself.
    expect(script.startsWith("exec ")).toBe(true);
  });

  it("a value with a quote in it cannot break out of the command", () => {
    const argv = paneCommand({ PATH: "/usr/bin", HOME: "/home/it's; rm -rf /" }, "/bin/sh", []);
    const script = argv[2] ?? "";
    // The apostrophe is escaped, so the `;` stays inside the value instead of
    // becoming a second command.
    expect(script).toContain(`HOME='/home/it'\\''s; rm -rf /'`);
  });

  it("a polluted caller environment does not survive sanitizeEnv", () => {
    const dirty = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      [LEAK]: CANARY,
      CLAUDE_CODE_ENTRYPOINT: "cli",
    };
    const clean = sanitizeEnv(dirty);
    expect(clean[LEAK]).toBeUndefined();
    expect(clean["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    expect(clean["PATH"]).toBe("/usr/bin");
  });

  it.skipIf(!haveTmux)(
    "THE REGRESSION: a pane does not inherit the key from the tmux server",
    async () => {
      // Reproduce the real condition — the leak lives in the SERVER's global
      // environment, which is why a clean client env made no difference.
      await execFileAsync("tmux", ["set-environment", "-g", LEAK, CANARY]);

      const clean = sanitizeEnv({
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
      });
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        SESSION,
        "-c",
        "/tmp",
        "--",
        ...paneCommand(clean, "/bin/sh", ["-c", "sleep 30"]),
      ]);

      const { stdout } = await execFileAsync("tmux", [
        "list-panes",
        "-t",
        SESSION,
        "-F",
        "#{pane_pid}",
      ]);
      const pid = Number.parseInt(stdout.trim(), 10);
      expect(Number.isFinite(pid)).toBe(true);

      const names = await environOf(pid);
      // Before the fix this held the key, taken from the tmux server, no matter
      // what the client was given.
      expect(names.has(LEAK)).toBe(false);
      expect([...names].filter((n) => n.startsWith("CLAUDE_"))).toEqual([]);
      expect([...names].filter((n) => n.startsWith("ANTHROPIC_"))).toEqual([]);
      // And the variables we DID choose are there — a child with no environment
      // at all would pass the assertions above for the wrong reason.
      expect(names.has("PATH")).toBe(true);
      expect(names.has("HOME")).toBe(true);
    },
  );
});

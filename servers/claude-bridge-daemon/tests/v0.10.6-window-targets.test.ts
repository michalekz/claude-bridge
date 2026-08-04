import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { formatHostTarget, parseHostTarget } from "../src/hosts/driver.ts";
import { TmuxDriver } from "../src/hosts/tmux-driver.ts";

const execFileAsync = promisify(execFile);

/**
 * `team_adopt` planned four peers on a fleet of twenty-three and reported
 * `ambiguous: []` (MCP test 2026-08-04, #5).
 *
 * It was not choosing between candidates. `listSessions()` reports
 * `#{pane_pid}` per tmux SESSION — the active pane of the active window, one
 * pid however many windows the session holds. The fleet runs one peer per
 * window: four sessions, twenty-three windows. Nineteen were never looked at,
 * and nothing in the plan said so.
 *
 * The dangerous half is what happens once those windows CAN be addressed:
 * `kill-session -t hmh:3` does not kill window three, it kills the session
 * `hmh` and all seven peers in it. So a target now carries its kind, and kill
 * dispatches on it.
 */

const haveTmux = await execFileAsync("tmux", ["-V"]).then(
  () => true,
  () => false,
);

const SESSION = "cb-window-target-test";

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout;
}

describe("a target says whether it is a session or a window", () => {
  it("parses both forms, and round-trips", () => {
    const s = parseHostTarget("hmh");
    expect(s.kind).toBe("session");
    expect(formatHostTarget(s)).toBe("hmh");

    const w = parseHostTarget("@42");
    expect(w.kind).toBe("window");
    if (w.kind !== "window") throw new Error("unreachable");
    expect(w.windowId).toBe("@42");
    expect(formatHostTarget(w)).toBe("@42");
  });

  it("THE TRAP: session:index is NOT a window address", () => {
    // `renumber-windows` is on for this fleet, so killing window 2 of {1,2,3}
    // renumbers 3 down to 2. An index is a position, not an identity — a stored
    // `hmh:5` would quietly come to mean a different peer. Anything that is not
    // a `@id` is therefore read as a session, never as a window.
    expect(parseHostTarget("hmh:3").kind).toBe("session");
    expect(parseHostTarget("plt-bridge-dev").kind).toBe("session");
    expect(parseHostTarget("micronic").kind).toBe("session");
  });
});

describe.skipIf(!haveTmux)("window targets against a real tmux", () => {
  afterAll(async () => {
    await execFileAsync("tmux", ["kill-session", "-t", SESSION]).catch(() => undefined);
  });

  it("THE REGRESSION: every window is enumerated, not one per session", async () => {
    await tmux(["new-session", "-d", "-s", SESSION, "-c", "/tmp", "sleep 120"]);
    await tmux(["new-window", "-t", SESSION, "-c", "/tmp", "sleep 120"]);
    await tmux(["new-window", "-t", SESSION, "-c", "/tmp", "sleep 120"]);

    const driver = new TmuxDriver({});
    const windows = (await driver.listWindows()).filter((w) => w.session === SESSION);
    const sessions = (await driver.listSessions()).filter((s) => s.sessionKey === SESSION);

    // The old view: one entry, one pid, for a session holding three peers.
    expect(sessions).toHaveLength(1);
    expect(windows).toHaveLength(3);
    // Every window carries its own pane pid — the thing adoption matches on.
    expect(new Set(windows.map((w) => w.pid)).size).toBe(3);
    for (const w of windows) {
      // Addressed by window id; `session:index` survives only as a label.
      expect(w.target).toMatch(/^@\d+$/);
      expect(w.label).toMatch(new RegExp(`^${SESSION}:\\d+$`));
    }
  });

  it("hasSession answers for the WINDOW, not for its session", async () => {
    const driver = new TmuxDriver({});
    const windows = (await driver.listWindows()).filter((w) => w.session === SESSION);
    const victim = windows[1];
    if (!victim) throw new Error("fixture: expected a second window");

    expect(await driver.hasSession(victim.target)).toBe(true);
    // A window id that does not exist. Answering from `has-session` alone would
    // have resolved this to the session and called it alive.
    expect(await driver.hasSession("@999999")).toBe(false);
  });

  it("THE DANGEROUS ONE: killing a window leaves its session and siblings alive", async () => {
    const driver = new TmuxDriver({});
    const before = (await driver.listWindows()).filter((w) => w.session === SESSION);
    expect(before.length).toBe(3);
    const victim = before[1];
    if (!victim) throw new Error("fixture: expected a second window");

    await driver.kill(victim.target);

    const after = (await driver.listWindows()).filter((w) => w.session === SESSION);
    // Before the fix this reached `kill-session -t <session>:<idx>`, which tmux
    // resolves to the SESSION — all three would be gone, and on the real fleet
    // that is seven peers for one requested stop.
    expect(after).toHaveLength(2);
    expect(after.map((w) => w.target)).not.toContain(victim.target);
    // The session itself survives.
    const sessions = (await driver.listSessions()).map((s) => s.sessionKey);
    expect(sessions).toContain(SESSION);
    // And the survivors are the SAME windows, identified across the renumbering
    // that tmux performs on kill — the whole reason the address is an id.
    const survivors = before.filter((w) => w.target !== victim.target).map((w) => w.target);
    expect(after.map((w) => w.target).sort()).toEqual(survivors.sort());
  });

  it("killing a window that is gone is silent, like the session path", async () => {
    const driver = new TmuxDriver({});
    await expect(driver.kill("@999999")).resolves.toBeUndefined();
  });
});

/**
 * Adoption against a real tmux session holding several windows — the shape the
 * fleet actually runs, and the shape the old discovery could not see.
 */
describe.skipIf(!haveTmux)("adoption sees every window and records how to relaunch it", () => {
  const ADOPT_SESSION = "cb-adopt-windows-test";

  afterAll(async () => {
    await execFileAsync("tmux", ["kill-session", "-t", ADOPT_SESSION]).catch(() => undefined);
  });

  it("THE REGRESSION: a three-window session yields three candidates, not one", async () => {
    await tmux(["new-session", "-d", "-s", ADOPT_SESSION, "-c", "/tmp", "sleep 120"]);
    await tmux(["new-window", "-t", ADOPT_SESSION, "-c", "/tmp", "sleep 120"]);
    await tmux(["new-window", "-t", ADOPT_SESSION, "-c", "/tmp", "sleep 120"]);

    const driver = new TmuxDriver({});
    const windows = (await driver.listWindows()).filter((w) => w.session === ADOPT_SESSION);
    const sessions = (await driver.listSessions()).filter((s) => s.sessionKey === ADOPT_SESSION);

    // What adoption used to work from — and why 23 peers produced a plan of 4.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.pid).not.toBeNull();
    // What it works from now.
    expect(windows).toHaveLength(3);

    // Each window has a distinct pane pid, which is what the ancestry walk in
    // discoverCandidates matches a Claude process against. One pid for three
    // windows could only ever find one peer.
    const pids = windows.map((w) => w.pid);
    expect(new Set(pids).size).toBe(3);
    expect(pids).toContain(sessions[0]?.pid ?? -1);
  });
});

/**
 * F0 gate — the harness builds and tears down an isolated server, repeatedly,
 * and its snapshot reads the states the automaton is specified against.
 *
 * These tests run REAL tmux. They are cheap (~1 s) and they are the ground the
 * later phases stand on: if the snapshot misreads a state here, every automaton
 * test above it would be testing a fiction. (This week's lesson, twice: the
 * acceptance that stubs the thing under test misses the dead thing under test.)
 */
import { afterEach, describe, expect, it } from "vitest";
import { TmuxLab, labSocket } from "./tmux-lab.ts";

let lab: TmuxLab | null = null;

afterEach(async () => {
  await lab?.destroy();
  lab = null;
});

describe("F0: lab harness", () => {
  it("refuses a socket name that could be the production server", () => {
    expect(() => new TmuxLab("default")).toThrow(/cblab/);
    expect(() => new TmuxLab("")).toThrow(/cblab/);
  });

  it("builds, snapshots a healthy pane, and tears down without leftovers", async () => {
    lab = new TmuxLab(labSocket("f0"));
    await lab.start();
    const s = await lab.snapshot("lab");
    expect(s.dead).toBe(false);
    expect(s.currentCommand).toBe("sleep");
    expect(s.synchronized).toBe(false);
    expect(s.windowPanes).toBe(1);
    expect(s.inputOff).toBe(false);
    expect(s.inMode).toBe(false);
    expect(s.paneId).toMatch(/^%\d+$/);
    expect(s.panePid).toBeGreaterThan(0);

    await lab.destroy();
    expect(await lab.tmuxOk("has-session", "-t", "lab")).toBe(false);
  });

  it("snapshot sees each automaton predicate the lab can stage", async () => {
    lab = new TmuxLab(labSocket("f0p"));
    await lab.start();

    // S3: input off
    await lab.tmux("select-pane", "-t", "lab", "-d");
    expect((await lab.snapshot("lab")).inputOff).toBe(true);
    await lab.tmux("select-pane", "-t", "lab", "-e");

    // S4: copy-mode
    await lab.tmux("copy-mode", "-t", "lab");
    expect((await lab.snapshot("lab")).inMode).toBe(true);
    await lab.tmux("send-keys", "-t", "lab", "-X", "cancel");
    expect((await lab.snapshot("lab")).inMode).toBe(false);

    // S2: a second pane in the window
    await lab.tmux("split-window", "-t", "lab", "sleep 600");
    expect((await lab.snapshot("lab")).windowPanes).toBe(2);

    // S1: synchronize-panes
    await lab.tmux("set", "-w", "-t", "lab", "synchronize-panes", "on");
    expect((await lab.snapshot("lab")).synchronized).toBe(true);
    await lab.tmux("set", "-w", "-t", "lab", "synchronize-panes", "off");

    // S0: dead pane (remain-on-exit keeps the corpse visible, like production)
    await lab.tmux("set", "-w", "-t", "lab", "remain-on-exit", "on");
    await lab.tmux("respawn-pane", "-k", "-t", "lab", "true");
    // `true` exits immediately; poll briefly for the death to land.
    let dead = false;
    for (let i = 0; i < 20 && !dead; i++) {
      await new Promise((r) => setTimeout(r, 50));
      dead = (await lab.snapshot("lab")).dead;
    }
    expect(dead).toBe(true);
  }, 15_000);

  it("builds and tears down five times in a row without residue", async () => {
    for (let i = 0; i < 5; i++) {
      lab = new TmuxLab(labSocket(`f0r${i}`));
      await lab.start();
      expect((await lab.snapshot("lab")).dead).toBe(false);
      await lab.destroy();
    }
  }, 20_000);
});

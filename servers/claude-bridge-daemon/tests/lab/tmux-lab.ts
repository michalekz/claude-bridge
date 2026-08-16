/**
 * Lab harness — an isolated tmux server for live experiments.
 *
 * WHY A SEPARATE SOCKET IS NON-NEGOTIABLE. The default tmux server on this
 * machine holds the production fleet (26 interactive peers). Every helper here
 * takes the socket name as bound state, so a test CANNOT reach the default
 * server by forgetting an argument — there is no code path without `-L`.
 *
 * WHY `-f /dev/null`. The user's ~/.tmux.conf sets history-limit 100000 and
 * other options; measurements taken under it would describe this machine's
 * config, not tmux. Experiments start from a blank config and apply exactly
 * the options they claim to test. (Measured 2026-08-14: the 936 MB production
 * server RSS traces back to that very config line — a lab inheriting it would
 * have reproduced the bug it was built to study.)
 */
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export class TmuxLab {
  /** Every tmux invocation goes through here — the `-L` is not optional. */
  private readonly base: string[];

  constructor(readonly socket: string) {
    if (!/^cblab[a-z0-9-]*$/.test(socket)) {
      // The prefix is the safety property: `tmux -L cblab…` can never be the
      // default server, and a leftover from a crashed run is recognisable.
      throw new Error(`lab socket must match ^cblab…, got '${socket}'`);
    }
    this.base = ["-L", socket, "-f", "/dev/null"];
  }

  async tmux(...args: string[]): Promise<string> {
    const { stdout } = await run("tmux", [...this.base, ...args]);
    return stdout.trimEnd();
  }

  /** tmux exits non-zero on e.g. `has-session` misses; callers that expect
   *  failure use this instead of try/catch noise. */
  async tmuxOk(...args: string[]): Promise<boolean> {
    try {
      await run("tmux", [...this.base, ...args]);
      return true;
    } catch {
      return false;
    }
  }

  async start(session = "lab", command = "sleep 600"): Promise<void> {
    await this.tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", command);
  }

  /** The one snapshot the readiness automaton is specified against: a single
   *  display-message, therefore a single consistent read (one server round
   *  trip — the server is single-threaded, so no state change can interleave
   *  the fields). */
  async snapshot(target: string): Promise<PaneSnapshot> {
    // Tab, and the choice is a scar: 0x1f was tried first and display-message
    // ESCAPES non-printables in its OUTPUT — the byte went out, the four
    // characters "\037" came back, split() found nothing, and every field
    // after the first was empty while `dead` (field 0) kept passing. A tab is
    // the one separator measured to survive the round trip unescaped.
    const SEP = "\t";
    const FMT = [
      "#{pane_dead}",
      "#{pane_current_command}",
      "#{pane_synchronized}",
      "#{window_panes}",
      "#{pane_input_off}",
      "#{pane_in_mode}",
      "#{window_zoomed_flag}",
      "#{pane_id}",
      "#{pane_pid}",
      "#{pane_pipe}",
    ].join(SEP);
    const raw = await this.tmux("display-message", "-p", "-t", target, FMT);
    const f = raw.split(SEP);
    return {
      dead: f[0] === "1",
      currentCommand: f[1] ?? "",
      synchronized: f[2] === "1",
      windowPanes: Number(f[3] ?? "0"),
      inputOff: f[4] === "1",
      inMode: f[5] === "1",
      zoomed: f[6] === "1",
      paneId: f[7] ?? "",
      panePid: Number(f[8] ?? "0"),
      piped: f[9] === "1",
    };
  }

  /**
   * Kill the lab server AND remove its socket file. Idempotent.
   *
   * `kill-server` ends the process and leaves the socket behind — after a few
   * runs of this suite `/tmp/tmux-1001/` held 64 dead `cblab-*` files. Harmless
   * individually, and exactly the kind of residue a test harness should not be
   * producing: the next person debugging a stale socket would be reading OUR
   * litter.
   */
  async destroy(): Promise<void> {
    await this.tmuxOk("kill-server");
    const dir = process.env["TMUX_TMPDIR"] ?? `/tmp/tmux-${process.getuid?.() ?? 1000}`;
    await rm(join(dir, this.socket), { force: true }).catch(() => undefined);
  }
}

export type PaneSnapshot = {
  dead: boolean;
  currentCommand: string;
  synchronized: boolean;
  windowPanes: number;
  inputOff: boolean;
  inMode: boolean;
  zoomed: boolean;
  paneId: string;
  panePid: number;
  piped: boolean;
};

/** Unique-enough socket per test file run; hrtime avoids Date.now collisions
 *  when vitest runs files in parallel. */
export function labSocket(tag: string): string {
  return `cblab-${tag}-${process.hrtime.bigint().toString(36)}`;
}

/**
 * #103 — a restart puts the peer back where it was.
 *
 * THE MECHANISM, measured 2026-08-15 on a lab server configured like the
 * fleet's (`renumber-windows on`, `base-index 1`):
 *
 *   start      1:designer 2:bridge-dev 3:process-dev 4:kb-dev 5:kb-ops
 *   kill 3     1:designer 2:bridge-dev 3:kb-dev 4:kb-ops     <- everyone shifts
 *   create     … 5:process-dev                               <- can only append
 *
 * So a restart is a kill plus a create, and with renumbering a create CANNOT
 * land on the freed index — that index now belongs to the peer's successor and
 * `new-window -t <session>:<index>` fails with "index in use" (also measured).
 * The position has to be restored afterwards with `move-window -b`, which
 * inserts BEFORE whoever holds the index — exactly the vacated place.
 *
 * The renumbering itself was recorded in this codebase on 2026-08-04, in
 * `driver.ts`, as the reason an index is not an identity. Nobody carried it
 * through to restart, and the fleet's window order has been scrambling on every
 * restart since — most recently on 2026-08-15, when a human found a peer in a
 * window named after a different role and an operator re-sorted 23 windows by
 * hand.
 *
 * These tests run REAL tmux on an isolated socket. A mock would have proven
 * only that we call the command we decided to call.
 */
import { afterEach, describe, expect, it } from "vitest";
import { TmuxLab, labSocket } from "./tmux-lab.ts";

let lab: TmuxLab | null = null;

afterEach(async () => {
  await lab?.destroy();
  lab = null;
});

/** A session laid out like a real team, under the fleet's tmux options. */
async function fleetLikeSession(names: string[]): Promise<TmuxLab> {
  const l = new TmuxLab(labSocket("idx"));
  // The server must exist before `set -g` — otherwise the options land nowhere
  // and the test silently measures a DIFFERENT tmux than the fleet runs. (Cost
  // one wrong reproduction before it was noticed.)
  await l.tmux("new-session", "-d", "-s", "boot", "sleep 300");
  await l.tmux("set", "-g", "renumber-windows", "on");
  await l.tmux("set", "-g", "base-index", "1");
  await l.tmux("new-session", "-d", "-s", "ai", "-n", names[0] as string, "sleep 300");
  await l.tmux("kill-session", "-t", "boot");
  for (const n of names.slice(1)) {
    await l.tmux("new-window", "-d", "-t", "ai:", "-n", n, "sleep 300");
  }
  return l;
}

async function order(l: TmuxLab): Promise<string> {
  return (await l.tmux("list-windows", "-t", "ai", "-F", "#{window_index}:#{window_name}"))
    .split("\n")
    .join(" ");
}

const TEAM = ["designer", "bridge-dev", "process-dev", "kb-dev", "kb-ops"];

describe("#103: window order survives a restart", () => {
  it("REPRODUCES the scramble when the position is not restored", async () => {
    lab = await fleetLikeSession(TEAM);
    const before = await order(lab);
    // Exactly what a restart does today: kill, then create.
    await lab.tmux("kill-window", "-t", "ai:3");
    await lab.tmux("new-window", "-d", "-t", "ai:", "-n", "process-dev", "sleep 300");
    const after = await order(lab);
    expect(after).not.toBe(before);
    // And it is specifically an append — the peer is now last.
    expect(after.endsWith("process-dev")).toBe(true);
  }, 20_000);

  it("`new-window -t <session>:<index>` CANNOT be the fix — the index is taken", async () => {
    lab = await fleetLikeSession(TEAM);
    await lab.tmux("kill-window", "-t", "ai:3");
    // After renumbering, index 3 belongs to the peer's successor.
    await expect(
      lab.tmux("new-window", "-d", "-t", "ai:3", "-n", "process-dev", "sleep 300"),
    ).rejects.toThrow(/in use/);
  }, 20_000);

  it("`move-window -b` restores the exact original order, from any position", async () => {
    lab = await fleetLikeSession(TEAM);
    const before = await order(lab);
    // First, middle and last — the three cases where an off-by-one hides.
    for (const victim of ["designer", "process-dev", "kb-ops"]) {
      const rows = (
        await lab.tmux("list-windows", "-t", "ai", "-F", "#{window_index} #{window_name}")
      )
        .split("\n")
        .map((r) => r.split(" "));
      const idx = rows.find((r) => r[1] === victim)?.[0] as string;

      await lab.tmux("kill-window", "-t", `ai:${idx}`);
      const created = await lab.tmux(
        "new-window",
        "-d",
        "-t",
        "ai:",
        "-P",
        "-F",
        "#{window_id}",
        "-n",
        victim,
        "sleep 300",
      );
      await lab.tmux("move-window", "-b", "-s", created, "-t", `ai:${idx}`);

      expect(await order(lab)).toBe(before);
    }
  }, 30_000);

  it("a failed move leaves the peer ALIVE at the wrong place, never dead", async () => {
    // The driver swallows a move failure on purpose: a peer running at the
    // wrong index is cosmetic, a restart that fails because a move failed is an
    // outage. Proven by moving onto a nonexistent session.
    lab = await fleetLikeSession(TEAM);
    const created = await lab.tmux(
      "new-window",
      "-d",
      "-t",
      "ai:",
      "-P",
      "-F",
      "#{window_id}",
      "-n",
      "novy",
      "sleep 300",
    );
    await expect(
      lab.tmux("move-window", "-b", "-s", created, "-t", "neexistuje:1"),
    ).rejects.toThrow();
    // NB: the lab harness has its own PaneSnapshot, deliberately separate from
    // the driver's — the harness measures tmux, the driver's type carries our
    // decisions. Same name, different jobs; the harness reports presence as a
    // non-empty `paneId` rather than a `found` flag.
    const snap = await lab.snapshot(created);
    expect(snap.paneId).toMatch(/^%\d+$/);
    expect(snap.dead).toBe(false);
  }, 20_000);
});

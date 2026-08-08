import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.13 — phase 0 of the lifecycle redesign: two defects, no new features.
 *
 * F0.1  "velitel last" was documented by both team tools and implemented twice:
 *       `team_restart` guessed from a substring of the name, `team_stop` read a
 *       `role` field the registry did not have. The second one therefore never
 *       fired, and a team stop put its coordinator down in the middle of the
 *       team it was coordinating. One rule, two definitions, one silently dead.
 *
 * F0.2  "archive before you destroy" lived in `peer_spawn` and nowhere else,
 *       while `peer_stop` and `team_reconcile` also tear panes down. A rule kept
 *       by memory holds until the next caller.
 */

describe("F0.1 — one rule, one source, and it says which", () => {
  it("a DECLARED role wins, and the verdict says so", async () => {
    const { readRole } = await import("../src/handlers/peer-order.ts");
    expect(readRole({ role: "velitel", name: "mic-admin" })).toEqual({
      name: "mic-admin",
      isCoordinator: true,
      source: "declared",
    });
  });

  it("THE REGRESSION: a declaration of something ELSE beats the name", async () => {
    // `mic-velitel-zastupce` contains the word and is not the coordinator. A
    // substring match cannot know that; a declaration can, and someone stating
    // it must not be overruled by the spelling of a name.
    const { readRole } = await import("../src/handlers/peer-order.ts");
    const v = readRole({ role: "tester", name: "mic-velitel-zastupce" });
    expect(v.isCoordinator).toBe(false);
    expect(v.source).toBe("declared");
  });

  it("an undeclared peer still falls back to the name — and is marked as a guess", async () => {
    // A fleet that has declared nothing must not lose the ordering it had.
    const { readRole } = await import("../src/handlers/peer-order.ts");
    expect(readRole({ name: "plt-velitel" })).toEqual({
      name: "plt-velitel",
      isCoordinator: true,
      source: "name",
    });
  });

  it("the coordinator goes last and the rest keep their order", async () => {
    const { orderCoordinatorLast } = await import("../src/handlers/peer-order.ts");
    const peers = [
      { n: "plt-velitel", r: undefined },
      { n: "plt-admin", r: undefined },
      { n: "plt-keeper", r: undefined },
    ];
    const res = orderCoordinatorLast(peers, (p) => ({ role: p.r, name: p.n }));
    expect(res.ordered.map((p) => p.n)).toEqual(["plt-admin", "plt-keeper", "plt-velitel"]);
    // And the caller is told the order rests on a guess.
    expect(res.inferred).toBe(true);
    expect(res.coordinators).toHaveLength(1);
  });

  it("a fully declared team is not marked as inferred", async () => {
    const { orderCoordinatorLast } = await import("../src/handlers/peer-order.ts");
    const res = orderCoordinatorLast(
      [
        { n: "etl-velitel", r: "velitel" },
        { n: "etl-dev", r: "dev" },
      ],
      (p) => ({ role: p.r, name: p.n }),
    );
    expect(res.ordered.map((p) => p.n)).toEqual(["etl-dev", "etl-velitel"]);
    expect(res.inferred).toBe(false);
  });
});

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const TMUX = hasTmux();

describe.skipIf(!TMUX)("F0.2 — the kill throat archives a dead pane first", () => {
  const sessions: string[] = [];
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-killarch-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });
  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });
  afterAll(() => {
    for (const k of sessions) {
      try {
        execFileSync("tmux", ["kill-session", "-t", k], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  });

  function corpse(label: string): string {
    const key = `cbtest-ka-${label}-${process.pid}-${sessions.length}`;
    sessions.push(key);
    execFileSync("tmux", ["new-session", "-d", "-s", key, "--", "/bin/sh", "-c", "sleep 300"]);
    execFileSync("tmux", ["set-window-option", "-t", key, "remain-on-exit", "on"]);
    execFileSync("tmux", [
      "respawn-pane",
      "-k",
      "-t",
      key,
      "--",
      "/bin/sh",
      "-c",
      "echo the-last-words-of-this-process; exit 9",
    ]);
    return key;
  }

  it("THE REGRESSION: killing a dead pane writes the archive first", async () => {
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const key = corpse("dead");
    await new Promise((r) => setTimeout(r, 500));

    await new TmuxDriver().kill(key);

    const files = await readdir(join(tempHome, ".claude-bridge", "control", "archive"));
    expect(files).toHaveLength(1);
    const saved = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        join(tempHome, ".claude-bridge", "control", "archive", files[0] as string),
        "utf-8",
      ),
    );
    expect(saved).toContain("the-last-words-of-this-process");
    expect(saved).toContain("9");
  }, 20_000);

  it("a LIVE pane is not archived — its evidence is its transcript, not a screen", async () => {
    // The condition is what keeps this cheap: a routine stop must not fill the
    // archive with screens nobody will read.
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const key = `cbtest-ka-live-${process.pid}`;
    sessions.push(key);
    execFileSync("tmux", ["new-session", "-d", "-s", key, "--", "/bin/sh", "-c", "sleep 300"]);
    await new Promise((r) => setTimeout(r, 300));

    await new TmuxDriver().kill(key);

    const dir = join(tempHome, ".claude-bridge", "control", "archive");
    const files = await readdir(dir).catch(() => [] as string[]);
    expect(files).toHaveLength(0);
  }, 20_000);
});

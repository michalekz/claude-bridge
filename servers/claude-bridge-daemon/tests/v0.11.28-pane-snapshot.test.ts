/**
 * G1+G2 (F0.5 revised scope) — the driver refuses corpses and gone targets,
 * detects-without-remedying the never-seen states, ends modes with the one
 * command that ends all of them, and sweeps what a dead daemon left behind.
 *
 * The tmux side of every behaviour here was measured live (44 expert
 * experiments + F0); these tests pin OUR decisions on top of those measured
 * answers, with a scripted executor playing tmux verbatim.
 */
import { describe, expect, it, vi } from "vitest";

/**
 * The mock reads the HOLDER at call time, not at factory time. The first
 * version captured `globalThis.__exec ?? actual.execFile` when the factory
 * ran — before any test had scripted anything — so every test silently fell
 * through to REAL tmux against this machine's production server. No damage
 * was done (verified: no stray window, no option set), but the failure mode
 * is exactly the class this week is about: a stub that misses does not
 * error, it reaches for the real thing. Hence the default: an unscripted
 * call THROWS. A test that forgets to script a call fails loudly instead of
 * touching production.
 */
const execHolder = vi.hoisted(() => ({
  current: null as null | ((bin: string, args: string[], opts: unknown, cb: ExecCb) => void),
}));
type ExecCb = (e: Error | null, r: { stdout: string; stderr: string }) => void;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (bin: string, args: string[], opts: unknown, cb: ExecCb) => {
      if (!execHolder.current) throw new Error(`unmocked exec: ${bin} ${args?.join(" ")}`);
      return execHolder.current(bin, args, opts, cb);
    },
  };
});

type Call = { args: string[] };

/** Script tmux: map from a matcher over argv to stdout (or an Error). */
function scriptTmux(
  script: Array<{
    match: (a: string[]) => boolean;
    out: string | Error | ((calls: Call[]) => string);
  }>,
) {
  const calls: Call[] = [];
  execHolder.current = (_bin, args, _opts, cb) => {
    calls.push({ args });
    const hit = script.find((s) => s.match(args));
    const done = (e: Error | null, stdout: string) =>
      cb ? cb(e, { stdout, stderr: "" }) : undefined;
    if (!hit) return done(null, "");
    if (hit.out instanceof Error) return done(hit.out, "");
    if (typeof hit.out === "function") return done(null, hit.out(calls));
    return done(null, hit.out);
  };
  return calls;
}

const SNAP = (over: Partial<Record<string, string>> = {}) => {
  const f = {
    dead: "0",
    pid: "4242",
    cmd: "claude",
    win: "@7",
    inMode: "0",
    sync: "0",
    inoff: "0",
    panes: "1",
    zoom: "0",
    marked: "0",
    alt: "0",
    ...over,
  };
  return [
    f.dead,
    f.pid,
    f.cmd,
    f.win,
    f.inMode,
    f.sync,
    f.inoff,
    f.panes,
    f.zoom,
    f.marked,
    f.alt,
  ].join("\t");
};

const isSnapshot = (a: string[]) =>
  a[0] === "display-message" && (a.at(-1) ?? "").includes("pane_dead");
const isCapture = (a: string[]) => a[0] === "capture-pane";

async function makeDriver() {
  vi.resetModules();
  const mod = await import("../src/hosts/tmux-driver.ts");
  return new mod.TmuxDriver();
}

describe("snapshot decisions in sendKeys", () => {
  it("refuses a GONE target — empty display-message is absence, not a state", async () => {
    const calls = scriptTmux([{ match: isSnapshot, out: "" }]);
    const driver = await makeDriver();
    await expect(driver.sendKeys("@404", "hello")).rejects.toThrow(/missing/);
    // Refusal happened BEFORE anything touched the pane.
    expect(calls.some((c) => c.args[0] === "send-keys" && c.args.includes("-l"))).toBe(false);
  });

  it("refuses a DEAD pane and points at lifecycle, not delivery", async () => {
    scriptTmux([{ match: isSnapshot, out: SNAP({ dead: "1" }) }]);
    const driver = await makeDriver();
    await expect(driver.sendKeys("@7", "hello")).rejects.toThrow(/DEAD|lifecycle/);
  });

  it("ends a mode with `copy-mode -q` — the only command measured to end ALL modes", async () => {
    // clock-mode/choose-tree: `send-keys -X cancel` answers "not in a mode"
    // and the pane stays deaf (expert review, the one live bug found).
    const calls = scriptTmux([
      { match: isSnapshot, out: SNAP({ inMode: "1" }) },
      { match: isCapture, out: "❯ hello\n" },
    ]);
    const driver = await makeDriver();
    await driver.sendKeys("@7", "hello").catch(() => undefined);
    const modeExit = calls.find((c) => c.args[0] === "copy-mode");
    expect(modeExit?.args).toContain("-q");
    expect(calls.some((c) => c.args.includes("-X") && c.args.includes("cancel"))).toBe(false);
  });

  it("a dirty-but-alive pane is DETECTED, never remedied — delivery proceeds", async () => {
    // sync + zoom + an extra pane: zero recorded occurrences in this fleet's
    // history. A remedy nobody has seen fire is a habit, not a safeguard —
    // the log line this produces is the trigger that would justify one.
    const calls = scriptTmux([
      { match: isSnapshot, out: SNAP({ sync: "1", zoom: "1", panes: "2" }) },
      {
        match: isCapture,
        // The box is empty until the payload lands, then it holds the payload —
        // a static capture would read as an unclearable human draft and the
        // refusal path would (correctly!) block delivery for the wrong test.
        out: (calls) =>
          calls.some((c) => c.args[0] === "send-keys" && c.args.includes("-l"))
            ? "❯ hello\n"
            : "❯ \n",
      },
    ]);
    const driver = await makeDriver();
    await driver.sendKeys("@7", "hello").catch(() => undefined);
    // No kill-pane, no set synchronize-panes off, no resize — detection only.
    for (const forbidden of ["kill-pane", "resize-pane"]) {
      expect(calls.some((c) => c.args[0] === forbidden)).toBe(false);
    }
    expect(calls.some((c) => c.args[0] === "set" || c.args[0] === "set-option")).toBe(false);
    // And the payload run was still attempted.
    expect(calls.some((c) => c.args[0] === "send-keys" && c.args.includes("-l"))).toBe(true);
  });
});

describe("spawn sets the fleet history limit", () => {
  it("sets it on the SESSION before new-window — the limit is read at pane creation", async () => {
    const calls = scriptTmux([
      { match: (a) => a[0] === "has-session", out: "" },
      { match: (a) => a[0] === "new-window", out: "@9\n" },
      { match: isSnapshot, out: SNAP() },
      {
        match: (a) => a[0] === "display-message" && (a.at(-1) ?? "").includes("pane_pid"),
        out: "4242",
      },
      { match: (a) => a[0] === "list-panes", out: "4242" },
    ]);
    const driver = await makeDriver();
    await driver
      .spawn({
        sessionKey: "ai:worker.1",
        inSession: "ai",
        cwd: "/tmp",
        command: "/bin/sleep",
        args: ["600"],
        env: {},
      })
      .catch(() => undefined);
    const limitIdx = calls.findIndex(
      (c) => c.args[0] === "set-option" && c.args.includes("history-limit"),
    );
    const windowIdx = calls.findIndex((c) => c.args[0] === "new-window");
    expect(limitIdx).toBeGreaterThanOrEqual(0);
    expect(windowIdx).toBeGreaterThan(limitIdx);
    expect(calls[limitIdx]?.args).toContain("2000");
  });
});

describe("startup hygiene", () => {
  it("sweeps orphan claude-bridge buffers of OTHER pids, never its own", async () => {
    const own = `claude-bridge-${process.pid}-3`;
    const calls = scriptTmux([
      { match: (a) => a[0] === "-V" || a[1] === "-V", out: "tmux 3.4\n" },
      {
        match: (a) => a[0] === "list-buffers",
        out: `claude-bridge-99999-1\n${own}\nnahodny-lidsky-buffer\n`,
      },
    ]);
    const driver = await makeDriver();
    const res = await driver.startupHygiene();
    expect(res.sweptBuffers).toBe(1);
    const deleted = calls.filter((c) => c.args[0] === "delete-buffer").map((c) => c.args.at(-1));
    expect(deleted).toEqual(["claude-bridge-99999-1"]);
  });

  it("an unmeasured tmux version is reported, not tolerated silently", async () => {
    scriptTmux([
      { match: (a) => a.includes("-V"), out: "tmux 3.6\n" },
      { match: (a) => a[0] === "list-buffers", out: "" },
    ]);
    const driver = await makeDriver();
    const res = await driver.startupHygiene();
    expect(res.versionMeasured).toBe(false);
    expect(res.tmuxVersion).toBe("tmux 3.6");
  });

  it("a cold host (no server) is a normal answer, not a failure", async () => {
    scriptTmux([
      { match: (a) => a.includes("-V"), out: "tmux 3.4\n" },
      { match: (a) => a[0] === "list-buffers", out: new Error("no server running") },
    ]);
    const driver = await makeDriver();
    await expect(driver.startupHygiene()).resolves.toMatchObject({ sweptBuffers: 0 });
  });
});

describe("lint: the measured tmux footguns stay out of the codebase", () => {
  it("no source file uses `pipe-pane` with `-o` (toggle semantics drop the pipe on the second call)", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = join(__dirname, "..", "src");
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(ts|cjs|mjs)$/.test(e.name)) {
          const text = await readFile(p, "utf-8");
          if (/pipe-pane[^\n]*(-o|"-o")/.test(text)) offenders.push(p);
        }
      }
    }
    await walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("R3, the other sigil: a pane id is an address too", () => {
  it("`%1` survives parsing instead of becoming the session `_1`", async () => {
    const { parseHostTarget, canonicalHostTarget } = await import("../src/hosts/driver.ts");
    // v0.11.21 fixed `@1011` → `_1011` (all 23 peers unreachable to
    // peer_compact). `%` stayed in UNSAFE_TARGET_CHARS, so `%1` became `_1` —
    // a plausible session name, which makes the failure silent misdirection
    // rather than an error. Found 2026-08-15 by a live test, minutes old.
    expect(parseHostTarget("%1")).toEqual({ kind: "pane", paneId: "%1" });
    expect(canonicalHostTarget("%1")).toBe("%1");
    expect(canonicalHostTarget("%1011")).toBe("%1011");
  });

  it("the other two address kinds still parse as before", async () => {
    const { canonicalHostTarget } = await import("../src/hosts/driver.ts");
    expect(canonicalHostTarget("@1011")).toBe("@1011");
    expect(canonicalHostTarget("plt:velitel.1")).toBe("plt_velitel_1");
  });
});

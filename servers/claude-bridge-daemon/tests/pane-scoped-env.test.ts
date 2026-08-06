import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_PROVIDED_VARS, harvestEnv, sanitizeEnv } from "../src/env-whitelist.ts";
import { paneCommand } from "../src/hosts/tmux-driver.ts";

const execFileAsync = promisify(execFile);

/**
 * `TERM`, `TMUX` and `TMUX_PANE` describe the PANE, not the process in it.
 *
 * One allowlist was answering two questions with the same list: "what may this
 * peer run with" (correct — a peer needs all three) and "what may be stored in
 * `PeerRecord.spawnEnv`" (wrong — the record outlives the pane). Measured
 * 2026-08-04 across the live fleet:
 *
 *   - `kb-ops` was harvested in pane `%71`, relaunched into `%1011`, and kept
 *     `TMUX_PANE=%71` — a pointer to a pane that no longer exists.
 *   - 21 of 23 records had no `TERM` at all: the daemon runs under systemd
 *     with no terminal, so a harvest taken during the outage recorded the
 *     absence, and `env -i` faithfully reproduced it on every relaunch.
 *
 * Neither is reachable by editing the allowlist — `TERM` was in it the whole
 * time. The fix splits harvest from spawn and derives the pane-scoped values
 * at spawn time instead of carrying them.
 */

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

describe("pane-scoped variables are never persisted", () => {
  it("harvestEnv drops the trio, sanitizeEnv keeps it", () => {
    const paneEnv = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      TERM: "tmux-256color",
      TMUX: "/tmp/tmux-1001/default,123,4",
      TMUX_PANE: "%71",
    };

    // Running: the peer needs all of it.
    const forSpawn = sanitizeEnv(paneEnv);
    expect(forSpawn["TERM"]).toBe("tmux-256color");
    expect(forSpawn["TMUX_PANE"]).toBe("%71");

    // Storing: none of it may survive into the record.
    const forRecord = harvestEnv(paneEnv);
    for (const name of HOST_PROVIDED_VARS) {
      expect(forRecord[name]).toBeUndefined();
    }
    // Everything else is untouched — this must not become a second, stricter
    // allowlist by accident.
    expect(forRecord["PATH"]).toBe("/usr/bin");
    expect(forRecord["HOME"]).toBe("/home/x");
  });

  it("paneCommand refuses a caller's copy and asks the pane instead", () => {
    // Defense in depth: even if a stale value reaches the driver, the pane's
    // own answer must win.
    const script =
      paneCommand(
        { PATH: "/usr/bin", TERM: "xterm", TMUX_PANE: "%71", TMUX: "/tmp/sock,1,2" },
        "/bin/sh",
        [],
      )[2] ?? "";
    expect(script).not.toContain("%71");
    expect(script).not.toContain("/tmp/sock,1,2");
    expect(script).not.toContain("xterm");
    // Substituted by the shell from what tmux set, not by us.
    expect(script).toContain('TMUX_PANE="$TMUX_PANE"');
    expect(script).toContain('TMUX="$TMUX"');
    expect(script).toContain('TERM="${TERM:-screen-256color}"');
    expect(script).toContain("PATH='/usr/bin'");
  });
});

describe("state written before the fix is repaired on load", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-pane-env-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it("THE REGRESSION: a stale TMUX_PANE does not survive a daemon restart", async () => {
    const { STATE_VERSION, loadState } = await import("../src/state.ts");
    const { stateFilePath } = await import("@claude-bridge/shared");

    const path = stateFilePath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        stateVersion: STATE_VERSION,
        daemonVersion: "0.10.15",
        daemonStartedAt: "2026-08-04T20:05:00.000Z",
        peers: {
          "11111111-1111-4111-8111-111111111111": {
            sessionId: "11111111-1111-4111-8111-111111111111",
            name: "kb-ops",
            hostDriver: "tmux",
            tmuxTarget: "@1011",
            pid: null,
            status: "running",
            model: null,
            accountProfile: null,
            startedAt: "2026-08-04T20:05:00.000Z",
            lastUpdatedAt: "2026-08-04T20:05:00.000Z",
            // Harvested from pane %71, which was destroyed hours ago.
            spawnEnv: {
              PATH: "/home/x/.nvm/versions/node/v22.14.0/bin:/usr/bin",
              HOME: "/home/x",
              TERM: "tmux-256color",
              TMUX: "/tmp/tmux-1001/default,123,4",
              TMUX_PANE: "%71",
            },
          },
        },
      }),
      "utf-8",
    );

    const doc = await loadState("0.10.16");
    const record = doc.peers["11111111-1111-4111-8111-111111111111"];
    expect(record).toBeDefined();

    // Before the fix these came back verbatim and were replayed into the new
    // pane by every subsequent `peer_restart`, forever.
    expect(record?.observed.spawnEnv?.["TMUX_PANE"]).toBeUndefined();
    expect(record?.observed.spawnEnv?.["TMUX"]).toBeUndefined();
    expect(record?.observed.spawnEnv?.["TERM"]).toBeUndefined();
    // The repair is surgical: PATH is the variable the outage was about, and
    // dropping it here would re-break the fleet a different way.
    expect(record?.observed.spawnEnv?.["PATH"]).toContain("/.nvm/");
    expect(record?.observed.spawnEnv?.["HOME"]).toBe("/home/x");
  });

  it("a record with nothing to repair is left alone", async () => {
    const { STATE_VERSION, loadState } = await import("../src/state.ts");
    const { stateFilePath } = await import("@claude-bridge/shared");

    const clean = { PATH: "/usr/bin", HOME: "/home/x" };
    const path = stateFilePath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        stateVersion: STATE_VERSION,
        daemonVersion: "0.10.16",
        daemonStartedAt: "2026-08-05T05:00:00.000Z",
        peers: {
          "22222222-2222-4222-8222-222222222222": {
            sessionId: "22222222-2222-4222-8222-222222222222",
            name: "already-clean",
            hostDriver: "tmux",
            tmuxTarget: "@1",
            pid: null,
            status: "running",
            model: null,
            accountProfile: null,
            startedAt: "2026-08-05T05:00:00.000Z",
            lastUpdatedAt: "2026-08-05T05:00:00.000Z",
            spawnEnv: clean,
          },
        },
      }),
      "utf-8",
    );

    const doc = await loadState("0.10.16");
    expect(doc.peers["22222222-2222-4222-8222-222222222222"]?.observed.spawnEnv).toEqual(clean);
  });
});

const haveTmux = await execFileAsync("tmux", ["-V"]).then(
  () => true,
  () => false,
);

const SESSION = "cb-pane-scoped-env-test";

describe("the pane gets its own identity and a usable terminal", () => {
  afterAll(async () => {
    await execFileAsync("tmux", ["kill-session", "-t", SESSION]).catch(() => undefined);
  });

  it.skipIf(!haveTmux)(
    "a peer spawned with no TERM in its record still comes up with one",
    async () => {
      // Exactly the state the fleet was left in: the record carries PATH and
      // HOME and nothing pane-shaped. Yesterday this produced a monochrome
      // pane and nobody noticed, because the only assertion was about what
      // must NOT be present.
      const record = harvestEnv({
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        TERM: "tmux-256color",
        TMUX_PANE: "%71",
      });
      expect(record["TERM"]).toBeUndefined();

      const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
      const driver = new TmuxDriver();
      await driver.spawn({
        sessionKey: SESSION,
        cwd: "/tmp",
        command: "/bin/sh",
        args: ["-c", "sleep 30"],
        env: record,
      });

      const { stdout } = await execFileAsync("tmux", [
        "list-panes",
        "-t",
        SESSION,
        "-F",
        "#{pane_pid} #{pane_id}",
      ]);
      const [pidRaw, realPane] = stdout.trim().split(" ");
      const pid = Number.parseInt(pidRaw ?? "", 10);
      expect(Number.isFinite(pid)).toBe(true);

      const raw = await readFile(`/proc/${pid}/environ`, "utf-8");
      const env = new Map(
        raw
          .split("\0")
          .filter((s) => s.includes("="))
          .map((s) => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)] as const),
      );

      // Read inside the pane, not carried in a record that has none. Before
      // the fix `env -i` discarded what tmux set and passed nothing on.
      expect(env.get("TERM")).toBeTruthy();
      // The pane's OWN identity — if this were `%71` the harvested value would
      // have won and the peer would be lying about where it lives.
      expect(env.get("TMUX_PANE")).toBe(realPane);
      expect(env.get("TMUX_PANE")).not.toBe("%71");
      // A `tmux` command run inside the peer has to find its own server.
      expect(env.get("TMUX")).toBeTruthy();
    },
  );
});

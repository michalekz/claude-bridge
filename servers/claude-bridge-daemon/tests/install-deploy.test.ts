import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ExecStart no longer points into the git working tree (v0.10.2).
 *
 * Before this, `install --systemd` rendered the unit with whatever path the
 * installer happened to be invoked from — on this machine
 * `/opt/claude-bridge/servers/claude-bridge-daemon/dist/daemon.cjs`, inside
 * the repo. That made `git checkout` a silent deploy: change branch, restart
 * the service, and it runs whatever the tree now holds, with nothing saying
 * so. Install copies the bundle out to `~/.claude-bridge/bin/` instead.
 *
 * systemctl is not available (and must not be invoked) in tests, so these
 * cover the file-level behaviour: what gets copied, what the unit points at,
 * and that uninstall takes the copy with it.
 */

describe("install --systemd binary deployment", () => {
  let home: string;
  let sourceDir: string;
  let sourceBin: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cb-install-"));
    process.env["HOME"] = home;
    vi.resetModules();

    // A stand-in for the built bundle, laid out the way the real one is:
    //   <pkg>/dist/daemon.cjs  +  <pkg>/package.json  +  <pkg>/templates/
    sourceDir = join(home, "worktree", "servers", "claude-bridge-daemon");
    await mkdir(join(sourceDir, "dist"), { recursive: true });
    await mkdir(join(sourceDir, "templates"), { recursive: true });
    sourceBin = join(sourceDir, "dist", "daemon.cjs");
    await writeFile(sourceBin, "// pretend bundle\n");
    await chmod(sourceBin, 0o644);
    await writeFile(join(sourceDir, "package.json"), JSON.stringify({ version: "0.10.2-test" }));
    await writeFile(
      join(sourceDir, "templates", "claude-bridge-daemon.service"),
      "[Service]\nExecStart=__NODE_BIN__ __DAEMON_BIN__ run\n",
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Records every `systemctl --user ...` the installer would have run. */
  let systemctlCalls: string[][];

  /** Load install.ts with systemctl stubbed out — tests must not touch systemd. */
  async function loadInstall() {
    systemctlCalls = [];
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        execFileSync: vi.fn((_cmd: string, args: string[]) => {
          systemctlCalls.push(args);
          return "";
        }),
      };
    });
    const original = process.argv[1];
    process.argv[1] = sourceBin;
    const mod = await import("../src/install.ts");
    return {
      mod,
      restoreArgv: () => {
        process.argv[1] = original as string;
      },
    };
  }

  it("copies the bundle out of the tree and points ExecStart at the copy", async () => {
    const { mod, restoreArgv } = await loadInstall();
    try {
      await mod.installSystemd();
    } finally {
      restoreArgv();
    }

    const deployed = mod.deployedDaemonPath();
    expect(deployed).toBe(join(home, ".claude-bridge", "bin", "claude-bridge-daemon.cjs"));
    expect(await readFile(deployed, "utf-8")).toBe("// pretend bundle\n");
    // Must be executable — it is what systemd will run.
    expect((await stat(deployed)).mode & 0o111).toBeGreaterThan(0);

    const unit = await readFile(
      join(home, ".config", "systemd", "user", "claude-bridge-daemon.service"),
      "utf-8",
    );
    expect(unit).toContain(deployed);
    // The point of the change: the unit must NOT reference the working tree.
    expect(unit).not.toContain(sourceBin);
    expect(unit).not.toContain("worktree");
  });

  it("restarts rather than starts, so an install over a live daemon replaces it", async () => {
    // `systemctl start` on an active unit is a no-op. The installer used it,
    // so every install over a running daemon rewrote the unit file and left
    // the OLD process running — observed directly: MainPID unchanged after
    // an install, still executing the previous ExecStart path. Exactly the
    // silent drift the deployed-binary change exists to prevent.
    const { mod, restoreArgv } = await loadInstall();
    try {
      await mod.installSystemd();
    } finally {
      restoreArgv();
    }

    const verbs = systemctlCalls.map((a) => a[1]);
    expect(verbs).toContain("restart");
    expect(verbs).not.toContain("start");
  });

  it("records where the running binary came from", async () => {
    const { mod, restoreArgv } = await loadInstall();
    try {
      await mod.installSystemd();
    } finally {
      restoreArgv();
    }

    const meta = JSON.parse(
      await readFile(join(home, ".claude-bridge", "bin", "deployed-from.json"), "utf-8"),
    );
    expect(meta.source).toBe(sourceBin);
    expect(meta.version).toBe("0.10.2-test");
    expect(Number.isNaN(Date.parse(meta.deployedAt))).toBe(false);
  });

  it("editing the tree after install does not change what systemd runs", async () => {
    // This is the whole reason for the change, stated as a test.
    const { mod, restoreArgv } = await loadInstall();
    try {
      await mod.installSystemd();
    } finally {
      restoreArgv();
    }

    await writeFile(sourceBin, "// somebody checked out another branch\n");

    expect(await readFile(mod.deployedDaemonPath(), "utf-8")).toBe("// pretend bundle\n");
  });

  it("uninstall removes the deployed copy so it cannot be resurrected", async () => {
    const { mod, restoreArgv } = await loadInstall();
    try {
      await mod.installSystemd();
      await mod.uninstallSystemd();
    } finally {
      restoreArgv();
    }

    await expect(stat(mod.deployedDaemonPath())).rejects.toThrow();
    await expect(stat(join(home, ".claude-bridge", "bin", "deployed-from.json"))).rejects.toThrow();
  });

  it("re-installing from the deployed copy works and does not truncate it", async () => {
    // Two hazards in one path. First: source and target are the same file, so
    // copyFile onto itself would empty the binary currently executing.
    // Second: template lookup is anchored at argv[1], so the deploy has to
    // carry the unit template with it or this call cannot find one — that is
    // a real defect this test found, not a test artifact.
    const { mod, restoreArgv } = await loadInstall();
    const deployed = mod.deployedDaemonPath();
    try {
      await mod.installSystemd();
    } finally {
      restoreArgv();
    }

    const original = process.argv[1];
    process.argv[1] = deployed;
    try {
      await mod.installSystemd();
    } finally {
      process.argv[1] = original as string;
    }

    expect(await readFile(deployed, "utf-8")).toBe("// pretend bundle\n");
    const unit = await readFile(
      join(home, ".config", "systemd", "user", "claude-bridge-daemon.service"),
      "utf-8",
    );
    expect(unit).toContain(deployed);
  });
});

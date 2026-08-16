import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { makeLogger } from "@claude-bridge/shared";

/**
 * Systemd user-unit install / uninstall.
 *
 * Linux only in alpha (macOS launchd + Windows Task Scheduler in F3 per
 * platform matrix §9). Fails loudly with an actionable message on other
 * platforms — no silent degradation.
 */

const log = makeLogger("daemon.install");

const UNIT_NAME = "claude-bridge-daemon.service";

function systemdUserDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(): string {
  return join(systemdUserDir(), UNIT_NAME);
}

function assertLinux(): void {
  if (process.platform !== "linux") {
    throw new Error(
      "claude-bridge-daemon install --systemd is Linux-only in v0.10.0-alpha. " +
        "macOS launchd and Windows Task Scheduler ship in v0.10.0 F3.",
    );
  }
}

function resolveDaemonBin(): string {
  const argv1 = process.argv[1];
  if (!argv1) throw new Error("process.argv[1] missing — cannot determine daemon binary path");
  if (!argv1.startsWith("/")) return resolve(process.cwd(), argv1);
  return argv1;
}

async function readTemplate(): Promise<string> {
  // Anchor template lookup at the invoked script (process.argv[1]) so we
  // work identically in the CJS bundle and under `tsx` dev. Two well-known
  // relative positions cover both:
  //   bundled:  dist/daemon.cjs   → templates at dist/../templates/
  //   dev:      src/index.ts      → templates at src/templates/
  const anchor = resolveDaemonBin();
  const anchorDir = dirname(anchor);
  const candidates = [
    resolve(anchorDir, "..", "templates", UNIT_NAME),
    resolve(anchorDir, "templates", UNIT_NAME),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf-8");
    } catch {
      // try next
    }
  }
  throw new Error(`Systemd unit template not found (looked in ${candidates.join(", ")})`);
}

function findNodeBin(): string {
  // Prefer the interpreter that started this process — matches what
  // the user actually has on PATH and works inside asdf/nvm shims.
  return process.execPath;
}

/**
 * Where the running daemon binary lives (v0.10.2+).
 *
 * Until now the unit's ExecStart pointed at whatever path the installer was
 * invoked from — in practice the git working tree, `/opt/claude-bridge/...`.
 * That makes a `git checkout` a silent deploy: switch branch or reset, and
 * the next daemon restart runs whatever the tree happens to contain. Nothing
 * announces it, and `control_status` reports a version that no longer matches
 * the code on disk.
 *
 * Install now copies the bundle to a location the daemon owns, and the unit
 * points there. Editing the tree stops affecting the running service until
 * someone deliberately re-installs.
 */
export function deployedDaemonPath(): string {
  return join(homedir(), ".claude-bridge", "bin", "claude-bridge-daemon.cjs");
}

/** Provenance sidecar — answers "which build is actually running?". */
function deployMetaPath(): string {
  return join(dirname(deployedDaemonPath()), "deployed-from.json");
}

async function deployDaemonBinary(sourceBin: string): Promise<string> {
  const target = deployedDaemonPath();
  if (resolve(sourceBin) === resolve(target)) {
    // Re-running the already-deployed copy. Copying it onto itself would
    // truncate the file we are executing from.
    log.info("deploy_skipped_same_path", { path: target });
    return target;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(sourceBin, target);
  await chmod(target, 0o755);

  // Ship the unit template alongside the binary. Without this, running
  // `install --systemd` from the DEPLOYED copy fails: template lookup is
  // anchored at argv[1], and there is no templates/ dir next to it. Caught
  // by the re-install test, which would otherwise have passed for the wrong
  // reason. `readTemplate` already probes `<anchorDir>/templates/`.
  try {
    const templateSource = await readTemplate();
    const templateTarget = join(dirname(target), "templates", UNIT_NAME);
    await mkdir(dirname(templateTarget), { recursive: true });
    await writeFile(templateTarget, templateSource, "utf-8");
  } catch (e) {
    log.warn("template_deploy_failed", { err: String(e) });
  }

  let version = "unknown";
  try {
    const pkg = JSON.parse(
      await readFile(resolve(dirname(sourceBin), "..", "package.json"), "utf-8"),
    ) as { version?: string };
    version = pkg.version ?? "unknown";
  } catch {
    // provenance is best-effort; a missing package.json must not block install
  }
  await writeFile(
    deployMetaPath(),
    `${JSON.stringify({ source: resolve(sourceBin), version, deployedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf-8",
  );
  log.info("daemon_binary_deployed", { source: sourceBin, target, version });
  return target;
}

export async function installSystemd(): Promise<void> {
  assertLinux();
  const sourceBin = resolveDaemonBin();
  const nodeBin = findNodeBin();
  await ensureBinariesExist(sourceBin, nodeBin);
  const daemonBin = await deployDaemonBinary(sourceBin);
  const template = await readTemplate();
  // The daemon shells out to binaries that live beside its own node — `claude`
  // above all — and systemd's default PATH does not include them. Derived from
  // `nodeBin` rather than configured, so it cannot drift from the interpreter
  // the unit actually starts.
  const nodeDir = dirname(nodeBin);
  const rendered = template
    .replace(/__NODE_BIN__/g, nodeBin)
    .replace(/__DAEMON_BIN__/g, daemonBin)
    .replace(/__NODE_DIR__/g, nodeDir);
  await mkdir(systemdUserDir(), { recursive: true });
  await writeFile(unitPath(), rendered, "utf-8");
  log.info("unit_written", { path: unitPath(), execStart: daemonBin });
  runSystemctl("daemon-reload");
  runSystemctl("enable", UNIT_NAME);
  // `restart`, not `start` (v0.10.2). `start` on an already-active service is
  // a no-op, so every install over a running daemon left the OLD process
  // alive while the unit file described the new one. Found by checking
  // MainPID after an install: unchanged, still executing the previous path.
  // `restart` starts an inactive service too, so it is correct in both cases.
  runSystemctl("restart", UNIT_NAME);
  log.info("daemon_started_via_systemd");
}

export async function uninstallSystemd(): Promise<void> {
  assertLinux();
  try {
    runSystemctl("stop", UNIT_NAME);
  } catch (e) {
    log.warn("systemd_stop_failed", { err: String(e) });
  }
  try {
    runSystemctl("disable", UNIT_NAME);
  } catch (e) {
    log.warn("systemd_disable_failed", { err: String(e) });
  }
  try {
    await unlink(unitPath());
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log.warn("unit_unlink_failed", { err: String(e) });
  }
  // Remove the deployed copy too — leaving it behind would let a later
  // `systemctl --user start` resurrect a daemon this uninstall was meant to
  // remove. Order matters: the service is already stopped above.
  for (const path of [deployedDaemonPath(), deployMetaPath()]) {
    try {
      await unlink(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") log.warn("deployed_binary_unlink_failed", { path, err: String(e) });
    }
  }
  runSystemctl("daemon-reload");
  log.info("uninstalled");
}

function runSystemctl(...args: string[]): void {
  execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

async function ensureBinariesExist(daemonBin: string, nodeBin: string): Promise<void> {
  for (const [label, path] of [
    ["daemon", daemonBin],
    ["node", nodeBin],
  ] as const) {
    try {
      await stat(path);
    } catch {
      throw new Error(`${label} binary not found at ${path} — build daemon first (npm run build)`);
    }
  }
}

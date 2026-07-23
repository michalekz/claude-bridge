import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
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

export async function installSystemd(): Promise<void> {
  assertLinux();
  const daemonBin = resolveDaemonBin();
  const nodeBin = findNodeBin();
  await ensureBinariesExist(daemonBin, nodeBin);
  const template = await readTemplate();
  const rendered = template.replace(/__NODE_BIN__/g, nodeBin).replace(/__DAEMON_BIN__/g, daemonBin);
  await mkdir(systemdUserDir(), { recursive: true });
  await writeFile(unitPath(), rendered, "utf-8");
  log.info("unit_written", { path: unitPath() });
  runSystemctl("daemon-reload");
  runSystemctl("enable", UNIT_NAME);
  runSystemctl("start", UNIT_NAME);
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

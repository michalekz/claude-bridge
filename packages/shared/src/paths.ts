import { homedir, platform } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Cross-platform path resolution for Claude Code session JSONL files
 * and the claude-bridge namespace under `~/.claude-bridge/`.
 */

export type Platform = "linux" | "darwin" | "win32";

export function currentPlatform(): Platform {
  const p = platform();
  if (p === "linux" || p === "darwin" || p === "win32") return p;
  throw new Error(`Unsupported platform: ${p}`);
}

export function isWindows(): boolean {
  return currentPlatform() === "win32";
}

export function claudeHome(): string {
  return join(homedir(), ".claude");
}

export function projectsRoot(): string {
  return join(claudeHome(), "projects");
}

export function ideLockDir(): string {
  return join(claudeHome(), "ide");
}

export function encodeProjectDir(absoluteCwd: string, plat: Platform = currentPlatform()): string {
  const dropColon = plat === "win32" ? absoluteCwd.replace(/:/g, "-") : absoluteCwd;
  const collapseSeparators =
    plat === "win32" ? dropColon.replace(/[\\/]+/g, "-") : dropColon.replace(/\/+/g, "-");
  return collapseSeparators.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function projectDir(absoluteCwd: string): string {
  return join(projectsRoot(), encodeProjectDir(resolve(absoluteCwd)));
}

export function sessionFile(absoluteCwd: string, sessionId: string): string {
  return join(projectDir(absoluteCwd), `${sessionId}.jsonl`);
}

export function bridgeRoot(): string {
  return join(homedir(), ".claude-bridge");
}

export function inboxDir(peer: string): string {
  return join(bridgeRoot(), "inbox", peer);
}

export function peerRegistryFile(peer: string): string {
  return join(bridgeRoot(), "peers", `${peer}.json`);
}

export function sessionIndexFile(): string {
  return join(bridgeRoot(), "index", "sessions.sqlite");
}

export const platformSep: string = sep;

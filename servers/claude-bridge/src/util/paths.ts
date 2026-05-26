import { homedir, platform } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Cross-platform path resolution for Claude Code session JSONL files.
 *
 * Claude Code stores sessions per-project in `~/.claude/projects/<encoded-cwd>/`.
 * The cwd encoding rule differs between OSes:
 * - Linux/macOS: `/opt/oxy-kb` → `-opt-oxy-kb`
 * - Windows:     `C:\Users\me\proj` → `C--Users-me-proj`
 *
 * This module centralizes that logic so the rest of the codebase is OS-agnostic.
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

/**
 * Root directory where Claude Code stores user state.
 * Both Linux and Windows resolve `~/.claude` via `homedir()`.
 */
export function claudeHome(): string {
  return join(homedir(), ".claude");
}

export function projectsRoot(): string {
  return join(claudeHome(), "projects");
}

export function ideLockDir(): string {
  return join(claudeHome(), "ide");
}

/**
 * Encode an absolute cwd path into the directory name Claude Code uses.
 *
 * Linux example:   `/opt/oxy-kb`           → `-opt-oxy-kb`
 * Windows example: `C:\Users\me\my-proj`   → `C--Users-me-my-proj`
 *                  `C:/Users/me/my-proj`   → `C--Users-me-my-proj`
 *
 * Algorithm (Linux/macOS): replace every `/` with `-`.
 * Algorithm (Windows): replace `:` with `-`, then `\` and `/` with `-`.
 *
 * Both result in a single-component directory name safe across filesystems.
 */
export function encodeProjectDir(absoluteCwd: string, plat: Platform = currentPlatform()): string {
  if (plat === "win32") {
    return absoluteCwd.replace(/:/g, "-").replace(/[\\/]+/g, "-");
  }
  return absoluteCwd.replace(/\/+/g, "-");
}

/**
 * Resolve the directory holding session JSONL files for a given cwd.
 *
 * Example: cwd `/opt/oxy-kb` → `~/.claude/projects/-opt-oxy-kb/`
 */
export function projectDir(absoluteCwd: string): string {
  return join(projectsRoot(), encodeProjectDir(resolve(absoluteCwd)));
}

/**
 * Path to a session JSONL file, given a cwd and session UUID.
 */
export function sessionFile(absoluteCwd: string, sessionId: string): string {
  return join(projectDir(absoluteCwd), `${sessionId}.jsonl`);
}

/**
 * Path to the inbox dir for a peer, used by the bridge namespace
 * `~/.claude-bridge/inbox/<peer>/`.
 *
 * The inbox is the bridge's own namespace — never write into Claude Code's
 * session files.
 */
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

/**
 * Path separator for the current platform — exported for tests that need to
 * verify path construction on the running platform.
 */
export const platformSep: string = sep;

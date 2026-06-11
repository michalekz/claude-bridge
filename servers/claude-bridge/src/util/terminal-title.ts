import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { makeLogger } from "./logger.ts";

const log = makeLogger("terminal-title");

/**
 * Emit OSC 2 escape sequences to the parent process's controlling tty so
 * the terminal tab title reflects the running peer's ai-title (e.g. "Marketingový
 * stratég" instead of "claude" or "bash").
 *
 * Targeted scenario: CLI-launched Claude Code in a VS Code integrated terminal
 * (or any standard terminal emulator). The plugin process itself has no tty —
 * its stdin/stdout are MCP protocol pipes — so we resolve the parent CC
 * process's tty and write OSC 2 there directly.
 *
 * Background:
 *  - Claude Code closed the upstream feature request to emit OSC 2 itself
 *    (anthropics/claude-code #21409, #18326), so the plugin must do it.
 *  - VS Code's integrated terminal honors OSC 2 in its tab title when the
 *    setting `terminal.integrated.tabs.title` includes `${sequence}` (its
 *    default does).
 *
 * Platform coverage:
 *  - Linux: parse /proc/<ppid>/stat for tty_nr → /dev/pts/<N>.
 *  - macOS: `ps -p <ppid> -o tty=` → /dev/<tty>.
 *  - Windows: not yet — requires Win32 AttachConsole + WriteConsole or a
 *    native helper. Falls back to no-op.
 *
 * The whole subsystem is best-effort: any failure (no tty, parsing error,
 * permission, missing /proc) silently disables title emission. Plugin
 * functionality is unaffected.
 */

/**
 * Parse the `tty_nr` field out of `/proc/<pid>/stat` content.
 *
 * Stat format: `pid (comm) state ppid pgrp session tty_nr tpgid ...`
 * `comm` can contain spaces and parens, so split by the LAST `)` to be safe.
 * Then tty_nr is the 5th field after that (0-indexed: state, ppid, pgrp,
 * session, tty_nr).
 *
 * tty_nr device-number encoding (Linux legacy):
 *  - bits 0..7:    minor LSB
 *  - bits 8..15:   major
 *  - bits 16..19:  reserved
 *  - bits 20..31:  minor MSB (shifted left by 12 to combine with LSB)
 *
 * Returns `{ major, minor }` or null when stat is malformed or tty_nr is 0.
 * tty_nr === 0 means the process has no controlling terminal.
 */
export function parseTtyNrFromProcStat(stat: string): { major: number; minor: number } | null {
  const lastParen = stat.lastIndexOf(")");
  if (lastParen === -1) return null;
  const after = stat.slice(lastParen + 2);
  const fields = after.split(" ");
  const ttyNrStr = fields[4];
  if (!ttyNrStr) return null;
  const ttyNr = Number.parseInt(ttyNrStr, 10);
  if (Number.isNaN(ttyNr) || ttyNr === 0) return null;
  const major = (ttyNr >> 8) & 0xff;
  const minorLow = ttyNr & 0xff;
  const minorHigh = (ttyNr >> 12) & 0xfff00;
  const minor = minorLow | minorHigh;
  return { major, minor };
}

/**
 * Linux: read /proc/<ppid>/stat and derive /dev/pts/<N>. major===136 is the
 * pty multiplexer; other major numbers (physical ttys, virtual consoles) are
 * unsupported here and return null.
 */
function findLinuxParentTty(ppid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${ppid}/stat`, "utf-8");
    const parsed = parseTtyNrFromProcStat(stat);
    if (!parsed) return null;
    if (parsed.major === 136) {
      return `/dev/pts/${parsed.minor}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * macOS: shell out to `ps` since there's no /proc. tty="?" / "??" means no
 * controlling terminal; any other value gets prefixed with /dev/.
 */
function findMacOSParentTty(ppid: number): string | null {
  try {
    const tty = execFileSync("ps", ["-p", String(ppid), "-o", "tty="], {
      encoding: "utf-8",
      timeout: 1000,
    }).trim();
    if (!tty || tty === "?" || tty === "??") return null;
    return `/dev/${tty}`;
  } catch {
    return null;
  }
}

/**
 * Resolve the parent process's controlling tty path. Returns null when not
 * available (Extension-launched CC has no tty; Windows isn't supported yet).
 */
export function findParentTty(
  ppid: number,
  plat: NodeJS.Platform = process.platform,
): string | null {
  if (plat === "linux") return findLinuxParentTty(ppid);
  if (plat === "darwin") return findMacOSParentTty(ppid);
  return null;
}

/**
 * Write an OSC 2 escape sequence to the given tty path. Best-effort — any
 * error (tty closed, permission denied, path vanished) is swallowed so the
 * plugin doesn't crash on cosmetic UX.
 */
export function emitTerminalTitle(tty: string, title: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(tty, "w");
    writeSync(fd, `\x1b]2;${title}\x07`);
  } catch (e) {
    log.debug("emit_failed", { tty, err: e instanceof Error ? e.message : String(e) });
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Opt-out via env var `CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE=0` (or `false`).
 * Default: enabled.
 */
export function isTerminalTitleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env["CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE"];
  if (v === undefined || v === "") return true;
  const norm = v.toLowerCase();
  return norm !== "0" && norm !== "false";
}

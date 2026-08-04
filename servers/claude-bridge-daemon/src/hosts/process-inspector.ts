import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Reads the live process table to find Claude Code peers the daemon did not
 * spawn (v0.10.1, for `team_adopt`).
 *
 * Motivating case: the HMH team is launched by `start_peer.sh` (tmux +
 * `claude --resume`), so the daemon knows zero peers while the bridge registry
 * sees eleven. Every lifecycle tool then fails with `peer_not_found`
 * (velitel's report 2026-07-25 16:54). Adoption closes that gap.
 *
 * Behind an interface so tests can supply a fake table instead of needing a
 * real tmux server and real Claude processes.
 */

export interface ProcessRecord {
  pid: number;
  ppid: number;
  /** Claude Code session UUID, or null when it could not be determined. */
  sessionId: string | null;
  /** How `sessionId` was resolved — recorded in the adoption audit trail. */
  sessionIdSource: "sessions-json" | "resume-arg" | "none";
  /** Full command line, space-joined. Diagnostics only. */
  cmdline: string;
  /**
   * `/proc/<pid>/cmdline` split on its NUL separators — the executable followed
   * by its arguments, exactly as the process was launched.
   *
   * Adoption needs the argv boundaries, not the joined string: a peer adopted
   * without them carries no `command`/`spawnArgs`, and the first daemon-issued
   * `peer_restart` then falls back to a bare `claude`. On this fleet that
   * resolves to nothing (nvm), so adoption would look complete while the
   * control layer was unusable at the exact moment anyone first needed it
   * (raised by plt-designer, 2026-08-04).
   */
  argv: string[];
  /** Resolved `/proc/<pid>/cwd`. Null when the link cannot be read. */
  cwd: string | null;
  /**
   * `argv[0]` resolved to an absolute path using the PEER's own `PATH`.
   *
   * The fleet runs `claude` as a bare name. A relaunch composes its
   * environment from the whitelist, whose `PATH` comes from the daemon — and
   * the daemon runs under systemd with a stock `PATH` that has no nvm. So a
   * bare name that works for the peer does not resolve for the relaunch, and
   * the first peer of every group would have died on a fleet roll
   * (plt-designer, pre-rollout probe, 2026-08-04).
   *
   * The peer's own `PATH` is in `/proc/<pid>/environ` and by definition knows
   * where its own binary lives. Null when it cannot be resolved — the caller
   * then keeps argv[0] as given rather than inventing a path.
   */
  resolvedCommand: string | null;
}

export interface ProcessInspector {
  /** Every live process that is a Claude Code peer (not an MCP child). */
  listClaudePeers(): Promise<ProcessRecord[]>;
  /**
   * Ancestor pids of `pid`, nearest first, so a caller can decide which tmux
   * pane owns a process. Stops at pid 1 or `maxDepth`.
   */
  ancestorsOf(pid: number, maxDepth?: number): Promise<number[]>;
}

const DEFAULT_MAX_DEPTH = 8;
/** A bare UUID, or the basename of a `<uuid>.jsonl` transcript path. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Parse `ppid` out of `/proc/<pid>/stat`.
 *
 * The `comm` field is parenthesised and may itself contain spaces and
 * parentheses, so the only safe anchor is the LAST `)`. After it the fields
 * are `state ppid …`.
 */
export function parsePpidFromStat(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  return Number.isNaN(ppid) ? null : ppid;
}

/**
 * Pull a session UUID out of a command line.
 *
 * `start_peer.sh` passes `--resume <path>/<uuid>.jsonl`, not a bare UUID —
 * verified against the live fleet — so match the UUID anywhere in the token.
 */
export function sessionIdFromCmdline(cmdline: string): string | null {
  const idx = cmdline.indexOf("--resume");
  if (idx === -1) return null;
  const rest = cmdline.slice(idx + "--resume".length).trim();
  const token = rest.split(/\s+/)[0] ?? "";
  const match = UUID_RE.exec(basename(token));
  return match ? match[0] : null;
}

export interface LinuxProcessInspectorOptions {
  /** Override for tests. Defaults to `/proc`. */
  procRoot?: string;
  /** Override for tests. Defaults to `~/.claude/sessions`. */
  sessionsDir?: string;
}

/**
 * `/proc`-backed inspector. Linux (and WSL2) only; elsewhere `listClaudePeers`
 * simply finds nothing and `team_adopt` reports that auto-discovery is
 * unavailable rather than pretending the fleet is empty.
 */
export class LinuxProcessInspector implements ProcessInspector {
  private readonly procRoot: string;
  private readonly sessionsDir: string;

  constructor(opts: LinuxProcessInspectorOptions = {}) {
    this.procRoot = opts.procRoot ?? "/proc";
    this.sessionsDir = opts.sessionsDir ?? join(homedir(), ".claude", "sessions");
  }

  async listClaudePeers(): Promise<ProcessRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.procRoot);
    } catch {
      return [];
    }
    const out: ProcessRecord[] = [];
    for (const entry of entries) {
      const pid = Number.parseInt(entry, 10);
      if (Number.isNaN(pid) || String(pid) !== entry) continue;
      // `comm` is the cheapest discriminator: a peer's process is `claude`,
      // while its bundled MCP server shows up as `node`.
      const comm = await this.readProcFile(pid, "comm");
      if (comm?.trim() !== "claude") continue;

      const stat = await this.readProcFile(pid, "stat");
      const ppid = stat ? parsePpidFromStat(stat) : null;
      const raw = await this.readProcFile(pid, "cmdline");
      const argv = (raw ?? "").split("\0").filter((a) => a.length > 0);
      const cmdline = argv.join(" ").trim();
      const cwd = await this.readProcCwd(pid);
      const resolvedCommand = await this.resolveViaProcessPath(pid, argv[0] ?? "");

      const { sessionId, source } = await this.resolveSessionId(pid, cmdline);
      out.push({
        pid,
        ppid: ppid ?? 0,
        sessionId,
        sessionIdSource: source,
        cmdline,
        argv,
        cwd,
        resolvedCommand,
      });
    }
    return out;
  }

  /**
   * Turn a bare command into an absolute path, using the process's own `PATH`.
   *
   * Only the owning process knows where its binary came from — under nvm the
   * directory is not on any system path. An already-absolute command is
   * returned unchanged; anything unresolvable returns null so the caller keeps
   * what it was given instead of guessing.
   */
  async resolveViaProcessPath(pid: number, command: string): Promise<string | null> {
    if (command.length === 0) return null;
    if (command.startsWith("/")) return command;
    const environ = await this.readProcFile(pid, "environ");
    if (!environ) return null;
    const pathVar = environ
      .split("\0")
      .find((e) => e.startsWith("PATH="))
      ?.slice("PATH=".length);
    if (!pathVar) return null;
    for (const dir of pathVar.split(":")) {
      if (dir.length === 0) continue;
      const candidate = join(dir, command);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
    return null;
  }

  private async readProcCwd(pid: number): Promise<string | null> {
    try {
      return await readlink(join(this.procRoot, String(pid), "cwd"));
    } catch {
      // Not readable for another user's process, and absent in the test fixtures
      // that fake /proc with plain files. Neither is a reason to fail adoption.
      return null;
    }
  }

  async ancestorsOf(pid: number, maxDepth = DEFAULT_MAX_DEPTH): Promise<number[]> {
    const chain: number[] = [];
    let current = pid;
    for (let i = 0; i < maxDepth; i++) {
      const stat = await this.readProcFile(current, "stat");
      if (!stat) break;
      const ppid = parsePpidFromStat(stat);
      if (ppid === null || ppid <= 1) break;
      chain.push(ppid);
      current = ppid;
    }
    return chain;
  }

  /**
   * `~/.claude/sessions/<pid>.json` is authoritative — it is the same file the
   * MCP server reads to learn its own identity, so it exists for every peer
   * including ones started without `--resume`. The command line is only a
   * fallback for the window where that file is missing.
   */
  private async resolveSessionId(
    pid: number,
    cmdline: string,
  ): Promise<{ sessionId: string | null; source: ProcessRecord["sessionIdSource"] }> {
    try {
      const raw = await readFile(join(this.sessionsDir, `${pid}.json`), "utf-8");
      const parsed = JSON.parse(raw) as { sessionId?: string };
      if (parsed.sessionId) return { sessionId: parsed.sessionId, source: "sessions-json" };
    } catch {
      // fall through to the command line
    }
    const fromArgs = sessionIdFromCmdline(cmdline);
    if (fromArgs) return { sessionId: fromArgs, source: "resume-arg" };
    return { sessionId: null, source: "none" };
  }

  private async readProcFile(pid: number, name: string): Promise<string | null> {
    try {
      return await readFile(join(this.procRoot, String(pid), name), "utf-8");
    } catch {
      return null;
    }
  }
}

export function defaultProcessInspector(): ProcessInspector {
  return new LinuxProcessInspector();
}

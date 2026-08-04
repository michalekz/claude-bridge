import type { Stats } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { encodeProjectDir } from "./util/paths.ts";

/**
 * Peer identity resolution.
 *
 * Two-level identity (refactored 2026-05-25 — v0.2.0):
 *
 * - **`id`** (stable, unique): Claude Code session UUID read from
 *   `~/.claude/sessions/<ppid>.json` `.sessionId`. Used as the inbox dir
 *   key + heartbeat file key. NEVER collides — every chat has a unique
 *   sessionId.
 *
 * - **`name`** (display label, may collide): human-readable string from
 *   cascade below. Used in `peer_list` output, piggyback formatting,
 *   `peer_ask`/`peer_reply` `to` parameter (lookup → id).
 *
 * Display name cascade:
 *   A. JSONL `custom-title` / `ai-title` event (Claude Code auto-generates)
 *   B. `session.json .name` (user set via `/name` slash command)
 *   C. env `CLAUDE_BRIDGE_PEER_NAME` (orchestrator override)
 *   D. slug from `basename(cwd)` (last resort fallback)
 *
 * Hard requirement: `session.json` MUST exist and have `.sessionId`. Without
 * it the peer registry can't operate — we throw `IdentityError`. This is
 * deterministic and surfaces broken Claude Code setups early instead of
 * silently degrading to colliding identities.
 */

const NAME_MAX_LEN = 64;
const NAME_VALID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function sanitizePeerName(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const slugified = trimmed.replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "-");
  const collapsed = slugified.replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!collapsed) return null;
  const truncated = collapsed.slice(0, NAME_MAX_LEN);
  return NAME_VALID.test(truncated) ? truncated : null;
}

export function slugFromCwd(cwd: string): string {
  const raw = basename(cwd) || "root";
  return sanitizePeerName(raw) ?? "claude-bridge-peer";
}

// ============================================================================
// Internal readers (exported for testability)
// ============================================================================

export type SessionJson = {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  name?: string;
  version?: string;
  entrypoint?: string;
};

export async function readSessionJsonAt(path: string): Promise<SessionJson | null> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as SessionJson;
  } catch {
    return null;
  }
}

/**
 * Incremental title scan (fix, 2026-08-03).
 *
 * This function used to be `readFile` + `split("\n")` + `JSON.parse` per line
 * over the peer's ENTIRE transcript, called every 5 seconds by the identity
 * refresh timer. Transcripts reach hundreds of megabytes, so each tick
 * allocated several times the file size; across the fleet that was measured at
 * `RSS ≈ 60 MB + 4.7 × JSONL_MB` and accounted for roughly 5.5 GB of the 7 GB
 * the MCP servers were holding. It is not a retention leak — the heap comes
 * back — but V8 never returns the high-water mark to the OS, so RSS ratchets up
 * and stays.
 *
 * Two rejected alternatives, both measured before landing this one:
 *   - naive `readline` over the whole file: only 3.7× better and NOT faster,
 *     because it still builds a string per line for the entire transcript;
 *   - streaming with an early `break` once the title is found: leaks. An
 *     abandoned `for await` over a `readline.Interface` does not close the
 *     underlying stream — 5 abandonments measured at +150 MB RSS, 5 fds and 5
 *     permanently pending libuv handles, surviving GC.
 *
 * So: one full pass at first sight, then read only the bytes appended since.
 * A transcript is append-only, so the incremental path is correct as well as
 * cheap, and it stays correct for `custom-title` (written on `/rename`, and
 * therefore arriving at the END of the file long after the initial scan).
 *
 * Measured on a 44 MB transcript, 20 ticks: peak 894 MB → 216 MB, 8218 ms → 4 ms.
 */

interface TitleScanState {
  size: number;
  mtimeMs: number;
  /** Bytes already scanned. */
  offset: number;
  custom: string | null;
  ai: string | null;
}

/**
 * Keyed by path, one entry per peer transcript this process looks at — in
 * practice one, since a peer only ever reads its own. Bounded by the number of
 * distinct transcripts, not by time or by file size.
 */
const titleScanCache = new Map<string, TitleScanState>();

/** Exported for tests — a fresh process starts with an empty cache anyway. */
export function resetTitleScanCache(): void {
  titleScanCache.clear();
}

const SCAN_CHUNK_BYTES = 256 * 1024;

function scanTitlesInto(text: string, acc: { custom: string | null; ai: string | null }): void {
  for (const line of text.split("\n")) {
    // Cheap reject before JSON.parse: only title events carry "-title", and
    // they are a handful of lines in a transcript of hundreds of thousands.
    if (!line || line.indexOf("-title") === -1) continue;
    let event: { type?: string; customTitle?: string; aiTitle?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "custom-title" && typeof event.customTitle === "string") {
      acc.custom = event.customTitle;
    } else if (event.type === "ai-title" && typeof event.aiTitle === "string") {
      acc.ai = event.aiTitle;
    }
  }
}

/**
 * Read `[from, to)` and fold any title events into `acc`.
 *
 * Uses an explicit fd with `finally { close }` rather than `readline`: the
 * chunk loop keeps memory constant regardless of file size, and there is no
 * iterator that could be abandoned and strand a handle. `StringDecoder` carries
 * partial multi-byte characters across chunk boundaries, and `carry` does the
 * same for partial lines.
 */
async function scanRange(
  jsonlPath: string,
  from: number,
  to: number,
  acc: { custom: string | null; ai: string | null },
): Promise<void> {
  if (to <= from) return;
  const fh = await open(jsonlPath, "r");
  const decoder = new StringDecoder("utf8");
  try {
    const buf = Buffer.allocUnsafe(Math.min(SCAN_CHUNK_BYTES, to - from));
    let pos = from;
    let carry = "";
    while (pos < to) {
      const want = Math.min(buf.length, to - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const text = carry + decoder.write(buf.subarray(0, bytesRead));
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) {
        carry = text;
        continue;
      }
      scanTitlesInto(text.slice(0, lastNewline), acc);
      carry = text.slice(lastNewline + 1);
    }
    const tail = carry + decoder.end();
    if (tail) scanTitlesInto(tail, acc);
  } finally {
    await fh.close();
  }
}

export async function readLatestTitleFromJsonl(jsonlPath: string): Promise<string | null> {
  let s: Stats;
  try {
    s = await stat(jsonlPath);
  } catch {
    return null;
  }

  const cached = titleScanCache.get(jsonlPath);
  if (cached) {
    // Unchanged — answer from cache. This is the common case for an idle peer
    // and costs one stat().
    if (s.size === cached.size && s.mtimeMs === cached.mtimeMs) {
      return cached.custom ?? cached.ai;
    }
    // A transcript only ever grows. Shrinking, or an mtime that moved
    // BACKWARDS, means it is not the file we were tracking — rotated, replaced,
    // restored from a backup. "Should not happen" is not an invariant, so throw
    // the cache away and rescan rather than reading garbage at a stale offset.
    if (s.size < cached.offset || s.mtimeMs < cached.mtimeMs) {
      titleScanCache.delete(jsonlPath);
      return readLatestTitleFromJsonl(jsonlPath);
    }
  }

  const acc = { custom: cached?.custom ?? null, ai: cached?.ai ?? null };
  const from = cached?.offset ?? 0;
  try {
    await scanRange(jsonlPath, from, s.size, acc);
  } catch {
    return acc.custom ?? acc.ai;
  }

  titleScanCache.set(jsonlPath, {
    size: s.size,
    mtimeMs: s.mtimeMs,
    offset: s.size,
    custom: acc.custom,
    ai: acc.ai,
  });
  return acc.custom ?? acc.ai;
}

// ============================================================================
// Public API
// ============================================================================

export type IdentityOptions = {
  ppid?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Override the `/proc` root — tests only. */
  procRoot?: string;
  /**
   * Override the session id read from the parent's `--resume` — tests only.
   * Production reads it from `/proc/<ppid>/cmdline`.
   */
  resumedSessionId?: string | null;
};

/**
 * Where the display `name` came from. The `id` comes from the parent's
 * `--resume` argument when it has one, otherwise from session.json.
 */
export type IdentitySource = "jsonl-title" | "session-json-name" | "env" | "cwd-slug";

export interface ResolvedIdentity {
  /** Stable unique identifier — Claude Code sessionId UUID. */
  id: string;
  /** FS-safe slug for `peer_ask { to }` and routing (lowercased, kebab-cased). */
  name: string;
  /** Human-readable original title (with spaces, capitals, etc.). Defaults to `name` when no raw title available. */
  displayName: string;
  /** Where the display name came from. */
  source: IdentitySource;
}

export const ENV_PEER_NAME = "CLAUDE_BRIDGE_PEER_NAME";

export class IdentityError extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

const UUID_IN_PATH_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The session UUID our parent Claude Code was launched to resume, read from
 * `/proc/<ppid>/cmdline`. Returns null when the process wasn't resumed, or
 * on any platform without `/proc`.
 *
 * `--resume` carries a path (`.../<uuid>.jsonl`), not a bare UUID.
 */
export async function resumedSessionIdFromParent(
  ppid: number,
  procRoot = "/proc",
): Promise<string | null> {
  try {
    const raw = await readFile(join(procRoot, String(ppid), "cmdline"), "utf-8");
    const cmdline = raw.replace(/\0/g, " ");
    const idx = cmdline.indexOf("--resume");
    if (idx === -1) return null;
    const token =
      cmdline
        .slice(idx + "--resume".length)
        .trim()
        .split(/\s+/)[0] ?? "";
    const match = UUID_IN_PATH_RE.exec(basename(token));
    return match ? match[0].toLowerCase() : null;
  } catch {
    return null; // no /proc, no permission, process gone — cross-check unavailable
  }
}

export async function resolvePeerIdentity(opts: IdentityOptions = {}): Promise<ResolvedIdentity> {
  const home = opts.home ?? homedir();
  const ppid = opts.ppid ?? process.ppid;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  // Hard prerequisite: session.json with sessionId
  const sjPath = join(home, ".claude", "sessions", `${ppid}.json`);
  const sj = await readSessionJsonAt(sjPath);
  if (!sj?.sessionId) {
    throw new IdentityError(
      `Cannot resolve peer identity — ${sjPath} ${sj ? "missing sessionId field" : "does not exist"}`,
      "claude-bridge needs ~/.claude/sessions/<ppid>.json with .sessionId to assign a stable peer id. " +
        "This file is written automatically by Claude Code CLI 2.1.x+ and the VS Code extension. " +
        "Check that you're running a supported Claude Code version and that ppid resolution is correct.",
    );
  }

  // `--resume` wins over session.json for the id (fix, 2026-08-04).
  //
  // On a resumed session Claude Code first writes a PROVISIONAL identity
  // into sessions/<ppid>.json — a fresh session id plus an auto-generated
  // name — and only replaces the id with the resumed one moments later. A
  // server that boots inside that window adopts an id that is about to stop
  // existing, and everything downstream inherits it: the heartbeat under
  // status/, an inbox directory, the entry other peers see in peer_list.
  // Mail addressed to it lands in a directory nobody drains.
  //
  // Observed live 2026-08-04: this peer came up as 99e371a7 while Claude
  // Code held fb749bc6. The phantom existed in no session file and no
  // transcript — the only way both can be true is that the file's contents
  // changed underneath us.
  //
  // The pre-existing retry only covers an ABSENT file; a provisional one is
  // present and well-formed, so nothing retried.
  //
  // Measured live, twice, once the fix was already in:
  //
  //   00:33:04  new  pid 1420859  id=53a70457-…  name=claude-bridge-f9
  //   00:33:06  CHANGED          id → fb749bc6-…  (name unchanged)
  //
  // So the window is ~2 s, and only the id is rewritten — the auto-generated
  // name is final from the first write.
  //
  // Retrying until the two sources agree was the first version of this fix.
  // It was rejected for the wrong reason ("the window runs to ~15 s, past
  // the retry budget"); that 15 s was how long the phantom happened to
  // survive before anyone looked, not how long it existed. Retrying would
  // probably have worked. Preferring `--resume` is still better — fixed at
  // launch, cannot drift, closes the window rather than narrowing it, and
  // costs no startup delay — but the original justification did not hold.
  //
  // Verified against the live fleet: all 21 running peers agree, so in
  // steady state this changes nothing.
  const resumedId =
    opts.resumedSessionId ?? (await resumedSessionIdFromParent(ppid, opts.procRoot));
  const id = resumedId ?? sj.sessionId;
  if (resumedId && resumedId !== sj.sessionId.toLowerCase()) {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        component: "identity",
        msg: "provisional_session_json_overridden",
        fromSessionJson: sj.sessionId,
        fromResume: resumedId,
        ppid,
      })}\n`,
    );
  }

  // Display name cascade

  // A: JSONL title (Claude Code auto-generates after first user message)
  if (sj.cwd) {
    const encoded = encodeProjectDir(sj.cwd);
    // `id`, not `sj.sessionId` — during the provisional window those differ,
    // and reading the title out of the phantom's (nonexistent) transcript
    // would drop us to the auto-generated name for no reason.
    const jsonlPath = join(home, ".claude", "projects", encoded, `${id}.jsonl`);
    const title = await readLatestTitleFromJsonl(jsonlPath);
    if (title) {
      const sanitized = sanitizePeerName(title);
      if (sanitized) {
        return { id, name: sanitized, displayName: title, source: "jsonl-title" };
      }
    }
  }

  // B: session.json .name (user set via /name)
  if (sj.name) {
    const sanitized = sanitizePeerName(sj.name);
    if (sanitized) {
      return { id, name: sanitized, displayName: sj.name, source: "session-json-name" };
    }
  }

  // C: env override
  const envName = env[ENV_PEER_NAME];
  if (envName) {
    const sanitized = sanitizePeerName(envName);
    if (sanitized) {
      return { id, name: sanitized, displayName: envName, source: "env" };
    }
  }

  // D: cwd slug — no separate raw display, displayName falls back to slug
  const slug = slugFromCwd(cwd);
  return { id, name: slug, displayName: slug, source: "cwd-slug" };
}

/**
 * Default retry delays (ms) for `resolvePeerIdentityWithRetry`.
 * Sum ≈ 3 s — comfortably above the cold-boot race window where
 * Claude Code hasn't finished writing `~/.claude/sessions/<ppid>.json`.
 */
export const DEFAULT_IDENTITY_RETRY_DELAYS_MS = [100, 200, 400, 800, 1500];

export type RetryIdentityOptions = IdentityOptions & {
  /**
   * Delays (ms) between retry attempts. Empty array = no retry (single attempt).
   * Defaults to `DEFAULT_IDENTITY_RETRY_DELAYS_MS`.
   */
  retryDelays?: number[];
};

/**
 * Same as `resolvePeerIdentity`, but retries on cold-boot races where
 * `~/.claude/sessions/<ppid>.json` isn't yet written when our MCP server
 * boots. Honors `retryDelays` for tests; default backoff is gentle and
 * caps at ~3 s total.
 */
export async function resolvePeerIdentityWithRetry(
  opts: RetryIdentityOptions = {},
): Promise<ResolvedIdentity> {
  const delays = opts.retryDelays ?? DEFAULT_IDENTITY_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await resolvePeerIdentity(opts);
    } catch (e) {
      lastError = e;
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
  throw lastError;
}

/**
 * Backwards-compat shim — returns just the legacy `{ name, source }` shape.
 * @deprecated Use `resolvePeerIdentity()` instead. Kept until callers migrate.
 */
export async function resolvePeerName(opts: IdentityOptions = {}): Promise<{
  name: string;
  source: IdentitySource;
}> {
  const id = await resolvePeerIdentity(opts);
  return { name: id.name, source: id.source };
}

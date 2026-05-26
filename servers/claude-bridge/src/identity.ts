import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

export async function readLatestTitleFromJsonl(jsonlPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(jsonlPath, "utf-8");
  } catch {
    return null;
  }
  let latestCustom: string | null = null;
  let latestAi: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let event: { type?: string; customTitle?: string; aiTitle?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "custom-title" && typeof event.customTitle === "string") {
      latestCustom = event.customTitle;
    } else if (event.type === "ai-title" && typeof event.aiTitle === "string") {
      latestAi = event.aiTitle;
    }
  }
  return latestCustom ?? latestAi;
}

// ============================================================================
// Public API
// ============================================================================

export type IdentityOptions = {
  ppid?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
};

/** Where the display `name` came from. The `id` always comes from session.json. */
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

  const id = sj.sessionId;

  // Display name cascade

  // A: JSONL title (Claude Code auto-generates after first user message)
  if (sj.cwd) {
    const encoded = encodeProjectDir(sj.cwd);
    const jsonlPath = join(home, ".claude", "projects", encoded, `${sj.sessionId}.jsonl`);
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

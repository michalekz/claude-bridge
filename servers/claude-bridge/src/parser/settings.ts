import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeHome } from "../util/paths.ts";

/**
 * Read the user's ~/.claude/settings.json for authoritative model + [1m] tag.
 *
 * Why we need this (v0.8.1 discovery):
 *   JSONL `message.model` = `"claude-fable-5"` (bare id — Anthropic API strips
 *   the `[1m]` suffix before returning it in the response). But the user's
 *   configured model in `~/.claude/settings.json` reads `"claude-fable-5[1m]"`
 *   WITH the tag preserved. So the JSONL alone can't tell us whether a session
 *   is running the 1M variant of a model whose canonical entry is 200k
 *   (e.g. Haiku 4.5). Reading settings.json gives us that signal reliably.
 *
 * Scope: USER-global (`~/.claude/settings.json`). Project-level overrides
 * (`.claude/settings.json` in cwd) exist but are not merged here — for the
 * peer_context_status use case, user-global is the dominant source.
 *
 * Failure mode: file missing, unreadable, or malformed JSON → returns null.
 * Callers should treat that as "no settings signal, fall through to next
 * detection layer" — same behavior as if settings.model wasn't set.
 */

export interface ClaudeSettings {
  /** Model id, may carry `[1m]` suffix (e.g. `"claude-fable-5[1m]"`). */
  model?: string;
}

export function claudeSettingsPath(): string {
  return join(claudeHome(), "settings.json");
}

/**
 * Read and parse `~/.claude/settings.json`. Returns null on any failure
 * (missing file, permission denied, malformed JSON) so callers don't need
 * to distinguish — the caller either has a settings signal or it doesn't.
 */
export async function readClaudeSettings(): Promise<ClaudeSettings | null> {
  try {
    const raw = await readFile(claudeSettingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const rawModel = record["model"];
    const model = typeof rawModel === "string" ? rawModel : undefined;
    return { ...(model !== undefined ? { model } : {}) };
  } catch {
    return null;
  }
}

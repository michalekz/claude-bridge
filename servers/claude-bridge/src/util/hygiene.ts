import type { Dirent } from "node:fs";
import { readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeLogger } from "./logger.ts";
import { bridgeRoot } from "./paths.ts";

/**
 * Workspace hygiene sweep (v0.10.2).
 *
 * `~/.claude-bridge/` had no expiry on anything. Measured on the platform
 * machine 2026-08-03, after ~10 weeks of use:
 *
 *   inbox/<peer>/done/   12 649 files / 57 MB, oldest 2026-05-25
 *   live/statusline/     49 files, one per session id that ever rendered
 *   *.tmp orphans        79 files, oldest 2026-07-07
 *
 * None of it is reachable by any code path once it ages out, and the
 * directories only ever grow. The `.tmp` files are the visible symptom of a
 * real hazard: `atomicWrite` writes a temp file and renames it, so a process
 * killed between the two steps leaves the temp behind forever. `sweepStale`
 * in registry/peers.ts filters on `.json`, so it walks straight past them.
 *
 * Three rules, and nothing else is ever touched:
 *
 *   1. `.<hex>.tmp`  — orphaned atomic-write temps, older than one hour.
 *      A live temp exists for milliseconds; an hour is not a judgement call.
 *   2. `live/statusline/<sessionId>.json` — older than 14 days. One file per
 *      session; a session that hasn't rendered in two weeks is over.
 *   3. `inbox/<peer>/done/*.json` — older than 30 days. ARCHIVED messages
 *      only. `pending/` is never swept at any age.
 *
 * `pending/` exclusion is not a default, it is an invariant — an unread
 * message must never expire, however old. The tests assert it directly.
 *
 * Retention is configurable because 30 days is our guess about someone
 * else's data, not a fact about it:
 *
 *   CLAUDE_BRIDGE_HYGIENE=off              disable the sweep entirely
 *   CLAUDE_BRIDGE_RETAIN_DONE_DAYS=90      archived-message retention
 *   CLAUDE_BRIDGE_RETAIN_STATUSLINE_DAYS=30
 *
 * Concurrency: every MCP server runs this at startup, and this machine runs
 * 23 of them. A marker file (`.hygiene-last`) is touched BEFORE the sweep,
 * not after, so peers 2..23 see a fresh marker and skip. The check-then-touch
 * window is a few milliseconds; if two sweeps do overlap, both use `unlink`
 * with the error swallowed, so the loser simply removes nothing.
 */

const log = makeLogger("hygiene");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_TMP_MAX_AGE_MS = HOUR_MS;
export const DEFAULT_STATUSLINE_MAX_AGE_MS = 14 * DAY_MS;
export const DEFAULT_DONE_MAX_AGE_MS = 30 * DAY_MS;
export const DEFAULT_THROTTLE_MS = 6 * HOUR_MS;

/** Depth cap so a symlink loop or a surprise nested tree can't spin forever. */
const MAX_DEPTH = 6;

const TMP_PATTERN = /^\..+\.tmp$/;

export interface HygieneOptions {
  /** Override the workspace root (tests). */
  baseDir?: string;
  /** Clock injection (tests). */
  now?: number;
  tmpMaxAgeMs?: number;
  statusLineMaxAgeMs?: number;
  doneMaxAgeMs?: number;
  throttleMs?: number;
  /** Ignore the throttle marker — for tests and explicit manual runs. */
  force?: boolean;
  /**
   * Count what would go, delete nothing, touch no marker. Exists so the
   * numbers can be shown to whoever owns the data BEFORE an upgrade starts
   * removing it — "12 649 archived messages, 3.1 MB" is a decision someone
   * should get to make, not discover afterwards.
   */
  dryRun?: boolean;
}

export interface HygieneReport {
  ran: boolean;
  skipped?: "throttled" | "disabled";
  tmpRemoved: number;
  statusLineRemoved: number;
  doneRemoved: number;
  bytesFreed: number;
  errors: number;
  durationMs: number;
}

function envDays(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    log.warn("hygiene_bad_retention_env", { name, raw });
    return fallbackMs;
  }
  return days * DAY_MS;
}

function markerPath(baseDir: string): string {
  return join(baseDir, ".hygiene-last");
}

/**
 * Claim the sweep for this process. Touches the marker BEFORE any work so
 * concurrent starters back off. Returns false when someone swept recently.
 */
async function claim(baseDir: string, now: number, throttleMs: number): Promise<boolean> {
  const path = markerPath(baseDir);
  try {
    const s = await stat(path);
    if (now - s.mtimeMs < throttleMs) return false;
  } catch {
    // no marker yet — first run on this machine
  }
  try {
    await writeFile(path, `${new Date(now).toISOString()}\n`);
    // Honour an injected clock so tests don't depend on wall time.
    const asDate = new Date(now);
    await utimes(path, asDate, asDate).catch(() => undefined);
  } catch (e) {
    log.warn("hygiene_marker_write_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    // Sweeping without a marker risks every peer sweeping at once. Don't.
    return false;
  }
  return true;
}

/** What rule, if any, applies to this file. `null` means: leave it alone. */
function classify(relativeParts: string[], name: string): "tmp" | "statusline" | "done" | null {
  if (TMP_PATTERN.test(name)) return "tmp";
  if (!name.endsWith(".json")) return null;

  // live/statusline/<sessionId>.json
  if (
    relativeParts.length === 2 &&
    relativeParts[0] === "live" &&
    relativeParts[1] === "statusline"
  ) {
    return "statusline";
  }
  // inbox/<peerId>/done/<msgId>.json — and ONLY done/. Never pending/.
  if (relativeParts.length === 3 && relativeParts[0] === "inbox" && relativeParts[2] === "done") {
    return "done";
  }
  return null;
}

/**
 * Walk the workspace once and apply all three rules in the same pass. One
 * walk rather than three because the `done/` rule already has to visit every
 * directory that the other two live in.
 */
export async function runHygieneSweep(opts: HygieneOptions = {}): Promise<HygieneReport> {
  const started = Date.now();
  const baseDir = opts.baseDir ?? bridgeRoot();
  const now = opts.now ?? Date.now();

  const report: HygieneReport = {
    ran: false,
    tmpRemoved: 0,
    statusLineRemoved: 0,
    doneRemoved: 0,
    bytesFreed: 0,
    errors: 0,
    durationMs: 0,
  };

  if (process.env["CLAUDE_BRIDGE_HYGIENE"] === "off") {
    report.skipped = "disabled";
    report.durationMs = Date.now() - started;
    return report;
  }

  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  // A dry run must not claim the sweep — otherwise looking at the numbers
  // would suppress the real sweep for the next 6 hours.
  if (!opts.dryRun && !opts.force && !(await claim(baseDir, now, throttleMs))) {
    report.skipped = "throttled";
    report.durationMs = Date.now() - started;
    return report;
  }

  const maxAge = {
    tmp: opts.tmpMaxAgeMs ?? DEFAULT_TMP_MAX_AGE_MS,
    statusline:
      opts.statusLineMaxAgeMs ??
      envDays("CLAUDE_BRIDGE_RETAIN_STATUSLINE_DAYS", DEFAULT_STATUSLINE_MAX_AGE_MS),
    done: opts.doneMaxAgeMs ?? envDays("CLAUDE_BRIDGE_RETAIN_DONE_DAYS", DEFAULT_DONE_MAX_AGE_MS),
  } as const;

  async function walk(dir: string, parts: string[]): Promise<void> {
    if (parts.length > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // vanished or unreadable — not our problem to solve here
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // Never follow symlinks: a link into the user's home would put deletes
      // somewhere we never agreed to touch.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, [...parts, entry.name]);
        continue;
      }
      if (!entry.isFile()) continue;

      const rule = classify(parts, entry.name);
      if (!rule) continue;

      try {
        const s = await stat(full);
        if (now - s.mtimeMs <= maxAge[rule]) continue;
        if (!opts.dryRun) await unlink(full);
        report.bytesFreed += s.size;
        if (rule === "tmp") report.tmpRemoved++;
        else if (rule === "statusline") report.statusLineRemoved++;
        else report.doneRemoved++;
      } catch {
        report.errors++;
      }
    }
  }

  await walk(baseDir, []);

  report.ran = true;
  report.durationMs = Date.now() - started;

  const removed = report.tmpRemoved + report.statusLineRemoved + report.doneRemoved;
  if (removed > 0 || report.errors > 0) {
    log.info("hygiene_sweep", {
      tmpRemoved: report.tmpRemoved,
      statusLineRemoved: report.statusLineRemoved,
      doneRemoved: report.doneRemoved,
      mbFreed: Math.round((report.bytesFreed / 1024 / 1024) * 10) / 10,
      errors: report.errors,
      durationMs: report.durationMs,
    });
  }
  return report;
}

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bridgeRoot } from "@claude-bridge/shared";

/**
 * Which bundle is the CALLER running? (v0.11.53)
 *
 * The request envelope carries `requestedBy: { sessionId, name }` and nothing
 * about the caller's code. That gap produced a dead end on 2026-09-12: the
 * daemon, on refusing a below-threshold compact, advised "repeat with
 * belowThreshold:true" — but the parameter reached the daemon through the
 * caller's own MCP schema, and a session on a bundle older than 0.11.48 has no
 * such field. The advice named a door the reader could not open, and prose in
 * `reason` is not parsed, so there was no way through at all from that session.
 * Same class as the external-sender footer: a hint that cannot be acted on is
 * worse than none, because it costs a round trip to discover.
 *
 * The version is not asked for — it is READ from the peer's own heartbeat,
 * which every bundle since 0.9 writes under `~/.claude-bridge/status/`. Absent
 * file, unreadable JSON, missing field: `null`, which callers must treat as
 * "cannot say", never as "old".
 */
export async function callerBundleVersion(sessionId: string): Promise<string | null> {
  const path = join(bridgeRoot(), "status", `${sessionId}.json`);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(await readFile(path, "utf-8")) as { version?: unknown };
    return typeof doc.version === "string" ? doc.version : null;
  } catch {
    return null;
  }
}

/** Is `version` at least `minimum`? `null`/unparseable → `null` (cannot say). */
export function atLeast(version: string | null, minimum: string): boolean | null {
  if (version === null) return null;
  const parse = (v: string): number[] | null => {
    const parts = v.split(".").map((p) => Number.parseInt(p, 10));
    return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? parts : null;
  };
  const a = parse(version);
  const b = parse(minimum);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Advice about a parameter, told so the reader can act on it.
 *
 * Three answers, and the third is the reason this exists: "your session cannot
 * do this" is a different instruction from "do this".
 */
export function parameterAdvice(
  callerVersion: string | null,
  since: string,
  parameter: string,
): string {
  const has = atLeast(callerVersion, since);
  if (has === true) return `repeat with ${parameter}`;
  if (has === false) {
    return `repeat with ${parameter} — BUT your session runs bundle ${callerVersion}, and that parameter arrived in ${since}: your MCP layer will refuse it as unknown before the daemon ever sees it. Restart this session to pick up the current bundle, or have a peer on ${since}+ make the call`;
  }
  return `repeat with ${parameter} (added in ${since} — if your tool rejects it as an unknown argument, your session is on an older bundle and needs a restart to use this path)`;
}

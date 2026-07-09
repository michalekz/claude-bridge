import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import {
  type StatusLineLiveEnvelope,
  type StatusLineStdinPayload,
  writeStatusLineLive,
} from "../parser/live-data.ts";
import { makeLogger } from "../util/logger.ts";

/**
 * `claude-bridge-statusline` — chained statusLine wrapper for Claude Code.
 *
 * User installs this as the `statusLine.command` in ~/.claude/settings.json:
 *
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/statusline.cjs"
 *   }
 *
 * Behavior on every CC statusLine render:
 *
 *  1. Read stdin JSON payload from CC (contains rate_limits, context_window,
 *     effort, model, version — see src/parser/live-data.ts for schema).
 *  2. Write the envelope to ~/.claude-bridge/live/statusline.json atomically.
 *  3. If CLAUDE_BRIDGE_UNDERLYING_STATUSLINE env var is set, spawn that
 *     command as subprocess, forward the same stdin JSON, and stream its
 *     stdout to our stdout. Exit with the subprocess's exit code so CC
 *     renders whatever the underlying command produced.
 *  4. If no underlying command is set, write nothing to stdout (statusLine
 *     will render as empty on CC's side; user can configure a passthrough
 *     to their real status line, e.g. benabraham's claude-code-status-line).
 *
 * Errors during step 1-2 (bad JSON, disk full) are logged to stderr but
 * MUST NOT crash the process — CC statusLine rendering is a hot path and
 * a plugin crash would degrade the user's terminal. Best-effort semantics
 * throughout.
 */

const log = makeLogger("statusline-wrapper");

async function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

interface StdinWithSession {
  payload: StatusLineStdinPayload;
  sessionId: string;
}

function extractSessionId(payload: StatusLineStdinPayload): string {
  // CC 2.1.205+ verified 2026-07-09: payload.session_id IS present on stdin
  // (contrary to what we assumed on 2026-07-07 from static-only analysis of
  // benabraham's script). This is the AUTHORITATIVE source and is essential
  // for the v0.9.1 per-session partition — without it, every peer's wrapper
  // would write into a shared file and cross-contaminate reads.
  if (payload.session_id && typeof payload.session_id === "string") {
    return payload.session_id;
  }
  // Fallback #1: env var (older CC versions may not populate session_id in
  // stdin but still expose CLAUDE_CODE_SESSION_ID to hook children).
  const fromEnv = process.env["CLAUDE_CODE_SESSION_ID"];
  if (fromEnv) return fromEnv;
  // Fallback #2: derive a stable id from cwd so different repos don't
  // overwrite each other. Multiple sessions in the same cwd collide here —
  // acceptable on truly ancient CC that provides neither signal.
  const cwd = payload.cwd ?? "unknown-cwd";
  return `unknown-${cwd.replace(/[^a-zA-Z0-9]/g, "-").slice(-40)}`;
}

async function parseStdin(): Promise<StdinWithSession | null> {
  let raw: string;
  try {
    raw = await readAllStdin();
  } catch (e) {
    log.warn("statusline_stdin_read_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  if (!raw.trim()) return null;
  try {
    const payload = JSON.parse(raw) as StatusLineStdinPayload;
    if (typeof payload !== "object" || payload === null) return null;
    return { payload, sessionId: extractSessionId(payload) };
  } catch (e) {
    log.warn("statusline_stdin_parse_failed", {
      err: e instanceof Error ? e.message : String(e),
      preview: raw.slice(0, 200),
    });
    return null;
  }
}

async function captureLive(parsed: StdinWithSession): Promise<void> {
  const envelope: StatusLineLiveEnvelope = {
    capturedAt: new Date().toISOString(),
    sessionId: parsed.sessionId,
    payload: parsed.payload,
  };
  try {
    await writeStatusLineLive(envelope);
  } catch (e) {
    log.warn("statusline_live_write_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Spawn the user's underlying statusLine command as a subprocess and pipe
 * the original stdin JSON through. Stream its stdout back to our stdout so
 * CC sees exactly what the user's command would have produced if it were
 * invoked directly. Return the subprocess exit code (0 on any error path
 * so we don't accidentally break CC's rendering).
 */
async function passthrough(underlying: string, stdinRaw: string): Promise<number> {
  return new Promise((resolve) => {
    const isWin = platform() === "win32";
    // Cross-platform command handling — on Windows we go through cmd.exe to
    // support shell-like paths and env expansion; on POSIX we use /bin/sh -c
    // for the same reason. This matches how CC itself invokes statusLine.
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", underlying] : ["-c", underlying];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, args, {
        stdio: ["pipe", "pipe", "inherit"],
      });
    } catch (e) {
      log.warn("statusline_passthrough_spawn_failed", {
        underlying,
        err: e instanceof Error ? e.message : String(e),
      });
      resolve(0);
      return;
    }

    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    child.on("error", (e) => {
      log.warn("statusline_passthrough_child_error", {
        underlying,
        err: e instanceof Error ? e.message : String(e),
      });
      resolve(0);
    });
    child.on("exit", (code) => {
      resolve(code ?? 0);
    });

    try {
      child.stdin?.write(stdinRaw);
      child.stdin?.end();
    } catch (e) {
      log.warn("statusline_passthrough_stdin_write_failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

export async function main(): Promise<number> {
  const stdinRaw = await readAllStdin();
  if (!stdinRaw.trim()) {
    // No stdin — probably manual invocation for testing. Emit a tiny help
    // string so users who run this directly get a hint.
    process.stderr.write(
      "claude-bridge-statusline: expected JSON on stdin from Claude Code.\n" +
        "See docs/SETUP-LIVE-DATA.md for install instructions.\n",
    );
    return 0;
  }

  // Parse — even if this fails we still passthrough (best-effort).
  let parsed: StatusLineStdinPayload | null = null;
  let sessionId = "unknown";
  try {
    const p = JSON.parse(stdinRaw) as StatusLineStdinPayload;
    if (typeof p === "object" && p !== null) {
      parsed = p;
      sessionId = extractSessionId(p);
    }
  } catch (e) {
    log.warn("statusline_parse_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // Capture (best-effort — don't await if we're about to spawn a subprocess,
  // parallelize write with subprocess start for lower latency).
  const capturePromise = parsed ? captureLive({ payload: parsed, sessionId }) : Promise.resolve();

  const underlying = process.env["CLAUDE_BRIDGE_UNDERLYING_STATUSLINE"];
  let exitCode = 0;

  if (underlying) {
    exitCode = await passthrough(underlying, stdinRaw);
  }
  // If no underlying command, output nothing — CC renders an empty status
  // line. User can add their own via CLAUDE_BRIDGE_UNDERLYING_STATUSLINE.

  await capturePromise;
  return exitCode;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      log.error("statusline_wrapper_fatal", {
        err: e instanceof Error ? e.message : String(e),
      });
      process.exit(0); // never break CC rendering
    },
  );
}

// Unused imports guard for tree-shaking edge cases.
export type { StatusLineLiveEnvelope, StatusLineStdinPayload };
void readFile;

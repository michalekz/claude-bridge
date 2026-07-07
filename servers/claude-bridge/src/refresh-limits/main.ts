import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type OAuthApiLiveEnvelope, liveDir, writeOAuthApiLive } from "../parser/live-data.ts";
import { isTokenSafeForHeader, readOAuthToken } from "../parser/oauth-token.ts";
import { makeLogger } from "../util/logger.ts";

/**
 * `claude-bridge-refresh-limits` — PostToolUse hook that keeps
 * `~/.claude-bridge/live/oauth-api.json` fresh as a secondary rate-limits
 * source (v0.9.0-beta+).
 *
 * Wiring: user (or setup-check hook in v0.9.0-rc) adds this to
 * ~/.claude/settings.json under hooks.PostToolUse:
 *
 *   {
 *     "hooks": {
 *       "PostToolUse": [{
 *         "matcher": ".*",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/refresh-limits.cjs",
 *           "timeout": 6
 *         }]
 *       }]
 *     }
 *   }
 *
 * Behavior on every PostToolUse fire:
 *  1. Throttle check — skip if last successful refresh < THROTTLE_SECONDS ago
 *     (persisted via `~/.claude-bridge/live/last-oauth-refresh` mtime).
 *  2. Read OAuth token via readOAuthToken() (Keychain on darwin, fallback
 *     ~/.claude/.credentials.json elsewhere).
 *  3. Validate token character set (paranoid — prevents header injection
 *     from a corrupted credentials file).
 *  4. Curl `https://api.anthropic.com/api/oauth/usage` via subprocess with
 *     `--config` stdin so the token never appears on the command line.
 *  5. Parse response, write to `~/.claude-bridge/live/oauth-api.json` via
 *     atomicWrite.
 *  6. Touch throttle marker.
 *
 * Never crashes — PostToolUse hooks are non-blocking side channels, an
 * exception here would just log to stderr. All failure modes exit 0.
 *
 * Why: statusLine capture is the primary live source, but a session might
 * go many minutes without a statusLine render (e.g. user idle, or CC
 * version < 2.1.80 that doesn't send rate_limits on stdin). PostToolUse
 * fires on every tool call — highly correlated with agent activity — so
 * it's a reliable fallback refresh trigger.
 */

const log = makeLogger("refresh-limits");

const THROTTLE_SECONDS = 60;
const OAUTH_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT = "claude-bridge/0.9.0-alpha";
const BETA_HEADER = "anthropic-beta: oauth-2025-04-20";
const CURL_TIMEOUT_SECONDS = 5;

function throttleMarkerPath(): string {
  return join(liveDir(), "last-oauth-refresh");
}

/**
 * Check if the last successful refresh was too recent. Returns true if we
 * should skip this call.
 */
async function shouldThrottle(now: Date = new Date()): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(throttleMarkerPath());
    const ageSeconds = (now.getTime() - s.mtimeMs) / 1000;
    return ageSeconds < THROTTLE_SECONDS;
  } catch {
    return false;
  }
}

async function touchThrottleMarker(): Promise<void> {
  const path = throttleMarkerPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${new Date().toISOString()}\n`);
}

/**
 * Call the OAuth usage endpoint via curl subprocess. Token passed via
 * `--config` stdin so it doesn't appear in `ps` (same technique as
 * benabraham status-line line 700-722).
 *
 * Returns parsed JSON on success, null on any failure (timeout, non-2xx,
 * malformed response).
 */
async function fetchUsageViaCurl(token: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "curl",
        [
          "-s",
          "-f",
          "--config",
          "-",
          "-H",
          "Accept: application/json",
          "-H",
          "Content-Type: application/json",
          "-H",
          `User-Agent: ${USER_AGENT}`,
          "-H",
          BETA_HEADER,
          "--max-time",
          String(CURL_TIMEOUT_SECONDS),
          OAUTH_ENDPOINT,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (e) {
      log.warn("refresh_limits_curl_spawn_failed", {
        err: e instanceof Error ? e.message : String(e),
      });
      resolve(null);
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      if (code !== 0) {
        log.warn("refresh_limits_curl_nonzero", {
          exitCode: code,
          stderr: stderrBuf.slice(0, 200),
        });
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdoutBuf);
        resolve(parsed);
      } catch (e) {
        log.warn("refresh_limits_response_parse_failed", {
          err: e instanceof Error ? e.message : String(e),
        });
        resolve(null);
      }
    });

    // Write curl --config file to stdin, containing only the Authorization
    // header. This keeps the token out of the command line (visible to `ps`)
    // and out of environment variables (visible via /proc/<pid>/environ).
    try {
      child.stdin?.write(`header = "Authorization: Bearer ${token}"\n`);
      child.stdin?.end();
    } catch (e) {
      log.warn("refresh_limits_stdin_write_failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

/**
 * PostToolUse hook stdin payload. Ignored — we don't need to inspect the
 * tool call to decide whether to refresh (throttle is time-based).
 * Reading and discarding stdin prevents EPIPE if CC pipes payload in.
 */
async function drainStdin(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.on("data", () => undefined);
    process.stdin.on("end", () => resolve());
    process.stdin.on("error", () => resolve());
    // If stdin has nothing to read (e.g. manual invocation), 'end' fires
    // immediately once we start listening.
  });
}

export async function main(): Promise<number> {
  // Fire-and-forget stdin drain (best-effort).
  const stdinDrained = drainStdin();

  if (await shouldThrottle()) {
    await stdinDrained;
    return 0;
  }

  const token = await readOAuthToken();
  if (!token) {
    log.warn("refresh_limits_no_token");
    await stdinDrained;
    return 0;
  }
  if (!isTokenSafeForHeader(token)) {
    log.warn("refresh_limits_token_unsafe_chars");
    await stdinDrained;
    return 0;
  }

  const data = await fetchUsageViaCurl(token);
  if (data === null) {
    // Don't touch throttle marker on failure — retry sooner next PostToolUse.
    await stdinDrained;
    return 0;
  }

  const envelope: OAuthApiLiveEnvelope = {
    capturedAt: new Date().toISOString(),
    data,
  };
  try {
    await writeOAuthApiLive(envelope);
    await touchThrottleMarker();
  } catch (e) {
    log.warn("refresh_limits_write_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  await stdinDrained;
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      log.error("refresh_limits_fatal", {
        err: e instanceof Error ? e.message : String(e),
      });
      process.exit(0); // hook must never break CC tool call
    },
  );
}

// Static import guard: keep readFile referenced so bundlers don't drop
// oauth-token.ts helpers via tree-shaking edge cases.
void readFile;

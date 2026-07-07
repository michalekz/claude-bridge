import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeHome } from "../util/paths.ts";

/**
 * OAuth token reader — extracts Claude Code's access token for talking to
 * the `/api/oauth/usage` endpoint (v0.9.0-beta+).
 *
 * Token sources (in order):
 *  1. macOS Keychain — `security find-generic-password -s "Claude Code-credentials" -w`
 *     Preferred on darwin since Claude Code stores tokens there (see benabraham
 *     source line 645-664 for the reference pattern).
 *  2. `~/.claude/.credentials.json` — plain JSON file with 600 permissions,
 *     structure `{claudeAiOauth: {accessToken, refreshToken, expiresAt, ...}}`.
 *     Used on Linux/Windows and as macOS fallback if Keychain read fails.
 *
 * Returns null on any failure (missing file, permission denied, malformed
 * JSON, empty token). Callers should degrade gracefully — an OAuth-less
 * plugin still delivers live data via the statusLine chain.
 *
 * Deprecated endpoint warning: the `/api/oauth/usage` endpoint is documented
 * by benabraham/claude-code-status-line as deprecated (kept as fallback for
 * CC < 2.1.80). This token reader is only used by the PostToolUse hook as
 * a secondary rate_limits source when the statusLine capture is stale or
 * absent. When Anthropic retires the endpoint entirely, this whole path
 * shuts down cleanly — statusLine remains the primary source of truth.
 */

interface Credentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

export function credentialsPath(): string {
  return join(claudeHome(), ".credentials.json");
}

async function readTokenFromFile(): Promise<string | null> {
  try {
    const raw = await readFile(credentialsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Credentials;
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || token.length === 0) return null;
    return token;
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);

async function readTokenFromKeychain(): Promise<string | null> {
  try {
    // 5s timeout — Keychain can hang on a locked keychain (rare but real).
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5_000, encoding: "utf-8" },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as Credentials;
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || token.length === 0) return null;
    return token;
  } catch {
    return null;
  }
}

/**
 * Read the OAuth access token. Tries platform-appropriate sources; returns
 * null if none succeed. Never throws — best-effort read.
 */
export async function readOAuthToken(): Promise<string | null> {
  if (platform() === "darwin") {
    const fromKeychain = await readTokenFromKeychain();
    if (fromKeychain) return fromKeychain;
  }
  return readTokenFromFile();
}

/**
 * Validate that a token string only contains characters safe for HTTP
 * header inclusion. Prevents injection if a corrupted credentials file
 * somehow contained control characters. Same policy as benabraham
 * (`c.isalnum() or c in "-._~+/="`, line 696 of their source).
 */
export function isTokenSafeForHeader(token: string): boolean {
  return /^[a-zA-Z0-9\-._~+/=]+$/.test(token);
}

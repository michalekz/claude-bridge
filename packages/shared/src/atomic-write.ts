import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Atomic file write using temp + rename.
 *
 * POSIX rename(2) is atomic on the same filesystem. On Windows, rename can
 * fail with EBUSY (AV scanning) or EPERM (file locked) — retried with
 * exponential backoff.
 */

export interface AtomicWriteOptions {
  retries?: number;
  retryDelayMs?: number;
  encoding?: BufferEncoding;
  ensureDir?: boolean;
}

const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 50;
const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EEXIST"]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && RETRYABLE_CODES.has(code);
}

function tempPath(targetPath: string): string {
  const dir = dirname(targetPath);
  const suffix = randomBytes(8).toString("hex");
  return join(dir, `.${suffix}.tmp`);
}

/**
 * Under a test runner, refuse to write anywhere but a temp directory.
 *
 * On 2026-08-07 a new test file was written without the `vi.mock("node:os")`
 * homedir isolation every other file in that suite carries. `handleControlConfig`
 * persists through `applyStateChange` → `saveState` → `stateFilePath()`, which
 * resolves under `homedir()` — so five runs of the suite overwrote the live
 * 23-peer control-plane registry with a fixture holding one imaginary peer. The
 * fleet never noticed, because processes and tmux sessions do not depend on the
 * registry; the control plane simply lost every record it had.
 *
 * The per-file mock is the correct thing to write and was written 34 other
 * times. That is exactly why it cannot be the safeguard: a convention held by
 * memory fails the first time someone is quick, and the failure is silent and
 * lands in production. A test suite has no business writing outside a temp
 * directory, so that is now a rule rather than a habit.
 *
 * `VITEST` is set by the runner itself, so this costs nothing in production and
 * cannot be forgotten.
 */
function assertTestWritesStayInTemp(targetPath: string): void {
  if (!process.env["VITEST"]) return;
  const tmp = tmpdir();
  const resolved = resolve(targetPath);
  if (resolved.startsWith(`${tmp}/`) || resolved === tmp) return;
  throw new Error(
    `atomicWrite refused: tests may only write under ${tmp}, and this call targets ${resolved}. A test reaching outside the temp root is writing to the real machine — most likely a missing homedir mock. See the 2026-08-07 registry loss.`,
  );
}

export async function atomicWrite(
  targetPath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  assertTestWritesStayInTemp(targetPath);
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const encoding = options.encoding ?? "utf-8";
  const ensureDir = options.ensureDir ?? true;

  if (ensureDir) {
    await mkdir(dirname(targetPath), { recursive: true });
  }

  const tmp = tempPath(targetPath);

  try {
    if (typeof content === "string") {
      await writeFile(tmp, content, encoding);
    } else {
      await writeFile(tmp, content);
    }
  } catch (writeErr) {
    await unlink(tmp).catch(() => undefined);
    throw writeErr;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await rename(tmp, targetPath);
      return;
    } catch (e) {
      lastError = e;
      if (!isRetryable(e) || attempt === retries) {
        await unlink(tmp).catch(() => undefined);
        throw e;
      }
      const delay = baseDelay * 2 ** attempt;
      await sleep(delay);
    }
  }

  throw lastError;
}

export async function atomicWriteJson(
  targetPath: string,
  value: unknown,
  options?: AtomicWriteOptions,
): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  return atomicWrite(targetPath, content, options);
}

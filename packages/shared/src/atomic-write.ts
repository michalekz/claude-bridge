import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

export async function atomicWrite(
  targetPath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
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

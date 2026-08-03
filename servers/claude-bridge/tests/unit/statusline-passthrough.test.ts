import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * statusLine passthrough — EPIPE survival and the hang bound (v0.10.2).
 *
 * These run the wrapper as a real child process on purpose. The bug being
 * fixed is that `child.stdin.write()` emits 'error' ASYNCHRONOUSLY when the
 * pipe is already closed; with no listener, Node turns that into a process
 * crash. In-process the crash cannot be observed — only an exit code can
 * show it. So: real subprocess, real pipe, real exit code.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE = join(HERE, "..", "..", "src", "statusline", "main.ts");
const PKG_ROOT = join(HERE, "..", "..");

/**
 * The wrapper only self-executes under `require.main === module`, which is
 * the CJS bundle it actually ships as. Build that same artifact rather than
 * inventing a test-only entry point — otherwise the test proves something
 * about a file no user ever runs.
 */
let bundlePath: string;
let buildDir: string;

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runWrapper(
  underlying: string,
  stdinPayload: string,
  bridgeHome: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [bundlePath], {
      env: {
        ...process.env,
        HOME: bridgeHome,
        CLAUDE_BRIDGE_UNDERLYING_STATUSLINE: underlying,
        CLAUDE_BRIDGE_HYGIENE: "off",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.on("error", () => undefined); // our own pipe, not under test
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

describe("statusline passthrough", () => {
  let home: string;

  beforeAll(async () => {
    buildDir = await mkdtemp(join(tmpdir(), "cb-sl-build-"));
    bundlePath = join(buildDir, "statusline.cjs");
    await promisify(execFile)(
      "npx",
      [
        "esbuild",
        SOURCE,
        "--bundle",
        "--platform=node",
        "--target=node18",
        "--format=cjs",
        `--outfile=${bundlePath}`,
      ],
      { cwd: PKG_ROOT },
    );
  }, 120_000);

  afterAll(async () => {
    await rm(buildDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cb-sl-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("survives an underlying command that never reads stdin", async () => {
    // `echo` exits immediately without draining stdin. The payload is padded
    // past the 64 KB pipe buffer so the write is guaranteed to hit a closed
    // pipe rather than sitting in the kernel buffer unnoticed.
    const payload = JSON.stringify({
      session_id: "epipe-test",
      cwd: "/tmp",
      padding: "x".repeat(256 * 1024),
    });

    const r = await runWrapper("echo rendered-ok", payload, home);

    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("rendered-ok");
    // The specific crash this guards against.
    expect(r.stderr).not.toContain("EPIPE");
    expect(r.stderr).not.toContain("ERR_UNHANDLED_ERROR");
  }, 30_000);

  it("kills an underlying command that hangs instead of hanging with it", async () => {
    const payload = JSON.stringify({ session_id: "hang-test", cwd: "/tmp" });

    // 120 s of sleep against a 10 s bound. Before the fix this returned when
    // the sleep did; the assertion is that it does not.
    const r = await runWrapper("sleep 120", payload, home);

    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(25_000);
  }, 40_000);

  it("still captures live data when the underlying command misbehaves", async () => {
    const payload = JSON.stringify({
      session_id: "capture-test",
      cwd: "/tmp",
      context_window: { context_window_size: 200_000, used_percentage: 12 },
    });

    const r = await runWrapper("echo hi", payload, home);
    expect(r.code).toBe(0);

    const { readFile } = await import("node:fs/promises");
    const captured = JSON.parse(
      await readFile(
        join(home, ".claude-bridge", "live", "statusline", "capture-test.json"),
        "utf-8",
      ),
    );
    expect(captured.sessionId).toBe("capture-test");
    expect(captured.payload.context_window.used_percentage).toBe(12);
  }, 30_000);
});

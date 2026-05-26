import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startInboxWatcher } from "../../src/inbox/watcher.ts";
import { atomicWriteJson } from "../../src/util/atomic-write.ts";

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, pollMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await delay(pollMs);
  }
}

describe("startInboxWatcher", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "claude-bridge-watcher-"));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  // No beforeEach rm — each test uses a unique peer name so dirs don't collide
  // (recreating watched dirs across tests confuses chokidar's inotify watches).

  test("fires callback when new .json file appears", async () => {
    const peer = "peer-fires";
    const pendingDir = join(baseDir, "inbox", peer, "pending");
    await mkdir(pendingDir, { recursive: true });

    let calls = 0;
    const handle = startInboxWatcher(
      peer,
      () => {
        calls++;
      },
      { baseDir, stabilityMs: 20, pollMs: 5 },
    );
    await delay(100);

    await atomicWriteJson(join(pendingDir, "msg-1.json"), { id: "msg-1" });
    await waitFor(() => calls > 0);

    expect(calls).toBeGreaterThan(0);
    await handle.stop();
  });

  test("ignores non-json files", async () => {
    const peer = "peer-nonjson";
    const pendingDir = join(baseDir, "inbox", peer, "pending");
    await mkdir(pendingDir, { recursive: true });

    let calls = 0;
    const handle = startInboxWatcher(
      peer,
      () => {
        calls++;
      },
      { baseDir, stabilityMs: 20, pollMs: 5 },
    );
    await delay(100);

    await writeFile(join(pendingDir, "README.txt"), "hello");
    await delay(200);
    expect(calls).toBe(0);

    await handle.stop();
  });

  test("does NOT fire for files present before start (ignoreInitial)", async () => {
    const peer = "peer-initial";
    const pendingDir = join(baseDir, "inbox", peer, "pending");
    await mkdir(pendingDir, { recursive: true });
    await writeFile(join(pendingDir, "existing.json"), "{}");

    let calls = 0;
    const handle = startInboxWatcher(
      peer,
      () => {
        calls++;
      },
      { baseDir, stabilityMs: 20, pollMs: 5 },
    );
    await delay(150);

    expect(calls).toBe(0);
    await handle.stop();
  });

  test("stop() cleanly closes watcher", async () => {
    const peer = "peer-stop";
    const pendingDir = join(baseDir, "inbox", peer, "pending");
    await mkdir(pendingDir, { recursive: true });

    let calls = 0;
    const handle = startInboxWatcher(
      peer,
      () => {
        calls++;
      },
      { baseDir, stabilityMs: 20, pollMs: 5 },
    );
    await delay(100);

    await handle.stop();

    await atomicWriteJson(join(pendingDir, "post-stop.json"), { id: "x" });
    await delay(200);

    expect(calls).toBe(0);
  });

  test("callback errors do not crash watcher", async () => {
    const peer = "peer-throws";
    const pendingDir = join(baseDir, "inbox", peer, "pending");
    await mkdir(pendingDir, { recursive: true });

    let calls = 0;
    const handle = startInboxWatcher(
      peer,
      () => {
        calls++;
        throw new Error("intentional");
      },
      { baseDir, stabilityMs: 20, pollMs: 5 },
    );
    await delay(150);

    // Write 3 files with delays — chokidar coalesces rapid events, but the
    // watcher MUST stay alive between them. If the throw broke the watcher,
    // only the first event would fire.
    await atomicWriteJson(join(pendingDir, "msg-1.json"), { id: "1" });
    await delay(800);
    await atomicWriteJson(join(pendingDir, "msg-2.json"), { id: "2" });
    await delay(800);
    await atomicWriteJson(join(pendingDir, "msg-3.json"), { id: "3" });
    await delay(800);

    expect(calls).toBeGreaterThanOrEqual(2);
    await handle.stop();
  });
});

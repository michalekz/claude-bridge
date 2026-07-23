import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

async function importLock() {
  return await import("../src/lock.ts");
}

describe("daemon lock", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-lock-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it("acquires a lock when no file present", async () => {
    const { acquireLock, readLock, releaseLock } = await importLock();
    const acquired = await acquireLock();
    expect(acquired.pid).toBe(process.pid);
    expect(acquired.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const readBack = await readLock();
    expect(readBack).toEqual(acquired);
    await releaseLock();
    expect(await readLock()).toBeNull();
  });

  it("refuses when the current-pid lock is live", async () => {
    const { acquireLock, LockAcquireError, releaseLock } = await importLock();
    const first = await acquireLock();
    // Simulate a second daemon booting from the same pid record — the
    // liveness probe kill(0, self-pid) succeeds so it must refuse.
    await expect(acquireLock()).rejects.toBeInstanceOf(LockAcquireError);
    expect(first.pid).toBe(process.pid);
    await releaseLock();
  });

  it("takes over a stale lock (dead pid)", async () => {
    const { acquireLock, releaseLock } = await importLock();
    const { daemonLockPath } = await import("@claude-bridge/shared");
    // A pid that is virtually guaranteed dead — high, unassignable.
    const stalePayload = {
      pid: 999999,
      startedAt: "2020-01-01T00:00:00.000Z",
      procStart: "0",
    };
    await mkdir(dirname(daemonLockPath()), { recursive: true });
    await writeFile(daemonLockPath(), JSON.stringify(stalePayload));
    const acquired = await acquireLock();
    expect(acquired.pid).toBe(process.pid);
    const raw = await readFile(daemonLockPath(), "utf-8");
    const parsed = JSON.parse(raw) as { pid: number };
    expect(parsed.pid).toBe(process.pid);
    await releaseLock();
  });
});

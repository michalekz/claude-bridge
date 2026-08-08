import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * v0.11.11 — the post-restart wait says what it measured, and stops when it
 * knows the answer.
 *
 * The wait used to be `sleep(2500)` under a comment about giving the process
 * "time to come up". That is not what it does: coming up is already waited for
 * by `verifyRestartedIdentity`, which polls the session file for up to four
 * seconds — and a heavy peer writes that file in 0.96 s (measured 2026-08-08).
 *
 * This wait exists to catch the OTHER failure: a resume that starts, runs for
 * about two seconds and exits, which without observation is reported as
 * `restarted: ok` over a corpse.
 *
 * Two consequences the flat sleep got wrong, and both are asserted here:
 * a death at 200 ms was waited out for the full budget and then reported as
 * "exited within 2500 ms" — the budget, not the measurement; and a peer that
 * had already registered its session was held anyway, though it is past the
 * failure mode this window exists for.
 */

let procRoot: string;

beforeEach(async () => {
  procRoot = await mkdtemp(join(tmpdir(), "cbd-proc-"));
});

afterEach(async () => {
  await rm(procRoot, { recursive: true, force: true });
});

const CLAUDE = "/usr/local/bin/claude";
const RESUMABLE = "11111111-1111-4111-8111-111111111111";

describe("the survival window reports what it measured", () => {
  it("THE REGRESSION: a death at ~200 ms is reported at ~200 ms, not at the budget", async () => {
    const { confirmStillRunning } = await import("../src/handlers/peer-restart.ts");
    await mkdir(join(procRoot, "4242"));
    // The process vanishes a fifth of a second in.
    setTimeout(() => {
      rm(join(procRoot, "4242"), { recursive: true, force: true }).catch(() => undefined);
    }, 200);

    const started = Date.now();
    const res = await confirmStillRunning(4242, { mismatch: false, actual: null }, RESUMABLE, {
      settleMs: 2500,
      procRoot,
      command: CLAUDE,
    });
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    // The number in the message is a measurement now.
    expect(res.reason).toMatch(/exited \d+ ms after starting/);
    expect(res.reason).not.toContain("2500");
    // And it did not sit out the rest of the budget to say so.
    expect(elapsed).toBeLessThan(1200);
  });

  it("a peer that already registered is not held for the full window", async () => {
    // It is past the failure mode this window exists to catch. Eight peers
    // holding 2.5 s each is 20 seconds spent proving that time passes.
    const { confirmStillRunning } = await import("../src/handlers/peer-restart.ts");
    await mkdir(join(procRoot, "777"));
    const started = Date.now();
    const res = await confirmStillRunning(777, { mismatch: false, actual: RESUMABLE }, RESUMABLE, {
      settleMs: 2500,
      procRoot,
      command: CLAUDE,
    });
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it("a peer that registered NOTHING is still watched for the whole window", async () => {
    // The shortcut above must not become a shortcut past the check itself: an
    // unregistered Claude peer is exactly the case the window is for, so it
    // gets the full observation before any verdict.
    const { confirmStillRunning } = await import("../src/handlers/peer-restart.ts");
    await mkdir(join(procRoot, "888"));
    const started = Date.now();
    const res = await confirmStillRunning(888, { mismatch: false, actual: null }, RESUMABLE, {
      settleMs: 700,
      procRoot,
      command: CLAUDE,
    });
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("registered no session");
    expect(elapsed).toBeGreaterThanOrEqual(650);
  });

  it("a command that is not Claude is not asked to register", async () => {
    const { confirmStillRunning } = await import("../src/handlers/peer-restart.ts");
    await mkdir(join(procRoot, "999"));
    const res = await confirmStillRunning(999, { mismatch: false, actual: null }, RESUMABLE, {
      settleMs: 300,
      procRoot,
      command: "/bin/sh",
    });
    expect(res.ok).toBe(true);
  });

  it("no pid is still no pid", async () => {
    const { confirmStillRunning } = await import("../src/handlers/peer-restart.ts");
    const res = await confirmStillRunning(null, { mismatch: false, actual: null }, RESUMABLE, {
      procRoot,
      command: CLAUDE,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no pid");
  });
});

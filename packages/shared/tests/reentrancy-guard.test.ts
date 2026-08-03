import { describe, expect, it } from "vitest";
import { guardReentrancy, isPowerOfTwo } from "../src/reentrancy-guard.ts";

/** Resolve-on-demand promise, so a test can hold a run open deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("guardReentrancy", () => {
  it("drops overlapping calls instead of queueing them", async () => {
    const gate = deferred();
    let started = 0;
    let finished = 0;
    const guarded = guardReentrancy(async () => {
      started++;
      await gate.promise;
      finished++;
    });

    // First call starts and parks on the gate.
    const first = guarded();
    expect(guarded.busy()).toBe(true);
    expect(started).toBe(1);

    // Simulate 480 poll ticks landing while the first run is still going —
    // the pile-up a 120 s team_stop would have produced at 250 ms.
    for (let i = 0; i < 480; i++) await guarded();
    expect(started).toBe(1);
    expect(guarded.skipped()).toBe(480);

    gate.resolve();
    await first;
    expect(finished).toBe(1);
    expect(guarded.busy()).toBe(false);
    expect(guarded.skipped()).toBe(0);
  });

  it("runs again once the previous run settles", async () => {
    let runs = 0;
    const guarded = guardReentrancy(async () => {
      runs++;
    });
    await guarded();
    await guarded();
    await guarded();
    expect(runs).toBe(3);
  });

  it("clears the in-flight flag when fn throws, and never rejects", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const guarded = guardReentrancy(
      async () => {
        calls++;
        throw new Error(`boom ${calls}`);
      },
      { onError: (e) => errors.push(e) },
    );

    // Must not reject — this is handed straight to setInterval.
    await expect(guarded()).resolves.toBeUndefined();
    expect(guarded.busy()).toBe(false);
    // A throw must not wedge the guard permanently.
    await guarded();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
  });

  it("reports consecutive skips to onSkip and resets after completion", async () => {
    const gate = deferred();
    const skips: number[] = [];
    const guarded = guardReentrancy(
      async () => {
        await gate.promise;
      },
      { onSkip: (n) => skips.push(n) },
    );

    const first = guarded();
    await guarded();
    await guarded();
    await guarded();
    expect(skips).toEqual([1, 2, 3]);

    gate.resolve();
    await first;
    expect(guarded.skipped()).toBe(0);
  });
});

describe("isPowerOfTwo", () => {
  it("is true exactly on 1, 2, 4, 8, 16…", () => {
    expect([1, 2, 4, 8, 16, 32, 1024].every(isPowerOfTwo)).toBe(true);
    expect([0, -1, 3, 5, 6, 7, 9, 100].some(isPowerOfTwo)).toBe(false);
  });
});

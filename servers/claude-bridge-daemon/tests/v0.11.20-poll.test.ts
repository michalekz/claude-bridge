import { describe, expect, it } from "vitest";
import { pollUntil } from "../src/poll.ts";

/**
 * R5 — one wait loop, and the invariant it exists to enforce.
 *
 * Three times in this campaign a handler reported its BUDGET as though it were
 * a measurement: 2500 ms for something ready in 960 (v0.11.11), 5000 ms spent
 * on an identity that could not exist (v0.11.16), and a settle window over
 * nothing. Each said a number that was a decision and read like an observation.
 *
 * So `waitedMs` and `timeoutMs` are separate fields, and the tests below are
 * about that separation rather than about the loop mechanics.
 */

describe("pollUntil — the measurement is never the budget", () => {
  it("a hit reports the time it actually took, not the ceiling", async () => {
    let n = 0;
    const r = await pollUntil(() => (++n >= 3 ? "ready" : null), {
      timeoutMs: 60_000,
      pollMs: 10,
    });
    expect(r.kind).toBe("hit");
    // Three probes at 10 ms — nowhere near the minute it was allowed. A budget
    // reported here would be off by three orders of magnitude and still look
    // like a plausible duration, which is exactly why this is easy to miss.
    expect(r.waitedMs).toBeLessThan(1_000);
    expect(r.attempts).toBe(3);
  });

  it("an expiry reports BOTH — measured and allowed, side by side", async () => {
    const r = await pollUntil(() => null, { timeoutMs: 120, pollMs: 20 });
    expect(r.kind).toBe("expired");
    if (r.kind !== "expired") return;
    expect(r.timeoutMs).toBe(120);
    // Measured, and it may exceed the budget slightly — a probe takes time.
    // What it must NOT do is come back as a round 120 that was never observed.
    expect(r.waitedMs).toBeGreaterThanOrEqual(100);
  });

  it("it does not sleep past its own deadline", async () => {
    // A poll whose interval is longer than its budget used to overshoot by most
    // of an interval and then report a wait it was never allowed to take — the
    // measurement disagreeing with the contract.
    const r = await pollUntil(() => null, { timeoutMs: 50, pollMs: 5_000 });
    expect(r.waitedMs).toBeLessThan(1_000);
  });
});

describe("pollUntil — three outcomes, because callers mean different things", () => {
  it("abort is NOT a timeout: 'it cannot happen' ≠ 'it is taking long'", async () => {
    let alive = true;
    setTimeout(() => {
      alive = false;
    }, 30);
    const r = await pollUntil(() => null, {
      timeoutMs: 10_000,
      pollMs: 10,
      abort: () => (alive ? { aborted: false } : { aborted: true, reason: "pane-pid-gone" }),
    });
    expect(r.kind).toBe("aborted");
    if (r.kind !== "aborted") return;
    expect(r.reason).toBe("pane-pid-gone");
    // The point: it did not spend the ten seconds it was allowed. Reporting a
    // timeout here would hide a death inside a budget — and when this check was
    // missing from the identity measurement, the test suite went from 42 s to
    // 262 s because every mock spawn waited out a ceiling for nothing.
    expect(r.waitedMs).toBeLessThan(1_000);
  });

  it("THE INVERTED CALLER: expiry is the success case for a survival watch", async () => {
    // `confirmStillRunning` waits to see whether a process DIES. For it,
    // `expired` means the peer survived and `aborted` means it did not — which
    // is why the outcomes are named after what happened rather than after
    // success and failure.
    const survived = await pollUntil(() => null, {
      timeoutMs: 60,
      pollMs: 10,
      abort: () => ({ aborted: false }),
    });
    expect(survived.kind).toBe("expired");

    let alive = true;
    setTimeout(() => {
      alive = false;
    }, 20);
    const died = await pollUntil(() => null, {
      timeoutMs: 60_000,
      pollMs: 5,
      abort: () => (alive ? { aborted: false } : { aborted: true, reason: "exited" }),
    });
    expect(died.kind).toBe("aborted");
  });

  it("abort is not consulted before the first probe", async () => {
    // Otherwise a condition that is already false would refuse to look even
    // once — and the first look is the cheapest evidence there is.
    let probes = 0;
    const r = await pollUntil(
      () => {
        probes++;
        return "found";
      },
      { timeoutMs: 1_000, pollMs: 10, abort: () => ({ aborted: true, reason: "never" }) },
    );
    expect(probes).toBe(1);
    expect(r.kind).toBe("hit");
  });
});

describe("pollUntil — bounded by attempts instead of time", () => {
  it("maxAttempts stops the loop and still reports the measured wait", async () => {
    let n = 0;
    const r = await pollUntil(
      () => {
        n++;
        return null;
      },
      { timeoutMs: 60_000, pollMs: 5, maxAttempts: 4 },
    );
    expect(n).toBe(4);
    expect(r.kind).toBe("expired");
    expect(r.waitedMs).toBeLessThan(1_000);
  });
});

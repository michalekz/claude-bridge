/**
 * One waiting loop, for the places that are actually waiting FOR something.
 *
 * R5 in the lifecycle plan asks for "one wait loop for all seven places". The
 * measurement that preceded this file found ten `setTimeout` sites, and they are
 * not seven of a kind — they are two kinds, and merging them would repeat the
 * defect the rule exists to prevent:
 *
 *   POLLS (six sites, this module). Something in the world will become true, and
 *   the loop asks repeatedly until it does or the budget runs out. Here the
 *   criterion applies: report the MEASURED time, never the budget.
 *
 *   SPACING (four sites, deliberately left alone). Nothing is being observed —
 *   the pause IS the point. `team_restart`'s gap between peers keeps a rolling
 *   restart from becoming a simultaneous one; `wake`'s 8 s is the window in
 *   which a booting Claude Code silently drops keys; the driver's send-verify
 *   delay lets the pane redraw before it is read. Wrapping those in a poll would
 *   dress a deliberate pause as a measurement of something.
 *
 * THE ONE INVARIANT: `waitedMs` is measured and `timeoutMs` is the budget, and
 * they are separate fields so no caller can report one as the other by accident.
 * That mistake has been found three times in this campaign — 2.5 s reported for
 * something ready in 960 ms (v0.11.11), 5 s spent on something impossible
 * (v0.11.16), and a settle window over nothing. Every one of them said a number
 * that was a decision and read like an observation.
 */

/** What ended the wait. Three outcomes, because callers mean different things. */
export type PollOutcome<T> =
  /** The probe returned a value. */
  | { kind: "hit"; value: T; waitedMs: number; attempts: number }
  /**
   * `abort` fired — the thing we were waiting for became impossible.
   *
   * Distinct from `expired` on purpose: "the process we were waiting on died"
   * and "it is taking longer than we allowed" are different findings, and a
   * timeout reported for a death is how a boot failure hides inside a budget.
   */
  | { kind: "aborted"; reason: string; waitedMs: number; attempts: number }
  /** The budget ran out. For some callers this is the SUCCESS case — see below. */
  | { kind: "expired"; waitedMs: number; attempts: number; timeoutMs: number };

export interface PollOptions {
  /** Budget. Reported back only in `expired`, and never as `waitedMs`. */
  timeoutMs: number;
  /** Gap between probes. */
  pollMs: number;
  /**
   * Stop early, with a reason. Checked before each probe after the first.
   *
   * This is what lets a caller distinguish "not yet" from "not ever":
   * `measureIdentity` stops when the pane process is gone, because an identity
   * that cannot arrive is not worth the rest of the ceiling — and without that,
   * every mock spawn in the test suite paid the full 5 s (measured: the suite
   * went from 42 s to 262 s).
   */
  abort?: () => { aborted: false } | { aborted: true; reason: string };
  /** Optional cap on probe count, for callers bounded by attempts, not time. */
  maxAttempts?: number;
}

/**
 * Ask until it is true, it becomes impossible, or the budget is gone.
 *
 * A `null` from `probe` means "not yet". Anything else is the answer — so a
 * probe that legitimately resolves to `null` should wrap it (`{value: null}`),
 * rather than this module guessing.
 *
 * INVERTED CALLERS ARE FIRST-CLASS. `confirmStillRunning` waits to see whether a
 * process DIES: for it, `aborted` means the peer did not survive and `expired`
 * means it did. That is why the outcomes are named after what happened rather
 * than after success and failure — the same loop, read two ways, and neither
 * reading has to lie about the other.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | null> | T | null,
  opts: PollOptions,
): Promise<PollOutcome<T>> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  let attempts = 0;

  for (;;) {
    if (attempts > 0 && opts.abort) {
      const verdict = opts.abort();
      if (verdict.aborted) {
        return {
          kind: "aborted",
          reason: verdict.reason,
          waitedMs: Date.now() - started,
          attempts,
        };
      }
    }
    attempts++;
    const value = await probe();
    if (value !== null && value !== undefined) {
      return { kind: "hit", value, waitedMs: Date.now() - started, attempts };
    }
    if (opts.maxAttempts !== undefined && attempts >= opts.maxAttempts) break;
    if (Date.now() >= deadline) break;
    // Never sleep past the deadline: a poll that overshoots its own budget by
    // most of an interval reports a wait longer than it was allowed, which is
    // the measurement disagreeing with the contract.
    await new Promise((r) =>
      setTimeout(r, Math.min(opts.pollMs, Math.max(0, deadline - Date.now()))),
    );
  }
  return {
    kind: "expired",
    waitedMs: Date.now() - started,
    attempts,
    timeoutMs: opts.timeoutMs,
  };
}

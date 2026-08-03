/**
 * Re-entrancy guard for interval-driven async work (v0.10.1).
 *
 * `setInterval(() => void doWork(), N)` re-arms unconditionally. When `doWork`
 * can outlast `N`, ticks stack up — and each in-flight run pins its whole async
 * frame. Two places in this codebase were doing exactly that, both found by the
 * 2026-08-03 memory audit:
 *
 *   - the daemon's 250 ms RPC poll loop, against handlers that wait up to 120 s
 *     per peer (`team_stop`) — a 5-peer team that never acks would have stacked
 *     ~2400 overlapping drains, each with its own inbox writes and tmux children;
 *   - the MCP server's 5 s identity refresh, whose whole-file JSONL scan measured
 *     2755 ms on a 229 MB transcript — 55 % of the interval before any disk
 *     contention, so overlap was reachable in normal operation and each
 *     overlapping tick held ~1 GB.
 *
 * Wrapping the callback makes "at most one run at a time" structural rather than
 * something every call site has to remember.
 */

export interface ReentrancyGuardOptions {
  /**
   * Called when a tick is dropped because the previous run is still going.
   * `skipped` counts consecutive drops, so a caller can log on a backoff curve
   * instead of once per tick. Reset to 0 when a run completes.
   */
  onSkip?: (skipped: number) => void;
}

export interface GuardedRunner {
  /** Run unless a previous run is still in flight. Never rejects. */
  (): Promise<void>;
  /** True while a run is in flight — for diagnostics and tests. */
  readonly busy: () => boolean;
  /** Consecutive ticks dropped since the last completed run. */
  readonly skipped: () => number;
}

/**
 * Wrap an async function so overlapping invocations are dropped, not queued.
 *
 * Dropping is deliberate: these are pollers, so a skipped tick loses nothing —
 * the next one sees the same (or fresher) state. Queueing would just rebuild
 * the pile-up with extra steps.
 *
 * Errors from `fn` are swallowed after `onError`, so a guarded runner is safe
 * to hand straight to `setInterval` without a trailing `.catch`.
 */
export function guardReentrancy(
  fn: () => Promise<void>,
  options: ReentrancyGuardOptions & { onError?: (err: unknown) => void } = {},
): GuardedRunner {
  let inFlight = false;
  let skipped = 0;

  const run = async (): Promise<void> => {
    if (inFlight) {
      skipped++;
      options.onSkip?.(skipped);
      return;
    }
    inFlight = true;
    try {
      await fn();
    } catch (e) {
      options.onError?.(e);
    } finally {
      inFlight = false;
      skipped = 0;
    }
  };

  return Object.assign(run, {
    busy: () => inFlight,
    skipped: () => skipped,
  }) as GuardedRunner;
}

/**
 * True on 1, 2, 4, 8, 16… — for logging a growing condition without flooding.
 *
 * A 120 s handler drops ~480 ticks of a 250 ms poller; logging each one buries
 * the journal, logging none hides the stall. Powers of two give ~9 lines.
 */
export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

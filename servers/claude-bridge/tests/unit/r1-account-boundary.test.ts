/**
 * R-1 — one answer must not be built from two accounts.
 *
 * `rate_limit_status` composes utilization and reset times from the statusLine
 * capture with severity, isActive, scopedLimits and spend from the OAuth
 * capture. That was written for two captures of ONE account at two ages, and it
 * recorded the age difference faithfully.
 *
 * Account rotation introduces the case it never contemplated. The statusLine
 * render follows the live credentials file at once; the OAuth capture freezes
 * the moment the endpoint starts refusing the new token, because the hook
 * deliberately leaves the previous file in place rather than writing a gap.
 *
 * The numbers below are a REAL capture from 2026-08-09, one minute after a live
 * rotation from `oxy` to `oxy2` on a 24-peer fleet.
 */
import { describe, expect, it } from "vitest";
import {
  type RateLimitStatus,
  composeFromStatusLineAndOAuth,
} from "../../src/parser/rate-limits.ts";

/** The new account, as the statusLine reported it seconds after the rotation. */
function freshAfterRotation(): RateLimitStatus {
  return {
    hasLiveData: true,
    source: "statusline-stdin",
    capturedAt: "2026-08-09T15:56:16.207Z",
    capturedAgeSeconds: 0,
    staleness: "fresh",
    session: {
      utilization: 0,
      resetsAt: "2026-08-09T19:00:00.000Z",
      hoursUntilReset: 3.06,
      severity: "unknown",
      windowExpired: false,
    },
    week: {
      utilization: 0.46,
      resetsAt: "2026-08-14T21:00:00.000Z",
      hoursUntilReset: 125.06,
      severity: "unknown",
      windowExpired: false,
    },
  };
}

/** The old account, frozen at the moment the endpoint began refusing. */
function frozenPreviousAccount(): RateLimitStatus {
  return {
    hasLiveData: true,
    source: "oauth-api",
    capturedAt: "2026-08-09T15:54:12.963Z",
    capturedAgeSeconds: 123,
    staleness: "fresh",
    session: {
      utilization: 0.38,
      resetsAt: "2026-08-09T17:30:00.000Z",
      hoursUntilReset: 1.5,
      severity: "normal",
      windowExpired: false,
      isActive: false,
    },
    week: {
      utilization: 0.94,
      resetsAt: "2026-08-10T03:00:00.000Z",
      hoursUntilReset: 11,
      severity: "critical",
      windowExpired: false,
      isActive: false,
    },
    scopedLimits: [
      {
        kind: "weekly_scoped",
        utilization: 0.97,
        resetsAt: "2026-08-10T02:59:59.876056+00:00",
        severity: "critical",
        isActive: true,
        windowExpired: false,
        modelDisplayName: "Fable",
      },
    ],
  };
}


/** Both fixtures always set `week`; this says so to the types and to the reader. */
function withWeekResetsAt(base: RateLimitStatus, resetsAt: string): RateLimitStatus {
  const week = base.week;
  if (!week) throw new Error("fixtura bez week — test by netestoval, co tvrdí");
  return { ...base, week: { ...week, resetsAt } };
}

describe("a borrow across accounts is refused", () => {
  it("the chimera that was observed in production does not form", () => {
    const out = composeFromStatusLineAndOAuth(freshAfterRotation(), frozenPreviousAccount());
    // Before the fix this returned week.utilization 0.46 with severity
    // "critical" — a 46 % week labelled critical, and two different weekly
    // windows inside one object.
    expect(out.week?.utilization).toBe(0.46);
    expect(out.week?.severity).toBe("unknown");
    expect(out.scopedLimits).toBeUndefined();
    expect(out.source).toBe("statusline-stdin");
    expect(out.secondary).toBeUndefined();
  });

  it("the refusal is stated, not silent", () => {
    // A refusal is not a fault and must not read like one — but it must be
    // visible, or an operator cannot tell a thin answer from a full one.
    const out = composeFromStatusLineAndOAuth(freshAfterRotation(), frozenPreviousAccount());
    expect(out.secondaryRejected?.reason).toBe("different-weekly-window");
    expect(out.secondaryRejected?.freshWeekResetsAt).toBe("2026-08-14T21:00:00.000Z");
    expect(out.secondaryRejected?.olderWeekResetsAt).toBe("2026-08-10T03:00:00.000Z");
    expect(out.secondaryRejected?.capturedAgeSeconds).toBe(123);
  });
});

describe("the same account still composes", () => {
  it("sub-second skew between the two halves is not a disagreement", () => {
    // MEASURED: the statusLine capture rounds a unix timestamp and the OAuth
    // capture carries microseconds, so the same window arrives as
    // 03:00:00.000Z and 02:59:59.604Z. Comparing for equality would refuse
    // every borrow, always — the fix would have disabled the feature.
    const fresh = withWeekResetsAt(freshAfterRotation(), "2026-08-10T03:00:00.000Z");
    const older = withWeekResetsAt(frozenPreviousAccount(), "2026-08-10T02:59:59.604Z");

    const out = composeFromStatusLineAndOAuth(fresh, older);
    expect(out.source).toBe("composed");
    expect(out.week?.severity).toBe("critical");
    expect(out.scopedLimits).toHaveLength(1);
    expect(out.secondaryRejected).toBeUndefined();
  });

  it("a missing or unparseable window is not treated as evidence of anything", () => {
    // Absence is ignorance. Refusing to borrow because a field is absent would
    // punish the older captures this whole path exists to use.
    const fresh = withWeekResetsAt(freshAfterRotation(), "2026-08-10T03:00:00.000Z");
    const blank = withWeekResetsAt(frozenPreviousAccount(), "");
    expect(composeFromStatusLineAndOAuth(fresh, blank).source).toBe("composed");

    const nonsense = withWeekResetsAt(frozenPreviousAccount(), "není to datum");
    expect(composeFromStatusLineAndOAuth(fresh, nonsense).source).toBe("composed");
  });

  it("the 5-hour window is deliberately NOT the boundary", () => {
    // It rolls every few hours on the same account, so a rule built on it would
    // refuse borrows as a matter of routine — and a refusal that happens
    // constantly stops carrying information. Here the sessions disagree by
    // 90 minutes and the weeks agree: the borrow goes ahead.
    const fresh = withWeekResetsAt(freshAfterRotation(), "2026-08-10T03:00:00.000Z");
    const older = frozenPreviousAccount();
    expect(fresh.session?.resetsAt).not.toBe(older.session?.resetsAt);
    expect(composeFromStatusLineAndOAuth(fresh, older).source).toBe("composed");
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { normalizeUsageCache, readRateLimits } from "../../src/parser/rate-limits.ts";

const FIXED_NOW = new Date("2026-07-05T15:31:00Z");

/**
 * Real-world sample from an active account (2026-07-04 snapshot, 1.5 days
 * stale as of FIXED_NOW). Comes from empirical inspection of the file at
 * ~/.claude/.usage_cache.json.
 */
const REAL_SAMPLE = {
  timestamp: 1783123638.6656337, // 2026-07-04T00:07:18Z
  data: {
    five_hour: {
      utilization: 36.0,
      resets_at: "2026-07-04T03:49:59.590114+00:00",
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
    },
    seven_day: {
      utilization: 33.0,
      resets_at: "2026-07-06T02:59:59.590140+00:00",
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
    },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    seven_day_omelette: null,
    tangelo: null,
    iguana_necktie: null,
    omelette_promotional: null,
    nimbus_quill: null,
    cinder_cove: null,
    amber_ladder: null,
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
      currency: null,
      decimal_places: null,
      disabled_reason: null,
      daily: null,
      weekly: null,
    },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 36,
        severity: "normal",
        resets_at: "2026-07-04T03:49:59.590114+00:00",
        scope: null,
        is_active: true,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 33,
        severity: "normal",
        resets_at: "2026-07-06T02:59:59.590140+00:00",
        scope: null,
        is_active: false,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 11,
        severity: "normal",
        resets_at: "2026-07-06T02:59:59.590394+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
        is_active: false,
      },
    ],
    spend: {
      used: { amount_minor: 0, currency: "USD", exponent: 2 },
      limit: null,
      percent: 0,
      severity: "normal",
      enabled: false,
      disabled_reason: null,
      cap: null,
      balance: null,
      auto_reload: null,
      disclaimer: "Usage credits cover you when you hit your plan limits.",
      can_purchase_credits: false,
      can_toggle: false,
    },
    member_dashboard_available: false,
  },
};

describe("normalizeUsageCache — real-world sample", () => {
  test("hasCache = true, timestamp + age set", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.hasCache).toBe(true);
    expect(s.cacheTimestamp).toBe("2026-07-04T00:07:18.665Z");
    // 2026-07-05T15:31 − 2026-07-04T00:07 = ~140k seconds
    expect(s.cacheAgeSeconds).toBeGreaterThan(140_000);
    expect(s.cacheAgeSeconds).toBeLessThan(150_000);
  });

  test("5-hour session bucket", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.session?.utilization).toBe(0.36);
    expect(s.session?.resetsAt).toBe("2026-07-04T03:49:59.590114+00:00");
    expect(s.session?.severity).toBe("normal");
    expect(s.session?.isActive).toBe(true);
    // resets_at is in the past (cache stale) → negative hoursUntilReset
    expect(s.session?.hoursUntilReset).toBeLessThan(0);
  });

  test("7-day week bucket", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.week?.utilization).toBe(0.33);
    expect(s.week?.isActive).toBe(false);
    // resets_at is in the future
    expect(s.week?.hoursUntilReset).toBeGreaterThan(0);
    expect(s.week?.hoursUntilReset).toBeLessThan(15);
  });

  test("scopedLimits — per-model breakdown (Fable = 11%)", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.scopedLimits).toHaveLength(1);
    const fable = s.scopedLimits?.[0];
    expect(fable?.utilization).toBe(0.11);
    expect(fable?.modelDisplayName).toBe("Fable");
    expect(fable?.kind).toBe("weekly_scoped");
  });

  test("spend NOT included when enabled=false", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.spend).toBeUndefined();
  });

  test("extraUsage NOT included when is_enabled=false", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.extraUsage).toBeUndefined();
  });

  test("perModelWeekly NOT included when all null", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.perModelWeekly).toBeUndefined();
  });

  test("rawExperimental NOT included when all codenames null", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.rawExperimental).toBeUndefined();
  });
});

describe("normalizeUsageCache — spend enabled", () => {
  test("Teams/Enterprise with spend cap active", () => {
    const withSpend = {
      ...REAL_SAMPLE,
      data: {
        ...REAL_SAMPLE.data,
        spend: {
          used: { amount_minor: 12_34, currency: "USD", exponent: 2 },
          limit: 100_00,
          percent: 12,
          severity: "warning",
          enabled: true,
          disabled_reason: null,
          cap: null,
          balance: null,
          auto_reload: null,
          disclaimer: "",
          can_purchase_credits: true,
          can_toggle: true,
        },
      },
    };
    const s = normalizeUsageCache(withSpend as never, FIXED_NOW);
    expect(s.spend?.enabled).toBe(true);
    expect(s.spend?.utilization).toBe(0.12);
    expect(s.spend?.usedAmountUsd).toBe(12.34);
    expect(s.spend?.limitUsd).toBe(100.0);
    expect(s.spend?.currency).toBe("USD");
    expect(s.spend?.severity).toBe("warning");
  });
});

describe("normalizeUsageCache — extra usage enabled", () => {
  test("account with extra credits pool", () => {
    const withExtras = {
      ...REAL_SAMPLE,
      data: {
        ...REAL_SAMPLE.data,
        extra_usage: {
          is_enabled: true,
          monthly_limit: 500,
          used_credits: 123,
          utilization: 24.6,
          currency: "USD",
          decimal_places: 2,
          disabled_reason: null,
          daily: null,
          weekly: null,
        },
      },
    };
    const s = normalizeUsageCache(withExtras as never, FIXED_NOW);
    expect(s.extraUsage?.isEnabled).toBe(true);
    expect(s.extraUsage?.utilization).toBeCloseTo(0.246, 3);
    expect(s.extraUsage?.monthlyLimit).toBe(500);
    expect(s.extraUsage?.usedCredits).toBe(123);
    expect(s.extraUsage?.currency).toBe("USD");
  });
});

describe("normalizeUsageCache — per-model weekly", () => {
  test("account with per-model quotas populated", () => {
    const withPerModel = {
      ...REAL_SAMPLE,
      data: {
        ...REAL_SAMPLE.data,
        seven_day_opus: 42.5,
        seven_day_sonnet: 18.0,
        seven_day_oauth_apps: 5.2,
      },
    };
    const s = normalizeUsageCache(withPerModel as never, FIXED_NOW);
    expect(s.perModelWeekly).toEqual({ opus: 42.5, sonnet: 18.0, oauthApps: 5.2 });
  });
});

describe("normalizeUsageCache — codenames passthrough", () => {
  test("non-null experimental keys surface as rawExperimental", () => {
    const withExperiments = {
      ...REAL_SAMPLE,
      data: {
        ...REAL_SAMPLE.data,
        tangelo: { hidden_feature: true, quota: 100 },
        cinder_cove: 42,
      },
    };
    const s = normalizeUsageCache(withExperiments as never, FIXED_NOW);
    expect(s.rawExperimental).toEqual({
      tangelo: { hidden_feature: true, quota: 100 },
      cinder_cove: 42,
    });
  });
});

describe("normalizeUsageCache — v0.8.2 staleness detection", () => {
  // REAL_SAMPLE at FIXED_NOW (2026-07-05T15:31Z):
  //   - session resets_at 2026-07-04T03:49 (past → windowExpired=true)
  //   - week resets_at 2026-07-06T02:59 (future → windowExpired=false)
  //   - cacheAgeSeconds ~140k
  test("session bucket has windowExpired=true when resets_at in past", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.session?.windowExpired).toBe(true);
  });

  test("week bucket has windowExpired=false when resets_at in future", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    expect(s.week?.windowExpired).toBe(false);
  });

  test("scopedLimits get windowExpired flag too", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    // The Fable scoped limit in the fixture has resets_at in the future,
    // so windowExpired=false.
    expect(s.scopedLimits?.[0]?.windowExpired).toBe(false);
  });

  test("staleness='expired-window' when any bucket has windowExpired=true", () => {
    const s = normalizeUsageCache(REAL_SAMPLE as never, FIXED_NOW);
    // REAL_SAMPLE session bucket expired → staleness='expired-window'
    expect(s.staleness).toBe("expired-window");
  });

  test("staleness='fresh' when cache < 5 min old AND all windows current", () => {
    // Rebuild sample with timestamps relative to a controlled "now".
    const now = new Date("2026-07-05T15:31:00Z");
    const fresh = {
      timestamp: (now.getTime() - 60_000) / 1000, // 60 sec ago
      data: {
        ...REAL_SAMPLE.data,
        five_hour: {
          ...REAL_SAMPLE.data.five_hour,
          resets_at: "2026-07-05T17:00:00Z", // future
        },
        seven_day: {
          ...REAL_SAMPLE.data.seven_day,
          resets_at: "2026-07-06T02:59:59Z", // future
        },
        limits: REAL_SAMPLE.data.limits.map((l) => ({
          ...l,
          resets_at: l.kind === "session" ? "2026-07-05T17:00:00Z" : "2026-07-06T02:59:59Z",
        })),
      },
    };
    const s = normalizeUsageCache(fresh as never, now);
    expect(s.cacheAgeSeconds).toBeLessThan(300);
    expect(s.session?.windowExpired).toBe(false);
    expect(s.week?.windowExpired).toBe(false);
    expect(s.staleness).toBe("fresh");
  });

  test("staleness='stale' when cache old but windows current", () => {
    const now = new Date("2026-07-05T15:31:00Z");
    const stale = {
      timestamp: (now.getTime() - 3_600_000) / 1000, // 1 hour ago
      data: {
        ...REAL_SAMPLE.data,
        five_hour: {
          ...REAL_SAMPLE.data.five_hour,
          resets_at: "2026-07-05T17:00:00Z", // future
        },
        seven_day: {
          ...REAL_SAMPLE.data.seven_day,
          resets_at: "2026-07-06T02:59:59Z", // future
        },
        limits: REAL_SAMPLE.data.limits.map((l) => ({
          ...l,
          resets_at: l.kind === "session" ? "2026-07-05T17:00:00Z" : "2026-07-06T02:59:59Z",
        })),
      },
    };
    const s = normalizeUsageCache(stale as never, now);
    expect(s.cacheAgeSeconds).toBeGreaterThan(300);
    expect(s.session?.windowExpired).toBe(false);
    expect(s.week?.windowExpired).toBe(false);
    expect(s.staleness).toBe("stale");
  });

  test("expired-window dominates fresh — even a 60-sec-old cache with dead window is expired-window", () => {
    // Corner case: cache is fresh by age but window boundary is stale.
    // The bug shape from Zdeňkovo report — user needs to know the window
    // died, not that the cache was recently written.
    const now = new Date("2026-07-05T15:31:00Z");
    const fresh = {
      timestamp: (now.getTime() - 60_000) / 1000, // 60 sec ago — "fresh" by age
      data: {
        ...REAL_SAMPLE.data,
        five_hour: {
          ...REAL_SAMPLE.data.five_hour,
          resets_at: "2026-07-05T14:00:00Z", // past
        },
      },
    };
    const s = normalizeUsageCache(fresh as never, now);
    expect(s.cacheAgeSeconds).toBeLessThan(300);
    expect(s.session?.windowExpired).toBe(true);
    expect(s.staleness).toBe("expired-window");
  });
});

describe("readRateLimits — file I/O", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "rate-limits-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  test("returns hasCache=false for missing file", async () => {
    const s = await readRateLimits(join(tmp, "does-not-exist.json"), FIXED_NOW);
    expect(s.hasCache).toBe(false);
    expect(s.cachePath).toBe(join(tmp, "does-not-exist.json"));
  });

  test("returns hasCache=false for malformed JSON", async () => {
    const path = join(tmp, "bad.json");
    await writeFile(path, "{not valid json");
    const s = await readRateLimits(path, FIXED_NOW);
    expect(s.hasCache).toBe(false);
  });

  test("parses real-world sample from disk", async () => {
    const path = join(tmp, "usage.json");
    await writeFile(path, JSON.stringify(REAL_SAMPLE));
    const s = await readRateLimits(path, FIXED_NOW);
    expect(s.hasCache).toBe(true);
    expect(s.session?.utilization).toBe(0.36);
    expect(s.week?.utilization).toBe(0.33);
    expect(s.cachePath).toBe(path);
  });
});

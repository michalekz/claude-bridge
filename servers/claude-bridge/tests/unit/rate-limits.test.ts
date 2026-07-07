import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock homedir BEFORE importing modules so lazy path resolution (bridgeRoot)
// respects the per-test temp dir. Same vi.hoisted pattern as context-usage.
const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => homeHolder.current || actual.tmpdir(),
  };
});

import {
  type OAuthApiLiveEnvelope,
  type StatusLineLiveEnvelope,
  writeOAuthApiLive,
  writeStatusLineLive,
} from "../../src/parser/live-data.ts";
import {
  normalizeFromOAuth,
  normalizeFromStatusLine,
  readLiveRateLimits,
} from "../../src/parser/rate-limits.ts";

const FIXED_NOW = new Date("2026-07-05T15:31:00Z");

/**
 * Real OAuth API response body (2026-07-04 snapshot, ~1.5 days stale as of
 * FIXED_NOW). This is what the OAuth /api/oauth/usage endpoint returns —
 * we wrap it in an envelope to test normalizeFromOAuth.
 */
const OAUTH_DATA = {
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
    disclaimer: "",
    can_purchase_credits: false,
    can_toggle: false,
  },
  member_dashboard_available: false,
};

function makeOAuthEnvelope(capturedAt: string): OAuthApiLiveEnvelope {
  return { capturedAt, data: OAUTH_DATA };
}

function makeStatusLineEnvelope(capturedAt: string): StatusLineLiveEnvelope {
  return {
    capturedAt,
    sessionId: "test-session",
    payload: {
      cwd: "/opt/claude-bridge",
      version: "2.1.201",
      model: { display_name: "Fable 5" },
      rate_limits: {
        // 2026-07-04T03:49:59Z
        five_hour: { used_percentage: 36, resets_at: 1783136999 },
        // 2026-07-06T03:59:59Z (test time is 15:31 on 2026-07-05, so this is future)
        seven_day: { used_percentage: 33, resets_at: 1783310399 },
      },
    },
  };
}

describe("normalizeFromOAuth", () => {
  test("returns hasLiveData=true and correct source", () => {
    const s = normalizeFromOAuth(makeOAuthEnvelope("2026-07-04T00:07:18Z"), FIXED_NOW);
    expect(s.hasLiveData).toBe(true);
    expect(s.source).toBe("oauth-api");
  });

  test("5-hour session bucket parses correctly (windowExpired=true past reset)", () => {
    const s = normalizeFromOAuth(makeOAuthEnvelope("2026-07-04T00:07:18Z"), FIXED_NOW);
    expect(s.session?.utilization).toBe(0.36);
    expect(s.session?.windowExpired).toBe(true);
    expect(s.session?.hoursUntilReset).toBeLessThan(0);
  });

  test("7-day week bucket parses correctly (windowExpired=false future reset)", () => {
    const s = normalizeFromOAuth(makeOAuthEnvelope("2026-07-04T00:07:18Z"), FIXED_NOW);
    expect(s.week?.utilization).toBe(0.33);
    expect(s.week?.windowExpired).toBe(false);
  });

  test("staleness='expired-window' when any bucket has past reset", () => {
    const s = normalizeFromOAuth(makeOAuthEnvelope("2026-07-04T00:07:18Z"), FIXED_NOW);
    expect(s.staleness).toBe("expired-window");
  });

  test("scopedLimits — per-model breakdown (Fable = 11%)", () => {
    const s = normalizeFromOAuth(makeOAuthEnvelope("2026-07-04T00:07:18Z"), FIXED_NOW);
    expect(s.scopedLimits).toHaveLength(1);
    expect(s.scopedLimits?.[0]?.utilization).toBe(0.11);
    expect(s.scopedLimits?.[0]?.modelDisplayName).toBe("Fable");
  });

  test("spend not included when enabled=false", () => {
    const s = normalizeFromOAuth(makeOAuthEnvelope("2026-07-04T00:07:18Z"), FIXED_NOW);
    expect(s.spend).toBeUndefined();
  });

  test("perModelWeekly not included when all null", () => {
    const s = normalizeFromOAuth(makeOAuthEnvelope("2026-07-04T00:07:18Z"), FIXED_NOW);
    expect(s.perModelWeekly).toBeUndefined();
  });

  test("spend included when enabled=true", () => {
    const envelope: OAuthApiLiveEnvelope = {
      capturedAt: "2026-07-04T00:07:18Z",
      data: {
        ...OAUTH_DATA,
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
    const s = normalizeFromOAuth(envelope, FIXED_NOW);
    expect(s.spend?.enabled).toBe(true);
    expect(s.spend?.usedAmountUsd).toBe(12.34);
    expect(s.spend?.limitUsd).toBe(100);
    expect(s.spend?.severity).toBe("warning");
  });

  test("perModelWeekly populated when non-null", () => {
    const envelope: OAuthApiLiveEnvelope = {
      capturedAt: "2026-07-04T00:07:18Z",
      data: {
        ...OAUTH_DATA,
        seven_day_opus: 42.5,
        seven_day_sonnet: 18,
      },
    };
    const s = normalizeFromOAuth(envelope, FIXED_NOW);
    expect(s.perModelWeekly).toEqual({ opus: 42.5, sonnet: 18 });
  });

  test("rawExperimental included for non-null codenames", () => {
    const envelope: OAuthApiLiveEnvelope = {
      capturedAt: "2026-07-04T00:07:18Z",
      data: {
        ...OAUTH_DATA,
        tangelo: { hidden_feature: true },
      },
    };
    const s = normalizeFromOAuth(envelope, FIXED_NOW);
    expect(s.rawExperimental).toEqual({ tangelo: { hidden_feature: true } });
  });

  test("returns hasLiveData=false when data is missing/malformed", () => {
    const envelope: OAuthApiLiveEnvelope = {
      capturedAt: "2026-07-04T00:07:18Z",
      data: undefined,
    };
    const s = normalizeFromOAuth(envelope, FIXED_NOW);
    expect(s.hasLiveData).toBe(false);
    expect(s.source).toBe("no-live-data");
  });
});

describe("normalizeFromStatusLine", () => {
  test("returns hasLiveData=true with source=statusline-stdin", () => {
    const s = normalizeFromStatusLine(makeStatusLineEnvelope("2026-07-05T15:30:00Z"), FIXED_NOW);
    expect(s.hasLiveData).toBe(true);
    expect(s.source).toBe("statusline-stdin");
  });

  test("session + week buckets from unix timestamp reset_at", () => {
    const s = normalizeFromStatusLine(makeStatusLineEnvelope("2026-07-05T15:30:00Z"), FIXED_NOW);
    expect(s.session?.utilization).toBe(0.36);
    expect(s.session?.resetsAt).toBe("2026-07-04T03:49:59.000Z");
    expect(s.session?.windowExpired).toBe(true);
    expect(s.week?.utilization).toBe(0.33);
    expect(s.week?.windowExpired).toBe(false);
  });

  test("staleness='fresh' when < 5 min old and no expired windows", () => {
    const now = new Date("2026-07-06T04:00:00Z");
    const env: StatusLineLiveEnvelope = {
      capturedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "s",
      payload: {
        rate_limits: {
          five_hour: {
            used_percentage: 40,
            resets_at: Math.floor(now.getTime() / 1000) + 3600,
          },
          seven_day: {
            used_percentage: 20,
            resets_at: Math.floor(now.getTime() / 1000) + 3600 * 24,
          },
        },
      },
    };
    const s = normalizeFromStatusLine(env, now);
    expect(s.staleness).toBe("fresh");
  });

  test("staleness='stale' when > 5 min old but windows current", () => {
    const now = new Date("2026-07-06T04:00:00Z");
    const env: StatusLineLiveEnvelope = {
      capturedAt: new Date(now.getTime() - 3_600_000).toISOString(),
      sessionId: "s",
      payload: {
        rate_limits: {
          five_hour: {
            used_percentage: 40,
            resets_at: Math.floor(now.getTime() / 1000) + 3600,
          },
          seven_day: {
            used_percentage: 20,
            resets_at: Math.floor(now.getTime() / 1000) + 3600 * 24,
          },
        },
      },
    };
    const s = normalizeFromStatusLine(env, now);
    expect(s.staleness).toBe("stale");
  });

  test("returns hasLiveData=false when rate_limits missing from payload", () => {
    const env: StatusLineLiveEnvelope = {
      capturedAt: "2026-07-05T15:30:00Z",
      sessionId: "s",
      payload: { model: { display_name: "Fable 5" } },
    };
    const s = normalizeFromStatusLine(env, FIXED_NOW);
    expect(s.hasLiveData).toBe(false);
    expect(s.source).toBe("no-live-data");
  });
});

describe("readLiveRateLimits — source priority", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "rl-v09-test-"));
    homeHolder.current = tmp;
    await mkdir(join(tmp, ".claude-bridge", "live"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    homeHolder.current = "";
  });

  test("neither envelope → hasLiveData=false + setupPointer", async () => {
    const s = await readLiveRateLimits();
    expect(s.hasLiveData).toBe(false);
    expect(s.source).toBe("no-live-data");
    expect(s.setupPointer).toBeTruthy();
  });

  test("only statusLine → uses statusline-stdin source", async () => {
    await writeStatusLineLive(makeStatusLineEnvelope("2026-07-05T15:30:00Z"));
    const s = await readLiveRateLimits(FIXED_NOW);
    expect(s.source).toBe("statusline-stdin");
    expect(s.hasLiveData).toBe(true);
  });

  test("only OAuth → uses oauth-api source", async () => {
    await writeOAuthApiLive(makeOAuthEnvelope("2026-07-04T00:07:18Z"));
    const s = await readLiveRateLimits(FIXED_NOW);
    expect(s.source).toBe("oauth-api");
    expect(s.hasLiveData).toBe(true);
    // OAuth-only sample has scopedLimits — richer field.
    expect(s.scopedLimits).toHaveLength(1);
  });

  test("both present → newer capturedAt wins", async () => {
    // statusLine captured 1 minute ago, OAuth captured 1 hour ago → statusLine wins.
    const now = new Date("2026-07-06T04:00:00Z");
    await writeStatusLineLive({
      capturedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "s",
      payload: {
        rate_limits: {
          five_hour: {
            used_percentage: 40,
            resets_at: Math.floor(now.getTime() / 1000) + 3600,
          },
          seven_day: {
            used_percentage: 20,
            resets_at: Math.floor(now.getTime() / 1000) + 3600 * 24,
          },
        },
      },
    });
    await writeOAuthApiLive({
      capturedAt: new Date(now.getTime() - 3_600_000).toISOString(),
      data: OAUTH_DATA,
    });
    const s = await readLiveRateLimits(now);
    expect(s.source).toBe("statusline-stdin");
  });

  test("statusLine without rate_limits + OAuth present → OAuth wins", async () => {
    // Older CC that doesn't send rate_limits on stdin — statusLine payload
    // present but without rate_limits field. OAuth fills the gap.
    await writeStatusLineLive({
      capturedAt: "2026-07-05T15:30:00Z",
      sessionId: "s",
      payload: { model: { display_name: "Fable 5" } },
    });
    await writeOAuthApiLive(makeOAuthEnvelope("2026-07-04T00:07:18Z"));
    const s = await readLiveRateLimits(FIXED_NOW);
    expect(s.source).toBe("oauth-api");
  });
});

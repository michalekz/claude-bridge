import {
  type OAuthApiLiveEnvelope,
  type StatusLineLiveEnvelope,
  envelopeAgeSeconds,
  findNewestStatusLine,
  readOAuthApiLive,
} from "./live-data.ts";

/**
 * Rate-limits reader — live-data-only (v0.9.0+).
 *
 * Two live sources, both under `~/.claude-bridge/live/`:
 *
 *  1. `statusline.json` — written by chained statusLine wrapper on every CC
 *     render. Contains `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`
 *     from CC 2.1.80+ stdin JSON. Primary source.
 *
 *  2. `oauth-api.json` — written by PostToolUse hook (`bin/refresh-limits`)
 *     when the throttle window elapses. Contains the full OAuth
 *     `/api/oauth/usage` response — richer than statusLine stdin (includes
 *     spend, extra_usage, per-model weekly, experimental codenames, structured
 *     limits[] with severity). Secondary source.
 *
 * Read priority (v0.9.0):
 *  1. statusline live envelope's rate_limits — 1-turn latency, no extra
 *     dependencies. `contextLimit` (session/week) available too but the
 *     rate limits tool doesn't return it here (that's peer_context_status).
 *  2. oauth-api live envelope — throttled to ~1/min, richer fields.
 *  3. `hasLiveData: false` + setup pointer if neither is available.
 *
 * Removed from v0.9.0 (breaking):
 *  - `~/.claude/.usage_cache.json` fossil read (was benabraham's cache, not CC's — see CREDITS.md v0.8.3).
 *  - `readRateLimits(path)` signature that accepted an arbitrary file path.
 *
 * Data is USER-SCOPED (per POSIX account), not per-session. All peers on
 * the same user account share exactly one set of rate limits.
 *
 * Structure of the OAuth API response (verified 2026-07-05 against
 * Anthropic account with Claude Code v2.1.201). Keys:
 *  - five_hour           — 5-hour session budget (utilization %, resets_at)
 *  - seven_day           — 7-day weekly budget
 *  - seven_day_{model}   — per-model weekly (opus / sonnet / oauth_apps / …)
 *  - limits[]            — structured limits with severity + is_active
 *  - spend               — cost/credit budget (if enabled by account)
 *  - extra_usage         — extra credit pool (if enabled)
 *  - {codenames}         — internal experiments (tangelo / iguana_necktie / …)
 */

interface RawFiveHourSevenDay {
  utilization: number | null;
  resets_at: string | null;
  limit_dollars: number | null;
  used_dollars: number | null;
  remaining_dollars: number | null;
}

interface RawLimit {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resets_at: string | null;
  scope: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: string | null;
  } | null;
  is_active: boolean;
}

interface RawSpendUsed {
  amount_minor: number;
  currency: string;
  exponent: number;
}

interface RawSpend {
  used: RawSpendUsed;
  limit: number | null;
  percent: number;
  severity: string;
  enabled: boolean;
  disabled_reason?: string | null;
  cap?: unknown;
  balance?: unknown;
  auto_reload?: unknown;
  disclaimer?: string;
  can_purchase_credits: boolean;
  can_toggle: boolean;
}

interface RawExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string | null;
  decimal_places: number | null;
  disabled_reason: string | null;
  daily: unknown | null;
  weekly: unknown | null;
}

/**
 * OAuth API response shape. This is the JSON body of GET
 * https://api.anthropic.com/api/oauth/usage.
 */
export interface RawOAuthUsageData {
  five_hour: RawFiveHourSevenDay;
  seven_day: RawFiveHourSevenDay;
  seven_day_oauth_apps: number | null;
  seven_day_opus: number | null;
  seven_day_sonnet: number | null;
  seven_day_cowork: number | null;
  seven_day_omelette: number | null;
  extra_usage: RawExtraUsage;
  limits: RawLimit[];
  spend: RawSpend;
  member_dashboard_available: boolean;
  [key: string]: unknown; // for codename passthrough
}

/**
 * Normalized bucket (session or week).
 * `utilization` in 0-1 fraction (source is 0-100).
 * `hoursUntilReset` may be NEGATIVE if the source is stale.
 * `windowExpired` is true when `resetsAt` is in the past (v0.8.2+) — the
 * utilization number describes a DEAD window and is not meaningful for
 * decisions about the current period.
 */
export interface RateLimitBucket {
  utilization: number;
  resetsAt: string;
  hoursUntilReset: number;
  severity: string;
  isActive: boolean;
  windowExpired: boolean;
}

export interface ScopedLimit {
  kind: string;
  utilization: number;
  resetsAt: string;
  severity: string;
  isActive: boolean;
  windowExpired: boolean;
  modelDisplayName?: string;
  modelId?: string;
  surface?: string;
}

/**
 * Overall freshness of the live data (v0.8.2+).
 */
export type Staleness = "fresh" | "stale" | "expired-window";

export interface RateLimitSpend {
  enabled: boolean;
  utilization: number;
  severity: string;
  usedAmountUsd: number;
  currency: string;
  limitUsd?: number;
}

export interface RateLimitExtraUsage {
  isEnabled: boolean;
  utilization?: number;
  monthlyLimit?: number;
  usedCredits?: number;
  currency?: string;
}

/**
 * Which live source was chosen. v0.9.0 no longer reads fossil cache; either
 * source can be missing (returns `hasLiveData: false`).
 */
export type RateLimitSource = "statusline-stdin" | "oauth-api" | "no-live-data";

export interface RateLimitStatus {
  hasLiveData: boolean;
  /** Which live source produced this result. v0.9.0+. */
  source: RateLimitSource;
  /** ISO timestamp when the source envelope was captured (statusLine render
   * or OAuth refresh). */
  capturedAt?: string;
  /** How many seconds ago the envelope was captured. */
  capturedAgeSeconds?: number;
  /** Overall freshness verdict. Absent when `hasLiveData=false`. */
  staleness?: Staleness;
  session?: RateLimitBucket;
  week?: RateLimitBucket;
  scopedLimits?: ScopedLimit[];
  spend?: RateLimitSpend;
  extraUsage?: RateLimitExtraUsage;
  perModelWeekly?: Record<string, number>;
  rawExperimental?: Record<string, unknown>;
  /** Setup instruction pointer when hasLiveData=false. */
  setupPointer?: string;
}

/**
 * Internal experiment/promo codenames — passed through raw if non-null.
 * Update if Anthropic ships new codenames; safe to leave as-is (missing keys
 * are ignored).
 */
const EXPERIMENTAL_KEYS = [
  "tangelo",
  "iguana_necktie",
  "omelette_promotional",
  "nimbus_quill",
  "cinder_cove",
  "amber_ladder",
] as const;

const PER_MODEL_WEEKLY_KEYS: Record<string, string> = {
  seven_day_opus: "opus",
  seven_day_sonnet: "sonnet",
  seven_day_oauth_apps: "oauthApps",
  seven_day_cowork: "cowork",
  seven_day_omelette: "omelette",
};

const FRESH_THRESHOLD_SECONDS = 300;

const SETUP_POINTER =
  "Install the plugin's statusLine wrapper AND/OR enable the PostToolUse " +
  "refresh-limits hook. See docs/SETUP-LIVE-DATA.md.";

function hoursBetween(iso: string, now: Date): number {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return Number.NaN;
  return (target - now.getTime()) / (1000 * 60 * 60);
}

function isWindowExpired(resetsAt: string, now: Date): boolean {
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return false;
  return t < now.getTime();
}

function toBucket(
  raw: RawFiveHourSevenDay,
  matchingLimit: RawLimit | undefined,
  now: Date,
): RateLimitBucket | undefined {
  if (raw.utilization == null || raw.resets_at == null) return undefined;
  return {
    utilization: raw.utilization / 100,
    resetsAt: raw.resets_at,
    hoursUntilReset: hoursBetween(raw.resets_at, now),
    severity: matchingLimit?.severity ?? "normal",
    isActive: matchingLimit?.is_active ?? false,
    windowExpired: isWindowExpired(raw.resets_at, now),
  };
}

/**
 * Convert `spend.used` (amount_minor + exponent) to a float dollar amount.
 *  amount_minor=0, exponent=2 → 0.00 USD
 *  amount_minor=1234, exponent=2 → 12.34 USD
 */
function minorToMajor(used: RawSpendUsed): number {
  return used.amount_minor / 10 ** used.exponent;
}

function computeStaleness(
  session: RateLimitBucket | undefined,
  week: RateLimitBucket | undefined,
  scopedLimits: ScopedLimit[],
  ageSeconds: number,
): Staleness {
  const anyExpired =
    (session?.windowExpired ?? false) ||
    (week?.windowExpired ?? false) ||
    scopedLimits.some((l) => l.windowExpired);
  if (anyExpired) return "expired-window";
  return ageSeconds < FRESH_THRESHOLD_SECONDS ? "fresh" : "stale";
}

/**
 * Normalize the rich OAuth API response into RateLimitStatus. Preserves
 * all optional fields (spend, extra_usage, per-model, codenames).
 *
 * `capturedAt` and derived staleness are set from the envelope timestamp.
 */
export function normalizeFromOAuth(
  envelope: OAuthApiLiveEnvelope,
  now: Date = new Date(),
): RateLimitStatus {
  const data = envelope.data as RawOAuthUsageData | undefined;
  if (!data) {
    return {
      hasLiveData: false,
      source: "no-live-data",
      setupPointer: SETUP_POINTER,
    };
  }
  const limits = data.limits ?? [];

  const sessionLimit = limits.find((l) => l.kind === "session");
  const weeklyAllLimit = limits.find((l) => l.kind === "weekly_all");

  const session = toBucket(data.five_hour, sessionLimit, now);
  const week = toBucket(data.seven_day, weeklyAllLimit, now);

  const scopedLimits: ScopedLimit[] = limits
    .filter((l) => l.scope != null && l.kind !== "session" && l.kind !== "weekly_all")
    .map((l) => {
      const resetsAt = l.resets_at ?? "";
      const entry: ScopedLimit = {
        kind: l.kind,
        utilization: l.percent / 100,
        resetsAt,
        severity: l.severity,
        isActive: l.is_active,
        windowExpired: resetsAt ? isWindowExpired(resetsAt, now) : false,
      };
      const model = l.scope?.model;
      if (model?.display_name) entry.modelDisplayName = model.display_name;
      if (model?.id) entry.modelId = model.id;
      if (l.scope?.surface) entry.surface = l.scope.surface;
      return entry;
    });

  const ageSeconds = envelopeAgeSeconds(envelope, now);
  const staleness = computeStaleness(session, week, scopedLimits, ageSeconds);

  const status: RateLimitStatus = {
    hasLiveData: true,
    source: "oauth-api",
    capturedAt: envelope.capturedAt,
    capturedAgeSeconds: ageSeconds,
    staleness,
  };

  if (session) status.session = session;
  if (week) status.week = week;
  if (scopedLimits.length > 0) status.scopedLimits = scopedLimits;

  if (data.spend?.enabled) {
    const spend = data.spend;
    const usedUsd = minorToMajor(spend.used);
    const entry: RateLimitSpend = {
      enabled: true,
      utilization: (spend.percent ?? 0) / 100,
      severity: spend.severity,
      usedAmountUsd: usedUsd,
      currency: spend.used.currency,
    };
    if (typeof spend.limit === "number") {
      entry.limitUsd = spend.limit / 10 ** spend.used.exponent;
    }
    status.spend = entry;
  }

  if (data.extra_usage?.is_enabled) {
    const eu = data.extra_usage;
    const entry: RateLimitExtraUsage = { isEnabled: true };
    if (eu.utilization != null) entry.utilization = eu.utilization / 100;
    if (eu.monthly_limit != null) entry.monthlyLimit = eu.monthly_limit;
    if (eu.used_credits != null) entry.usedCredits = eu.used_credits;
    if (eu.currency != null) entry.currency = eu.currency;
    status.extraUsage = entry;
  }

  const perModel: Record<string, number> = {};
  for (const [rawKey, cleanKey] of Object.entries(PER_MODEL_WEEKLY_KEYS)) {
    const v = data[rawKey];
    if (typeof v === "number") perModel[cleanKey] = v;
  }
  if (Object.keys(perModel).length > 0) {
    status.perModelWeekly = perModel;
  }

  const experimental: Record<string, unknown> = {};
  for (const key of EXPERIMENTAL_KEYS) {
    const v = data[key];
    if (v != null) experimental[key] = v;
  }
  if (Object.keys(experimental).length > 0) {
    status.rawExperimental = experimental;
  }

  return status;
}

/**
 * Normalize the compact rate_limits payload from statusLine stdin JSON.
 * CC 2.1.80+ sends `rate_limits.{five_hour,seven_day}.{used_percentage,
 * resets_at (unix timestamp)}`. Much smaller than OAuth response — no
 * spend, extra_usage, per-model, or codenames. But it's per-render, so
 * it's the most current source.
 */
export function normalizeFromStatusLine(
  envelope: StatusLineLiveEnvelope,
  now: Date = new Date(),
): RateLimitStatus {
  const rl = envelope.payload.rate_limits;
  if (!rl) {
    return {
      hasLiveData: false,
      source: "no-live-data",
      setupPointer: SETUP_POINTER,
    };
  }

  function bucketFromStatusLine(
    w: { used_percentage?: number; resets_at?: number } | undefined,
    now: Date,
  ): RateLimitBucket | undefined {
    if (!w || w.used_percentage == null || w.resets_at == null) return undefined;
    const resetsAtIso = new Date(w.resets_at * 1000).toISOString();
    return {
      utilization: w.used_percentage / 100,
      resetsAt: resetsAtIso,
      hoursUntilReset: hoursBetween(resetsAtIso, now),
      severity: "normal", // statusLine payload doesn't carry per-bucket severity
      isActive: true, // statusLine payload doesn't carry is_active either
      windowExpired: isWindowExpired(resetsAtIso, now),
    };
  }

  const session = bucketFromStatusLine(rl.five_hour, now);
  const week = bucketFromStatusLine(rl.seven_day, now);
  const ageSeconds = envelopeAgeSeconds(envelope, now);
  const staleness = computeStaleness(session, week, [], ageSeconds);

  const status: RateLimitStatus = {
    hasLiveData: true,
    source: "statusline-stdin",
    capturedAt: envelope.capturedAt,
    capturedAgeSeconds: ageSeconds,
    staleness,
  };
  if (session) status.session = session;
  if (week) status.week = week;
  return status;
}

/**
 * Read the current rate limit status from live data sources.
 *
 * Priority:
 *  1. statusLine capture (if it has a rate_limits field) — primary, per-turn
 *  2. OAuth API capture — richer fields, throttled ~1/min
 *  3. Neither → hasLiveData:false with setup pointer
 *
 * When both are present, the newer one wins by capturedAt. Rationale:
 * statusLine is the primary but statusLine payload can lack the rate_limits
 * field entirely (older CC), and OAuth is fresher when it fires between
 * statusLine renders.
 */
export async function readLiveRateLimits(now: Date = new Date()): Promise<RateLimitStatus> {
  // Rate limits are USER-scoped (per POSIX account), so we aggregate across
  // per-session statusLine captures by taking the newest one — its rate_limits
  // payload reflects the account's current state regardless of which session
  // wrote it. Context_window on the same envelope is per-session and NOT used
  // by this reader (see readContextUsage for per-session context reads).
  const [statusEnv, oauthEnv] = await Promise.all([findNewestStatusLine(), readOAuthApiLive()]);

  const statusResult = statusEnv ? normalizeFromStatusLine(statusEnv, now) : null;
  const oauthResult = oauthEnv ? normalizeFromOAuth(oauthEnv, now) : null;

  const statusOk = statusResult?.hasLiveData ?? false;
  const oauthOk = oauthResult?.hasLiveData ?? false;

  if (!statusOk && !oauthOk) {
    return {
      hasLiveData: false,
      source: "no-live-data",
      setupPointer: SETUP_POINTER,
    };
  }

  if (statusOk && !oauthOk) {
    return statusResult as RateLimitStatus;
  }
  if (!statusOk && oauthOk) {
    return oauthResult as RateLimitStatus;
  }

  // Both present: prefer the newer one. OAuth response is richer, but a
  // fresh statusLine capture is more current than a stale OAuth cache.
  const statusAge = statusResult?.capturedAgeSeconds ?? Number.POSITIVE_INFINITY;
  const oauthAge = oauthResult?.capturedAgeSeconds ?? Number.POSITIVE_INFINITY;
  return statusAge <= oauthAge
    ? (statusResult as RateLimitStatus)
    : (oauthResult as RateLimitStatus);
}

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
  /** `"unknown"` when the source that produced this bucket does not carry severity. */
  severity: string;
  /**
   * Absent when nobody measured it — the statusLine payload has no such field.
   * Optional rather than defaulted, because `false` and "not reported" are
   * different answers and the old code returned a hardcoded `true` for both.
   */
  isActive?: boolean;
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
export type RateLimitSource = "statusline-stdin" | "oauth-api" | "composed" | "no-live-data";

/**
 * Where the fields that only one source carries came from, and how old they are.
 *
 * Reported because a composed answer mixes two ages: utilization is as fresh as
 * the newest capture, while severity / scopedLimits / spend can only come from
 * the OAuth capture, which is throttled to roughly once a minute.
 */
export interface SecondarySourceInfo {
  source: RateLimitSource;
  capturedAt: string;
  capturedAgeSeconds: number;
  /** Field names taken from this older capture. */
  fields: string[];
}

/**
 * Why the older capture was NOT borrowed from.
 *
 * A refusal is not a fault and must not read like one. It means the two halves
 * describe DIFFERENT ACCOUNTS, which is exactly what account rotation produces:
 * the statusLine render follows the live credentials file immediately, while
 * the OAuth capture freezes at the moment the endpoint starts refusing the new
 * token. Borrowing across that line yields one answer built from two accounts.
 */
export interface SecondaryRejection {
  source: RateLimitSource;
  capturedAt: string;
  capturedAgeSeconds: number;
  reason: "different-weekly-window";
  /** The two windows that disagreed, so an operator can see it rather than trust it. */
  freshWeekResetsAt: string;
  olderWeekResetsAt: string;
}

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
  /** Present when two captures were combined — says which fields came from the older one. */
  secondary?: SecondarySourceInfo;
  /** Present when an older capture existed but described a different account. */
  secondaryRejected?: SecondaryRejection;
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
      // The statusLine payload carries neither of these. It used to claim
      // "normal" and `true` anyway, which is how a session at 88% was reported
      // as normal while the API called the same number a warning. An invented
      // value is worse than an absent one (fix, 2026-08-04).
      severity: "unknown",
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

  // Both present: COMBINE them, do not pick one (fix, 2026-08-04).
  //
  // Picking looked reasonable and was not. statusLine is written on every
  // render, so it is almost always the newer capture and therefore almost
  // always won -- and it carries only `five_hour` and `seven_day`. Everything
  // the tool's own description promises from the OAuth capture --
  // `scopedLimits` (including the `weekly_scoped` per-model budget), `spend`,
  // `extraUsage`, `perModelWeekly`, and the only real `severity` / `isActive`
  // there is -- lost the comparison every time and reached no caller. Measured
  // 2026-08-04: the API reported a `weekly_scoped` bucket at 41% and a session
  // severity of `warning`; the tool returned no scopedLimits at all and called
  // an 88% session "normal".
  //
  // So: the newer capture supplies the numbers, the OAuth capture supplies the
  // fields only it has, and `secondary` records how old that half is. Mixing
  // two ages silently would just be a quieter version of the same lie.
  const statusAge = statusResult?.capturedAgeSeconds ?? Number.POSITIVE_INFINITY;
  const oauthAge = oauthResult?.capturedAgeSeconds ?? Number.POSITIVE_INFINITY;
  const statusStatus = statusResult as RateLimitStatus;
  const oauthStatus = oauthResult as RateLimitStatus;

  // OAuth newer AND already the richer source -- nothing to add.
  if (oauthAge <= statusAge) return oauthStatus;

  return composeFromStatusLineAndOAuth(statusStatus, oauthStatus);
}

/**
 * Fresh numbers from the statusLine capture, richer fields from the older
 * OAuth capture, and an explicit note of which half is stale.
 */
/**
 * How far apart the two halves may put the SAME weekly window.
 *
 * MEASURED 2026-08-09 on one account: the statusLine capture said
 * `2026-08-10T03:00:00.000Z` and the OAuth capture said
 * `2026-08-10T02:59:59.604Z` for the same window — 0.4 s apart, because one
 * rounds a unix timestamp and the other carries microseconds. Comparing for
 * equality would therefore refuse every borrow, always.
 *
 * Two minutes is three hundred times that skew and still nowhere near the gap
 * between accounts: the three profiles measured that day reset on 10. 8., 14. 8.
 * and 16. 8. — days apart, not minutes.
 */
const SAME_WINDOW_TOLERANCE_MS = 120_000;

/** Do these two halves describe the same weekly window, i.e. the same account? */
function sameWeeklyWindow(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true; // Nothing to disagree about.
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return true; // Unparseable is not evidence.
  return Math.abs(ta - tb) <= SAME_WINDOW_TOLERANCE_MS;
}

export function composeFromStatusLineAndOAuth(
  fresh: RateLimitStatus,
  older: RateLimitStatus,
): RateLimitStatus {
  /**
   * THE TWO HALVES MUST BE THE SAME ACCOUNT (v0.11.27).
   *
   * This function was written for two captures of ONE account at two ages, and
   * it recorded the age difference faithfully. Account rotation introduces the
   * case it never contemplated: two captures of DIFFERENT accounts. The
   * statusLine render follows the live credentials file at once, while the
   * OAuth capture freezes the moment the endpoint starts refusing the new
   * token — and the hook deliberately leaves the previous file in place rather
   * than writing a gap.
   *
   * Observed live on 2026-08-09, one minute after a rotation: `utilization`
   * 0.46 from the new account beside `severity: "critical"` from the old, two
   * different weekly windows inside one object, and `staleness: "fresh"` over
   * the pair. Age was recorded; PROVENANCE was not.
   *
   * The weekly window is the boundary rather than the 5-hour one because a 5-h
   * window legitimately rolls every few hours on the same account — a rule
   * built on it would refuse borrows as a matter of routine, and a refusal that
   * happens constantly stops carrying information.
   */
  if (!sameWeeklyWindow(fresh.week?.resetsAt, older.week?.resetsAt)) {
    const rejected: RateLimitStatus = { ...fresh };
    rejected.secondaryRejected = {
      source: older.source,
      capturedAt: older.capturedAt ?? "",
      capturedAgeSeconds: older.capturedAgeSeconds ?? 0,
      reason: "different-weekly-window",
      freshWeekResetsAt: fresh.week?.resetsAt ?? "",
      olderWeekResetsAt: older.week?.resetsAt ?? "",
    };
    return rejected;
  }

  const borrowed: string[] = [];
  const out: RateLimitStatus = { ...fresh, source: "composed" };

  // Severity and isActive exist only in the OAuth payload. Carry them onto the
  // fresh buckets rather than leaving "unknown" beside data that IS known.
  const mergeBucket = (
    freshBucket: RateLimitBucket | undefined,
    olderBucket: RateLimitBucket | undefined,
    label: string,
  ): RateLimitBucket | undefined => {
    if (!freshBucket) return olderBucket;
    if (!olderBucket) return freshBucket;
    const merged: RateLimitBucket = { ...freshBucket };
    if (freshBucket.severity === "unknown" && olderBucket.severity !== "unknown") {
      merged.severity = olderBucket.severity;
      borrowed.push(`${label}.severity`);
    }
    if (freshBucket.isActive === undefined && olderBucket.isActive !== undefined) {
      merged.isActive = olderBucket.isActive;
      borrowed.push(`${label}.isActive`);
    }
    return merged;
  };

  const session = mergeBucket(fresh.session, older.session, "session");
  const week = mergeBucket(fresh.week, older.week, "week");
  if (session) out.session = session;
  if (week) out.week = week;

  // Fields the statusLine capture has no equivalent for at all.
  if (older.scopedLimits) {
    out.scopedLimits = older.scopedLimits;
    borrowed.push("scopedLimits");
  }
  if (older.spend) {
    out.spend = older.spend;
    borrowed.push("spend");
  }
  if (older.extraUsage) {
    out.extraUsage = older.extraUsage;
    borrowed.push("extraUsage");
  }
  if (older.perModelWeekly) {
    out.perModelWeekly = older.perModelWeekly;
    borrowed.push("perModelWeekly");
  }
  if (older.rawExperimental) {
    out.rawExperimental = older.rawExperimental;
    borrowed.push("rawExperimental");
  }

  // Nothing worth borrowing -- say statusline-stdin rather than claim a
  // composition that did not happen.
  if (borrowed.length === 0) return fresh;

  out.secondary = {
    source: older.source,
    capturedAt: older.capturedAt ?? "",
    capturedAgeSeconds: older.capturedAgeSeconds ?? 0,
    fields: borrowed,
  };
  return out;
}

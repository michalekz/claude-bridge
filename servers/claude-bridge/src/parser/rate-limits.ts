import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Rate-limits reader — parses Claude Code's own usage cache.
 *
 * File: ~/.claude/.usage_cache.json
 * Maintained by: Claude Code itself (refreshed on specific events — session
 * start, /rate-limits invocation, threshold crossing). Not real-time.
 *
 * Data is USER-SCOPED (per POSIX account), not per-session. All peers on
 * the same user account share exactly one set of rate limits.
 *
 * Source structure (verified 2026-07-05 against Anthropic account with
 * Claude Code v2.1.201). Keys:
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

interface RawUsageCacheData {
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

interface RawUsageCache {
  timestamp: number;
  data: RawUsageCacheData;
}

/**
 * Normalized bucket (session or week).
 * `utilization` in 0-1 fraction (source is 0-100).
 * `hoursUntilReset` may be NEGATIVE if the cache is stale.
 */
export interface RateLimitBucket {
  utilization: number;
  resetsAt: string;
  hoursUntilReset: number;
  severity: string;
  isActive: boolean;
}

export interface ScopedLimit {
  kind: string;
  utilization: number;
  resetsAt: string;
  severity: string;
  isActive: boolean;
  modelDisplayName?: string;
  modelId?: string;
  surface?: string;
}

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

export interface RateLimitStatus {
  hasCache: boolean;
  cacheTimestamp?: string;
  cacheAgeSeconds?: number;
  cachePath?: string;
  session?: RateLimitBucket;
  week?: RateLimitBucket;
  scopedLimits?: ScopedLimit[];
  spend?: RateLimitSpend;
  extraUsage?: RateLimitExtraUsage;
  perModelWeekly?: Record<string, number>;
  rawExperimental?: Record<string, unknown>;
}

const USAGE_CACHE_PATH = join(homedir(), ".claude", ".usage_cache.json");

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

function hoursBetween(iso: string, now: Date): number {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return Number.NaN;
  return (target - now.getTime()) / (1000 * 60 * 60);
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

export function normalizeUsageCache(raw: RawUsageCache, now: Date = new Date()): RateLimitStatus {
  const cacheTimestamp = new Date(raw.timestamp * 1000).toISOString();
  const cacheAgeSeconds = Math.max(0, Math.floor((now.getTime() - raw.timestamp * 1000) / 1000));

  const data = raw.data;
  const limits = data.limits ?? [];

  const sessionLimit = limits.find((l) => l.kind === "session");
  const weeklyAllLimit = limits.find((l) => l.kind === "weekly_all");

  const session = toBucket(data.five_hour, sessionLimit, now);
  const week = toBucket(data.seven_day, weeklyAllLimit, now);

  const scopedLimits: ScopedLimit[] = limits
    .filter((l) => l.scope != null && l.kind !== "session" && l.kind !== "weekly_all")
    .map((l) => {
      const entry: ScopedLimit = {
        kind: l.kind,
        utilization: l.percent / 100,
        resetsAt: l.resets_at ?? "",
        severity: l.severity,
        isActive: l.is_active,
      };
      const model = l.scope?.model;
      if (model?.display_name) entry.modelDisplayName = model.display_name;
      if (model?.id) entry.modelId = model.id;
      if (l.scope?.surface) entry.surface = l.scope.surface;
      return entry;
    });

  const status: RateLimitStatus = {
    hasCache: true,
    cacheTimestamp,
    cacheAgeSeconds,
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
 * Read + parse the usage cache. Returns `{ hasCache: false }` if the file
 * doesn't exist or is unreadable (= graceful degrade for accounts that have
 * never invoked /rate-limits or aren't logged in).
 *
 * Path defaults to ~/.claude/.usage_cache.json but is injectable for tests.
 */
export async function readRateLimits(
  path: string = USAGE_CACHE_PATH,
  now: Date = new Date(),
): Promise<RateLimitStatus> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { hasCache: false, cachePath: path };
  }
  let parsed: RawUsageCache;
  try {
    parsed = JSON.parse(raw) as RawUsageCache;
  } catch {
    return { hasCache: false, cachePath: path };
  }
  const status = normalizeUsageCache(parsed, now);
  status.cachePath = path;
  return status;
}

/**
 * Canonical Claude model metadata.
 *
 * Source of truth: https://platform.claude.com/docs/en/about-claude/models/overview
 * Verified 2026-07-07 (Sonnet 5 GA, Sonnet 4.6 → legacy). Update when Anthropic
 * releases new models or migrates lifecycle. Bug reports for missing models
 * are welcome — see `contextLimitSource` on `peer_context_status` output for
 * how consumers detect unknown models.
 *
 * Lifecycle terms:
 *  - current     = Anthropic's recommended models in latest generation
 *  - legacy      = still available but superseded; consider migrating
 *  - deprecated  = scheduled for retirement; migrate before EOL
 */

export type ModelGeneration = "current" | "legacy" | "deprecated";
export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "mythos";

export interface ModelCapabilities {
  /** Vision (image input) support */
  vision: boolean;
  /** `extended_thinking` parameter supported */
  extendedThinking: boolean;
  /** Adaptive thinking always-on / opt-in */
  adaptiveThinking: boolean;
}

export interface ModelPricing {
  /** Input price per million tokens (USD) */
  inputPerMTok: number;
  /** Output price per million tokens (USD) */
  outputPerMTok: number;
}

/**
 * A published price that stops applying on a known date.
 *
 * Anthropic ships introductory rates with an announced end date (Sonnet 5 is
 * $2/$10 through 2026-08-31, $3/$15 after). A single pricing pair cannot say
 * that, so before 2026-08-04 the table simply carried the post-introductory
 * number and overstated the current price by 50%. Pinning it to the
 * introductory pair instead would have been just as wrong from 2026-09-01 —
 * a fix with an expiry date is not a fix.
 */
export interface DatedPricing extends ModelPricing {
  /** ISO date of the last day these rates apply. */
  until: string;
  /** Rates in force from the day after `until`. */
  after: ModelPricing;
}

export interface ModelMetadata {
  /** Canonical API id (e.g., "claude-opus-4-7"). */
  id: string;
  /** Human-readable name. */
  displayName: string;
  /** Model family. */
  family: ModelFamily;
  /** Lifecycle status. */
  generation: ModelGeneration;
  /** Maximum input context window (tokens). */
  contextWindow: number;
  /** Maximum output tokens per response. */
  maxOutputTokens: number;
  /** Pricing per million tokens. Carries `until`/`after` while a published rate change is pending. */
  pricing: ModelPricing | DatedPricing;
  /** Capability flags. */
  capabilities: ModelCapabilities;
  /** Reliable knowledge cutoff ISO-date (YYYY-MM-DD if known else YYYY-MM). */
  knowledgeCutoff: string;
  /** Training data cutoff (broader). */
  trainingDataCutoff: string;
  /** Notes: special quirks, EOL dates, etc. */
  notes?: string;
}

const STANDARD_LIMIT = 200_000;
const ONE_M_LIMIT = 1_000_000;

/**
 * Canonical table — all known Claude models with metadata.
 *
 * Add new entries here when Anthropic releases models. Plugin code must
 * never hard-code model context windows outside this table.
 */
export const MODELS: ModelMetadata[] = [
  // ---- Current generation ----
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    family: "opus",
    generation: "current",
    contextWindow: ONE_M_LIMIT,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    capabilities: { vision: true, extendedThinking: false, adaptiveThinking: true },
    knowledgeCutoff: "2026-05",
    trainingDataCutoff: "2026-05",
    notes: "Missing from this table until 2026-08-04 — see CHANGELOG v0.10.2.",
  },
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    family: "fable",
    generation: "current",
    contextWindow: ONE_M_LIMIT,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 10, outputPerMTok: 50 },
    capabilities: { vision: true, extendedThinking: false, adaptiveThinking: true },
    knowledgeCutoff: "2026-01",
    trainingDataCutoff: "2026-01",
    notes: "Most capable widely released model; adaptive thinking always-on.",
  },
  {
    id: "claude-mythos-5",
    displayName: "Claude Mythos 5",
    family: "mythos",
    generation: "current",
    contextWindow: ONE_M_LIMIT,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 10, outputPerMTok: 50 },
    capabilities: { vision: true, extendedThinking: false, adaptiveThinking: true },
    knowledgeCutoff: "2026-01",
    trainingDataCutoff: "2026-01",
    notes: "Project Glasswing exclusive (invitation only).",
  },
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    family: "opus",
    generation: "current",
    contextWindow: ONE_M_LIMIT,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    capabilities: { vision: true, extendedThinking: false, adaptiveThinking: true },
    knowledgeCutoff: "2026-01",
    trainingDataCutoff: "2026-01",
    notes: "On Microsoft Foundry context is 200k. Default effort=high on Claude Code and API.",
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    family: "sonnet",
    generation: "current",
    contextWindow: ONE_M_LIMIT,
    maxOutputTokens: 128_000,
    pricing: {
      inputPerMTok: 2,
      outputPerMTok: 10,
      until: "2026-08-31",
      after: { inputPerMTok: 3, outputPerMTok: 15 },
    },
    capabilities: { vision: true, extendedThinking: false, adaptiveThinking: true },
    knowledgeCutoff: "2026-01",
    trainingDataCutoff: "2026-01",
    notes: "Default effort=high on Claude API and Claude Code.",
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    family: "haiku",
    generation: "current",
    contextWindow: STANDARD_LIMIT,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    capabilities: { vision: true, extendedThinking: true, adaptiveThinking: false },
    knowledgeCutoff: "2025-02",
    trainingDataCutoff: "2025-07",
    notes: "The only current-generation 200k-context model.",
  },

  // ---- Legacy (still available) ----
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7 (legacy)",
    family: "opus",
    generation: "legacy",
    contextWindow: ONE_M_LIMIT,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    capabilities: { vision: true, extendedThinking: false, adaptiveThinking: true },
    knowledgeCutoff: "2026-01",
    trainingDataCutoff: "2026-01",
    notes: "Tokenizer introduced here; ~30% more tokens per text vs. older models.",
  },
  {
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6 (legacy)",
    family: "opus",
    generation: "legacy",
    contextWindow: ONE_M_LIMIT,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    capabilities: { vision: true, extendedThinking: true, adaptiveThinking: true },
    knowledgeCutoff: "2025-05",
    trainingDataCutoff: "2025-08",
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6 (legacy)",
    family: "sonnet",
    generation: "legacy",
    contextWindow: ONE_M_LIMIT,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    capabilities: { vision: true, extendedThinking: true, adaptiveThinking: true },
    knowledgeCutoff: "2025-08",
    trainingDataCutoff: "2026-01",
    notes: "Superseded by Claude Sonnet 5 (2026-07 GA).",
  },
  {
    id: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5 (legacy)",
    family: "sonnet",
    generation: "legacy",
    // 1M, not the 200k this table claimed until 2026-08-04. peer_context_status
    // divides by this number, so the old value put a peer at 100% of context
    // while it was actually at 20% — an autocompact alarm four fifths early.
    contextWindow: ONE_M_LIMIT,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    capabilities: { vision: true, extendedThinking: true, adaptiveThinking: false },
    knowledgeCutoff: "2025-01",
    trainingDataCutoff: "2025-07",
  },
  {
    id: "claude-opus-4-5",
    displayName: "Claude Opus 4.5 (legacy)",
    family: "opus",
    generation: "legacy",
    contextWindow: STANDARD_LIMIT,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    capabilities: { vision: true, extendedThinking: true, adaptiveThinking: false },
    knowledgeCutoff: "2025-05",
    trainingDataCutoff: "2025-08",
  },

  // ---- Deprecated (retiring) ----
  {
    id: "claude-opus-4-1",
    displayName: "Claude Opus 4.1 (deprecated)",
    family: "opus",
    generation: "deprecated",
    contextWindow: STANDARD_LIMIT,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 15, outputPerMTok: 75 },
    capabilities: { vision: true, extendedThinking: true, adaptiveThinking: false },
    knowledgeCutoff: "2025-01",
    trainingDataCutoff: "2025-03",
    notes: "Retires 2026-08-05. Migrate to Claude Opus 4.8.",
  },
];

const MODEL_BY_ID: Record<string, ModelMetadata> = Object.fromEntries(MODELS.map((m) => [m.id, m]));

/**
 * Strip suffixes from model id to get the canonical lookup key.
 *  - "claude-haiku-4-5-20251001" → "claude-haiku-4-5"  (date suffix)
 *  - "claude-opus-4-7-[1m]"     → "claude-opus-4-7"   ([1m] tag)
 */
export function normalizeModelId(model: string): string {
  return model.replace(/\[1m\]/gi, "").replace(/-\d{8}$/, "");
}

/**
 * Lookup model metadata by id (with normalization).
 * Returns null for unknown models.
 */
export function lookupModel(model: string | null | undefined): ModelMetadata | null {
  if (!model) return null;
  const baseId = normalizeModelId(model);
  return MODEL_BY_ID[baseId] ?? null;
}

function isDated(p: ModelPricing | DatedPricing): p is DatedPricing {
  return "until" in p && "after" in p;
}

/**
 * The rates in force on `now`, for models whose published price changes on a
 * known date. Plain (undated) pricing is returned unchanged.
 */
export function effectivePricing(
  model: ModelMetadata,
  now: Date = new Date(),
): ModelPricing & { pendingChange?: { on: string; to: ModelPricing } } {
  const p = model.pricing;
  if (!isDated(p)) return { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok };
  // `until` is the last day the introductory rate applies, so it expires at the
  // end of that date, not at its midnight.
  const expiresAt = new Date(`${p.until}T23:59:59.999Z`);
  if (now > expiresAt) return { ...p.after };
  return {
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
    pendingChange: { on: p.until, to: p.after },
  };
}

/**
 * Source attribution for the metadata (for transparency in tool output).
 *
 * Context window / max output / capabilities are verifiable against
 * `GET /v1/models`; price and lifecycle are published only on the docs pages
 * and are still hand-copied here. Sourcing them mechanically is v0.10.3.
 */
export const MODEL_METADATA_SOURCE = {
  source: "https://platform.claude.com/docs/en/about-claude/models/overview",
  pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing",
  verifiedAt: "2026-08-04",
  verifiedAgainst: "GET /v1/models (11 models) + published pricing page",
} as const;

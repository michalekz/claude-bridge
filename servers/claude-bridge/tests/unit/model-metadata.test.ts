import { describe, expect, test } from "vitest";
import {
  MODELS,
  MODEL_METADATA_SOURCE,
  effectivePricing,
  lookupModel,
  normalizeModelId,
} from "../../src/parser/model-metadata.ts";

describe("normalizeModelId", () => {
  test("strips date suffix", () => {
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(normalizeModelId("claude-opus-4-1-20250805")).toBe("claude-opus-4-1");
  });

  test("strips [1m] tag", () => {
    expect(normalizeModelId("claude-opus-4-7-[1m]")).toBe("claude-opus-4-7-");
    expect(normalizeModelId("[1m]claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  test("strips both", () => {
    // `[1m]` first → leaves `claude-haiku-4-5--20251001` (double dash where [1m] was).
    // Then date suffix → `claude-haiku-4-5-`. Edge case, unlikely in real data.
    expect(normalizeModelId("claude-haiku-4-5-[1m]-20251001")).toBe("claude-haiku-4-5-");
  });

  test("leaves canonical ids unchanged", () => {
    expect(normalizeModelId("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(normalizeModelId("claude-fable-5")).toBe("claude-fable-5");
  });
});

describe("lookupModel", () => {
  test("returns metadata for current generation models", () => {
    const opus = lookupModel("claude-opus-4-8");
    expect(opus).not.toBeNull();
    expect(opus?.generation).toBe("current");
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(opus?.family).toBe("opus");
  });

  test("returns metadata for Sonnet 5 (added 2026-07-07)", () => {
    const sonnet5 = lookupModel("claude-sonnet-5");
    expect(sonnet5).not.toBeNull();
    expect(sonnet5?.generation).toBe("current");
    expect(sonnet5?.contextWindow).toBe(1_000_000);
    expect(sonnet5?.family).toBe("sonnet");
  });

  test("Sonnet 4.6 moved from current to legacy (2026-07-07)", () => {
    const sonnet46 = lookupModel("claude-sonnet-4-6");
    expect(sonnet46?.generation).toBe("legacy");
    expect(sonnet46?.contextWindow).toBe(1_000_000);
  });

  test("returns metadata for legacy models", () => {
    const opus47 = lookupModel("claude-opus-4-7");
    expect(opus47?.generation).toBe("legacy");
    expect(opus47?.contextWindow).toBe(1_000_000);
  });

  test("returns metadata for deprecated models", () => {
    const opus41 = lookupModel("claude-opus-4-1");
    expect(opus41?.generation).toBe("deprecated");
    expect(opus41?.notes).toContain("Retires");
  });

  test("Haiku 4.5 is 200k (only standard-window current model)", () => {
    const haiku = lookupModel("claude-haiku-4-5");
    expect(haiku?.contextWindow).toBe(200_000);
    expect(haiku?.generation).toBe("current");
  });

  test("normalizes date suffix before lookup", () => {
    const haiku = lookupModel("claude-haiku-4-5-20251001");
    expect(haiku?.id).toBe("claude-haiku-4-5");
  });

  test("returns null for unknown / null / empty", () => {
    expect(lookupModel(null)).toBeNull();
    expect(lookupModel(undefined)).toBeNull();
    expect(lookupModel("")).toBeNull();
    expect(lookupModel("future-model-xyz")).toBeNull();
  });
});

describe("MODELS table integrity", () => {
  test("every entry has required fields", () => {
    for (const m of MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.displayName).toBeTruthy();
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBeGreaterThan(0);
      expect(m.pricing.inputPerMTok).toBeGreaterThanOrEqual(0);
      expect(m.pricing.outputPerMTok).toBeGreaterThanOrEqual(0);
      expect(m.knowledgeCutoff).toMatch(/^\d{4}-\d{2}$/);
      expect(m.trainingDataCutoff).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  test("model ids are unique", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("context window is either 200k or 1M", () => {
    for (const m of MODELS) {
      expect([200_000, 1_000_000]).toContain(m.contextWindow);
    }
  });

  test("at least one model per generation", () => {
    const gens = new Set(MODELS.map((m) => m.generation));
    expect(gens.has("current")).toBe(true);
    expect(gens.has("legacy")).toBe(true);
    expect(gens.has("deprecated")).toBe(true);
  });

  test("source attribution is present", () => {
    expect(MODEL_METADATA_SOURCE.source).toContain("platform.claude.com");
    expect(MODEL_METADATA_SOURCE.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * The table drifted away from what Anthropic actually publishes, and nothing
 * caught it — every test above checks the table's internal shape, never its
 * agreement with the outside world (found in the 2026-08-04 MCP test, defect
 * #5: `model_info` did not know `claude-opus-5`).
 *
 * Three separate errors were present at once:
 *   - `claude-opus-5` was missing outright
 *   - `claude-sonnet-4-5` claimed 200k context; it is a 1M model
 *   - `claude-sonnet-5` was priced at $3/$15; the published rate is $2/$10
 *     through 2026-08-31
 *
 * API_SHAPES below is the verbatim response of `GET /v1/models?limit=100`
 * (subscription OAuth token, 2026-08-04, 11 models). It is a fixture, not a
 * live call — tests must not depend on the network. Refresh it by hand when
 * Anthropic ships a model, which is exactly the moment the table needs
 * revisiting anyway.
 */
const API_SHAPES: Array<{ id: string; max_input_tokens: number; max_tokens: number }> = [
  { id: "claude-opus-5", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: "claude-sonnet-5", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: "claude-fable-5", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: "claude-opus-4-8", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: "claude-opus-4-7", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: "claude-sonnet-4-6", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: "claude-opus-4-6", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: "claude-opus-4-5-20251101", max_input_tokens: 200_000, max_tokens: 64_000 },
  { id: "claude-haiku-4-5-20251001", max_input_tokens: 200_000, max_tokens: 64_000 },
  { id: "claude-sonnet-4-5-20250929", max_input_tokens: 1_000_000, max_tokens: 64_000 },
  { id: "claude-opus-4-1-20250805", max_input_tokens: 200_000, max_tokens: 32_000 },
];

describe("the table agrees with GET /v1/models", () => {
  test("every model the API serves is in the table", () => {
    const missing = API_SHAPES.map((s) => normalizeModelId(s.id)).filter((id) => !lookupModel(id));
    // Printing the list matters: an `in`-style membership assertion that only
    // reports a boolean is how `claude-opus-5` stayed missing.
    expect(missing).toEqual([]);
  });

  test("context window and max output match the API for every shared model", () => {
    const drift: string[] = [];
    for (const shape of API_SHAPES) {
      const m = lookupModel(shape.id);
      if (!m) continue;
      if (m.contextWindow !== shape.max_input_tokens) {
        drift.push(`${m.id} context ${m.contextWindow} != api ${shape.max_input_tokens}`);
      }
      if (m.maxOutputTokens !== shape.max_tokens) {
        drift.push(`${m.id} maxOutput ${m.maxOutputTokens} != api ${shape.max_tokens}`);
      }
    }
    expect(drift).toEqual([]);
  });

  test("THE REGRESSION: Sonnet 4.5 is a 1M model", () => {
    // At 200k, peer_context_status divided a 1M budget by a fifth of it and
    // put a peer at "100% used" while four fifths of the window was free.
    expect(lookupModel("claude-sonnet-4-5-20250929")?.contextWindow).toBe(1_000_000);
  });

  test("THE REGRESSION: opus-5 resolves, plain and date-suffixed", () => {
    expect(lookupModel("claude-opus-5")?.displayName).toBe("Claude Opus 5");
    expect(lookupModel("claude-opus-5-20260101")?.id).toBe("claude-opus-5");
  });
});

describe("effectivePricing", () => {
  const sonnet5 = () => {
    const m = lookupModel("claude-sonnet-5");
    if (!m) throw new Error("claude-sonnet-5 missing from table");
    return m;
  };

  test("THE REGRESSION: Sonnet 5 costs $2/$10 today, not $3/$15", () => {
    const p = effectivePricing(sonnet5(), new Date("2026-08-04T09:00:00Z"));
    expect(p.inputPerMTok).toBe(2);
    expect(p.outputPerMTok).toBe(10);
  });

  test("the pending change is visible while the introductory rate holds", () => {
    const p = effectivePricing(sonnet5(), new Date("2026-08-04T09:00:00Z"));
    expect(p.pendingChange).toEqual({
      on: "2026-08-31",
      to: { inputPerMTok: 3, outputPerMTok: 15 },
    });
  });

  test("the introductory rate holds through the whole of its last day", () => {
    const p = effectivePricing(sonnet5(), new Date("2026-08-31T23:59:00Z"));
    expect(p.inputPerMTok).toBe(2);
  });

  test("and lapses the day after - the fix does not expire with the price", () => {
    const p = effectivePricing(sonnet5(), new Date("2026-09-01T00:00:01Z"));
    expect(p.inputPerMTok).toBe(3);
    expect(p.outputPerMTok).toBe(15);
    expect(p.pendingChange).toBeUndefined();
  });

  test("undated pricing passes through untouched", () => {
    const opus5 = lookupModel("claude-opus-5");
    if (!opus5) throw new Error("claude-opus-5 missing from table");
    const p = effectivePricing(opus5, new Date("2027-01-01T00:00:00Z"));
    expect(p).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
  });
});

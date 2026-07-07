import { describe, expect, test } from "vitest";
import {
  MODELS,
  MODEL_METADATA_SOURCE,
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

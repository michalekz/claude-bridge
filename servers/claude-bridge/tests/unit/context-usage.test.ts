import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  detectContextLimit,
  readContextUsage,
  riskBucket,
} from "../../src/parser/context-usage.ts";
import type { SessionRef } from "../../src/parser/session.ts";

describe("detectContextLimit", () => {
  test("returns 1M for Opus 4.6/4.7/4.8 (canonical lookup)", () => {
    expect(detectContextLimit("claude-opus-4-6")).toBe(1_000_000);
    expect(detectContextLimit("claude-opus-4-7")).toBe(1_000_000);
    expect(detectContextLimit("claude-opus-4-8")).toBe(1_000_000);
  });

  test("returns 1M for Sonnet 4.6 (canonical lookup)", () => {
    expect(detectContextLimit("claude-sonnet-4-6")).toBe(1_000_000);
  });

  test("returns 1M for Fable 5 / Mythos 5 (canonical lookup)", () => {
    expect(detectContextLimit("claude-fable-5")).toBe(1_000_000);
    expect(detectContextLimit("claude-mythos-5")).toBe(1_000_000);
  });

  test("returns 200k for Haiku 4.5 (only standard-window model)", () => {
    expect(detectContextLimit("claude-haiku-4-5")).toBe(200_000);
    // Date suffix is stripped before lookup.
    expect(detectContextLimit("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  test("explicit [1m] tag still works (legacy)", () => {
    expect(detectContextLimit("claude-opus-4-7-[1m]")).toBe(1_000_000);
    expect(detectContextLimit("claude-haiku-4-5-[1m]")).toBe(1_000_000); // override
  });

  test("returns 200k default for null/undefined/empty/unknown", () => {
    expect(detectContextLimit(null)).toBe(200_000);
    expect(detectContextLimit(undefined)).toBe(200_000);
    expect(detectContextLimit("")).toBe(200_000);
    expect(detectContextLimit("future-unknown-model")).toBe(200_000);
  });
});

describe("riskBucket", () => {
  test("low below 60%", () => {
    expect(riskBucket(0)).toBe("low");
    expect(riskBucket(0.3)).toBe("low");
    expect(riskBucket(0.599)).toBe("low");
  });

  test("medium 60-85%", () => {
    expect(riskBucket(0.6)).toBe("medium");
    expect(riskBucket(0.7)).toBe("medium");
    expect(riskBucket(0.849)).toBe("medium");
  });

  test("high above 85%", () => {
    expect(riskBucket(0.85)).toBe("high");
    expect(riskBucket(0.95)).toBe("high");
    expect(riskBucket(1.0)).toBe("high");
  });
});

describe("readContextUsage", () => {
  let tmp: string;
  let jsonlPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ctx-usage-test-"));
    jsonlPath = join(tmp, "session.jsonl");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  function makeSessionRef(): SessionRef {
    return {
      projectDir: "-tmp-test",
      sessionId: "00000000-0000-0000-0000-000000000000",
      filePath: jsonlPath,
      sizeBytes: 0,
      modifiedAt: new Date(),
    };
  }

  test("returns null for empty JSONL", async () => {
    await writeFile(jsonlPath, "");
    const usage = await readContextUsage(makeSessionRef());
    expect(usage).toBeNull();
  });

  test("returns null when no assistant event has usage", async () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant" } }), // no usage
    ];
    await writeFile(jsonlPath, lines.join("\n"));
    const usage = await readContextUsage(makeSessionRef());
    expect(usage).toBeNull();
  });

  test("sums all 4 usage fields from latest assistant event (Opus 4.7 = 1M)", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-29T10:00:00Z",
        message: {
          model: "claude-opus-4-7",
          usage: { cache_read_input_tokens: 50_000 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-29T11:00:00Z",
        message: {
          model: "claude-opus-4-7",
          usage: {
            cache_read_input_tokens: 740_000,
            cache_creation_input_tokens: 8_000,
            input_tokens: 1_500,
            output_tokens: 500,
          },
        },
      }),
    ];
    await writeFile(jsonlPath, lines.join("\n"));
    const usage = await readContextUsage(makeSessionRef());
    expect(usage).not.toBeNull();
    expect(usage?.tokensUsed).toBe(750_000); // 740k + 8k + 1.5k + 500 = 750k (latest, not earliest)
    expect(usage?.model).toBe("claude-opus-4-7");
    expect(usage?.contextLimit).toBe(1_000_000); // canonical lookup
    expect(usage?.percentUsed).toBe(0.75);
    expect(usage?.tokensRemaining).toBe(250_000);
    expect(usage?.autocompactRisk).toBe("medium");
    expect(usage?.lastTurnAt).toBe("2026-06-29T11:00:00Z");
  });

  test("CRITICAL: counts cache_creation for fresh / post-clear sessions", async () => {
    // Real-world scenario: jira-transition-head session post-autocompact.
    // cache_read is tiny (cache invalidated), cache_creation is huge (re-filling).
    // Old algorithm (cache_read alone) showed 23k/1M = 2.3% — wildly wrong.
    // Correct: 23,060 + 806,186 + 3,989 + 301 = 833,536 (= 83.4%).
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-30T10:01:22Z",
      message: {
        model: "claude-opus-4-8",
        usage: {
          cache_read_input_tokens: 23_060,
          cache_creation_input_tokens: 806_186,
          input_tokens: 3_989,
          output_tokens: 301,
        },
      },
    });
    await writeFile(jsonlPath, line);
    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.tokensUsed).toBe(833_536);
    expect(usage?.percentUsed).toBeCloseTo(0.834, 2);
    expect(usage?.autocompactRisk).toBe("medium"); // 83.4% → medium
  });

  test("detects [1m] variant", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-29T10:00:00Z",
      message: {
        model: "claude-opus-4-7-[1m]",
        usage: { cache_read_input_tokens: 500_000 },
      },
    });
    await writeFile(jsonlPath, line);
    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.contextLimit).toBe(1_000_000);
    expect(usage?.percentUsed).toBe(0.5);
    expect(usage?.autocompactRisk).toBe("low");
  });

  test("classifies high risk correctly (Haiku 4.5 = 200k)", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-29T10:00:00Z",
      message: {
        model: "claude-haiku-4-5",
        usage: { cache_read_input_tokens: 180_000 },
      },
    });
    await writeFile(jsonlPath, line);
    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.contextLimit).toBe(200_000);
    expect(usage?.tokensUsed).toBe(180_000); // cache_read alone (others 0)
    expect(usage?.percentUsed).toBe(0.9);
    expect(usage?.autocompactRisk).toBe("high");
  });

  test("classifies high risk correctly (Opus 4.7 at 95% of 1M)", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-29T10:00:00Z",
      message: {
        model: "claude-opus-4-7",
        usage: { cache_read_input_tokens: 950_000 },
      },
    });
    await writeFile(jsonlPath, line);
    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.contextLimit).toBe(1_000_000);
    expect(usage?.percentUsed).toBe(0.95);
    expect(usage?.autocompactRisk).toBe("high");
  });

  test("heuristic: tokensUsed > 200k without [1m] tag → assume 1M variant", async () => {
    // Real-world case: model string "claude-opus-4-7" doesn't carry [1m] suffix
    // (it's a session-level setting), but usage clearly exceeds 200k → must be [1m].
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-29T10:00:00Z",
      message: {
        model: "claude-opus-4-7",
        usage: { cache_read_input_tokens: 511_699 },
      },
    });
    await writeFile(jsonlPath, line);
    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.contextLimit).toBe(1_000_000); // heuristic flipped to 1M
    expect(usage?.tokensUsed).toBe(511_699);
    expect(usage?.percentUsed).toBeCloseTo(0.512, 2);
    expect(usage?.autocompactRisk).toBe("low"); // < 60%
  });

  test("ignores user events", async () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: "hi" },
        usage: { cache_read_input_tokens: 99_999 },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-29T10:00:00Z",
        message: {
          model: "claude-opus-4-7",
          usage: { cache_read_input_tokens: 42_000 },
        },
      }),
    ];
    await writeFile(jsonlPath, lines.join("\n"));
    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.tokensUsed).toBe(42_000); // user event's 99_999 ignored
  });

  test("missing usage fields default to 0 (= partial usage object)", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-29T10:00:00Z",
      message: {
        model: "claude-opus-4-7",
        usage: { cache_creation_input_tokens: 500_000 }, // ONLY cache_creation, others missing
      },
    });
    await writeFile(jsonlPath, line);
    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.tokensUsed).toBe(500_000); // missing fields treated as 0
    expect(usage?.percentUsed).toBe(0.5);
  });

  test("returns null for non-existent file", async () => {
    const ref: SessionRef = {
      projectDir: "-nonexistent",
      sessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      filePath: join(tmp, "does-not-exist.jsonl"),
      sizeBytes: 0,
      modifiedAt: new Date(),
    };
    const usage = await readContextUsage(ref);
    expect(usage).toBeNull();
  });
});

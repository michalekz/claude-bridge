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
  test("returns 200k for standard models", () => {
    expect(detectContextLimit("claude-opus-4-7")).toBe(200_000);
    expect(detectContextLimit("claude-sonnet-4-6")).toBe(200_000);
    expect(detectContextLimit("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  test("returns 1M for [1m] variant", () => {
    expect(detectContextLimit("claude-opus-4-7-[1m]")).toBe(1_000_000);
    expect(detectContextLimit("claude-sonnet-4-6-[1m]")).toBe(1_000_000);
    expect(detectContextLimit("[1m]-anywhere-in-name")).toBe(1_000_000);
  });

  test("returns 200k default for null/undefined/empty", () => {
    expect(detectContextLimit(null)).toBe(200_000);
    expect(detectContextLimit(undefined)).toBe(200_000);
    expect(detectContextLimit("")).toBe(200_000);
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

  test("extracts cache_read_input_tokens from latest assistant event", async () => {
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
          usage: { cache_read_input_tokens: 150_000 },
        },
      }),
    ];
    await writeFile(jsonlPath, lines.join("\n"));
    const usage = await readContextUsage(makeSessionRef());
    expect(usage).not.toBeNull();
    expect(usage?.tokensUsed).toBe(150_000); // latest, not earliest
    expect(usage?.model).toBe("claude-opus-4-7");
    expect(usage?.contextLimit).toBe(200_000);
    expect(usage?.percentUsed).toBe(0.75);
    expect(usage?.tokensRemaining).toBe(50_000);
    expect(usage?.autocompactRisk).toBe("medium");
    expect(usage?.lastTurnAt).toBe("2026-06-29T11:00:00Z");
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

  test("classifies high risk correctly", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-29T10:00:00Z",
      message: {
        model: "claude-opus-4-7",
        usage: { cache_read_input_tokens: 180_000 },
      },
    });
    await writeFile(jsonlPath, line);
    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.percentUsed).toBe(0.9);
    expect(usage?.autocompactRisk).toBe("high");
  });

  test("ignores user events", async () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "hi" }, usage: { cache_read_input_tokens: 99_999 } }),
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

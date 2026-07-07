import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock homedir BEFORE importing modules under test so bridgeRoot() (via
// util/paths.ts) resolves to a per-test temp directory. Prevents the real
// ~/.claude-bridge/live/statusline.json from polluting expectations.
// Use vi.hoisted so the mutable holder is available when vi.mock's factory
// (which is itself hoisted to top of file) evaluates — plain `let` at module
// scope is not initialized in time.
const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => homeHolder.current || actual.tmpdir(),
  };
});

import {
  type ContextUsage,
  noLiveDataStatus,
  readContextUsage,
  readContextUsageForSession,
  riskBucket,
} from "../../src/parser/context-usage.ts";
import { type StatusLineLiveEnvelope, writeStatusLineLive } from "../../src/parser/live-data.ts";
import type { SessionRef } from "../../src/parser/session.ts";

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

describe("noLiveDataStatus", () => {
  test("returns placeholder with hasLiveData=false and setup pointer", () => {
    const s = noLiveDataStatus();
    expect(s.hasLiveData).toBe(false);
    expect(s.contextLimitSource).toBe("no-live-data");
    expect(s.contextLimit).toBe(0);
    expect(s.tokensUsed).toBe(0);
    expect(s.autocompactRisk).toBe("unknown");
    expect(s.setupPointer).toBeTruthy();
    expect(s.setupPointer).toMatch(/statusLine/);
  });
});

describe("readContextUsage — live-data-only (v0.9.0)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ctx-usage-v09-test-"));
    homeHolder.current = tmp;
    await mkdir(join(tmp, ".claude-bridge", "live"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    homeHolder.current = "";
  });

  function makeSessionRef(): SessionRef {
    return {
      projectDir: "-tmp-test",
      sessionId: "00000000-0000-0000-0000-000000000000",
      filePath: join(tmp, "session.jsonl"),
      sizeBytes: 0,
      modifiedAt: new Date(),
    };
  }

  test("returns null when no live/statusline.json exists", async () => {
    const usage = await readContextUsage(makeSessionRef());
    expect(usage).toBeNull();
  });

  test("returns null when live file is malformed JSON", async () => {
    await writeFile(join(tmp, ".claude-bridge", "live", "statusline.json"), "{not valid");
    const usage = await readContextUsage(makeSessionRef());
    expect(usage).toBeNull();
  });

  test("returns full usage from live envelope with context_window + used_percentage", async () => {
    const envelope: StatusLineLiveEnvelope = {
      capturedAt: "2026-07-07T12:00:00Z",
      sessionId: "test-session",
      payload: {
        cwd: "/opt/claude-bridge",
        version: "2.1.201",
        model: { display_name: "Claude Fable 5" },
        effort: { level: "high" },
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 25.9,
          current_usage: {
            input_tokens: 3500,
            output_tokens: 500,
            cache_read_input_tokens: 200_000,
            cache_creation_input_tokens: 55_000,
          },
        },
      },
    };
    await writeStatusLineLive(envelope);

    const usage = await readContextUsage(makeSessionRef());
    expect(usage).not.toBeNull();
    const u = usage as ContextUsage;
    expect(u.hasLiveData).toBe(true);
    expect(u.contextLimit).toBe(1_000_000);
    expect(u.contextLimitSource).toBe("statusline-stdin");
    expect(u.tokensUsed).toBe(259_000); // 3500 + 500 + 200_000 + 55_000
    expect(u.percentUsed).toBe(0.259); // from used_percentage directly
    expect(u.tokensRemaining).toBe(741_000);
    expect(u.model).toBe("Claude Fable 5");
    expect(u.effortLevel).toBe("high");
    expect(u.claudeCodeVersion).toBe("2.1.201");
    expect(u.autocompactRisk).toBe("low");
    expect(u.lastTurnAt).toBe("2026-07-07T12:00:00Z");
  });

  test("falls back to token-based percent when used_percentage missing", async () => {
    const envelope: StatusLineLiveEnvelope = {
      capturedAt: "2026-07-07T12:00:00Z",
      sessionId: "test-session",
      payload: {
        model: { display_name: "Sonnet 5" },
        context_window: {
          context_window_size: 200_000,
          // no used_percentage — must compute from tokens
          current_usage: {
            input_tokens: 1_000,
            output_tokens: 200,
            cache_read_input_tokens: 100_000,
            cache_creation_input_tokens: 20_000,
          },
        },
      },
    };
    await writeStatusLineLive(envelope);

    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.tokensUsed).toBe(121_200);
    expect(usage?.percentUsed).toBeCloseTo(0.606, 3);
    expect(usage?.autocompactRisk).toBe("medium");
  });

  test("classifies high risk correctly", async () => {
    const envelope: StatusLineLiveEnvelope = {
      capturedAt: "2026-07-07T12:00:00Z",
      sessionId: "test-session",
      payload: {
        model: { display_name: "Haiku 4.5" },
        context_window: {
          context_window_size: 200_000,
          used_percentage: 90,
          current_usage: {
            cache_read_input_tokens: 180_000,
          },
        },
      },
    };
    await writeStatusLineLive(envelope);

    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.autocompactRisk).toBe("high");
    expect(usage?.percentUsed).toBe(0.9);
  });

  test("effortLevel is null when payload has no effort field (older CC)", async () => {
    const envelope: StatusLineLiveEnvelope = {
      capturedAt: "2026-07-07T12:00:00Z",
      sessionId: "test-session",
      payload: {
        model: { display_name: "Opus 4.7" },
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 10,
          current_usage: { input_tokens: 100_000 },
        },
      },
    };
    await writeStatusLineLive(envelope);

    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.effortLevel).toBeNull();
  });

  test("returns hasLiveData=true with contextLimit=0 when context_window is missing", async () => {
    // Edge case: stdin JSON arrived but before first assistant turn, so
    // context_window is absent. We got the envelope (hasLiveData=true) but
    // no numbers to report. autocompactRisk = "unknown" — no percentage
    // makes sense yet.
    const envelope: StatusLineLiveEnvelope = {
      capturedAt: "2026-07-07T12:00:00Z",
      sessionId: "test-session",
      payload: {
        model: { display_name: "Fable 5" },
      },
    };
    await writeStatusLineLive(envelope);

    const usage = await readContextUsage(makeSessionRef());
    expect(usage?.hasLiveData).toBe(true);
    expect(usage?.contextLimit).toBe(0);
    expect(usage?.tokensUsed).toBe(0);
    expect(usage?.autocompactRisk).toBe("unknown");
    expect(usage?.model).toBe("Fable 5");
  });
});

describe("readContextUsageForSession", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ctx-usage-v09-test-"));
    homeHolder.current = tmp;
    await mkdir(join(tmp, ".claude-bridge", "live"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    homeHolder.current = "";
  });

  test("returns null for empty session list", async () => {
    const usage = await readContextUsageForSession([]);
    expect(usage).toBeNull();
  });

  test("delegates to readContextUsage when session list non-empty", async () => {
    const envelope: StatusLineLiveEnvelope = {
      capturedAt: "2026-07-07T12:00:00Z",
      sessionId: "test-session",
      payload: {
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 10,
          current_usage: { input_tokens: 100_000 },
        },
      },
    };
    await writeStatusLineLive(envelope);

    const ref: SessionRef = {
      projectDir: "-tmp-test",
      sessionId: "00000000-0000-0000-0000-000000000000",
      filePath: join(tmp, "session.jsonl"),
      sizeBytes: 0,
      modifiedAt: new Date(),
    };
    const usage = await readContextUsageForSession([ref]);
    expect(usage?.contextLimit).toBe(1_000_000);
    expect(usage?.contextLimitSource).toBe("statusline-stdin");
  });
});

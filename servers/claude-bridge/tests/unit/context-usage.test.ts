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

  const TEST_SESSION_ID = "test-session";

  function makeSessionRef(): SessionRef {
    return {
      projectDir: "-tmp-test",
      // v0.9.1: sessionRef.sessionId is used to partition per-session
      // reads. Tests use the same id as the envelopes they write below.
      sessionId: TEST_SESSION_ID,
      filePath: join(tmp, "session.jsonl"),
      sizeBytes: 0,
      modifiedAt: new Date(),
    };
  }

  test("returns null when no per-session live file exists", async () => {
    const usage = await readContextUsage(makeSessionRef());
    expect(usage).toBeNull();
  });

  test("returns null when per-session live file is malformed JSON", async () => {
    // v0.9.1 layout: per-session dir. Write a malformed file at the exact
    // path readStatusLineLive(sessionId) would consult.
    await mkdir(join(tmp, ".claude-bridge", "live", "statusline"), { recursive: true });
    await writeFile(
      join(tmp, ".claude-bridge", "live", "statusline", `${TEST_SESSION_ID}.json`),
      "{not valid",
    );
    const usage = await readContextUsage(makeSessionRef());
    expect(usage).toBeNull();
  });

  test("v0.9.1 cross-session isolation — reading sessionA does NOT return sessionB's envelope", async () => {
    // Write sessionB's envelope (would previously have contaminated any
    // caller due to shared file). Ask for sessionA — should be null.
    const envelopeB: StatusLineLiveEnvelope = {
      capturedAt: "2026-07-09T20:00:00Z",
      sessionId: "session-B",
      payload: {
        model: { display_name: "Opus 4.7" },
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 80,
        },
      },
    };
    await writeStatusLineLive(envelopeB);

    // sessionA (= TEST_SESSION_ID) never wrote — should read as null.
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

  test("statusLine envelope without context_window falls through to JSONL — v0.9.4", async () => {
    // Edge case: stdin JSON arrived but before first assistant turn, so
    // context_window is absent. v0.9.4 change: statusLine path returns null
    // (no context_window_size = no usable data), fallback tries JSONL.
    // No JSONL either in this test → readContextUsage returns null,
    // caller wraps with noLiveDataStatus.
    const envelope: StatusLineLiveEnvelope = {
      capturedAt: "2026-07-07T12:00:00Z",
      sessionId: "test-session",
      payload: {
        model: { display_name: "Fable 5" },
      },
    };
    await writeStatusLineLive(envelope);

    const usage = await readContextUsage(makeSessionRef());
    expect(usage).toBeNull(); // both sources dry — no context_window in statusLine, no JSONL
  });
});

describe("readContextUsage — JSONL fallback (v0.9.4)", () => {
  let tmp: string;
  let jsonlPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ctx-usage-v094-test-"));
    homeHolder.current = tmp;
    await mkdir(join(tmp, ".claude-bridge", "live"), { recursive: true });
    jsonlPath = join(tmp, "session.jsonl");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    homeHolder.current = "";
  });

  function makeSessionRefWithJsonl(): SessionRef {
    return {
      projectDir: "-tmp-test",
      sessionId: "test-session",
      filePath: jsonlPath,
      sizeBytes: 0,
      modifiedAt: new Date(),
    };
  }

  test("no statusLine capture + JSONL with known model → jsonl-canonical / canonical-match", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-23T10:00:00Z",
      message: {
        model: "claude-opus-4-7",
        usage: {
          cache_read_input_tokens: 400_000,
          cache_creation_input_tokens: 50_000,
          input_tokens: 3_000,
          output_tokens: 500,
        },
      },
    });
    await writeFile(jsonlPath, line);

    const usage = await readContextUsage(makeSessionRefWithJsonl());
    expect(usage).not.toBeNull();
    expect(usage?.hasLiveData).toBe(true);
    expect(usage?.contextLimitSource).toBe("jsonl-canonical");
    expect(usage?.contextLimitCaveat).toBe("canonical-match");
    expect(usage?.contextLimit).toBe(1_000_000); // Opus 4.7 = 1M
    expect(usage?.tokensUsed).toBe(453_500);
    expect(usage?.percentUsed).toBeCloseTo(0.454, 2);
    expect(usage?.autocompactRisk).toBe("low");
    expect(usage?.model).toBe("claude-opus-4-7");
    expect(usage?.turnInProgress).toBe(false); // last event = assistant, no user after
    expect(usage?.effortLevel).toBeNull(); // JSONL branch, no statusLine data
    expect(usage?.claudeCodeVersion).toBeNull();
  });

  test("JSONL with unknown model + tokens > 200k → jsonl-canonical / empirical-guess-1m", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-23T10:00:00Z",
      message: {
        model: "claude-future-frontier",
        usage: { cache_read_input_tokens: 350_000 },
      },
    });
    await writeFile(jsonlPath, line);

    const usage = await readContextUsage(makeSessionRefWithJsonl());
    expect(usage?.contextLimitSource).toBe("jsonl-canonical");
    expect(usage?.contextLimitCaveat).toBe("empirical-guess-1m");
    expect(usage?.contextLimit).toBe(1_000_000);
    expect(usage?.tokensUsed).toBe(350_000);
  });

  test("JSONL with unknown model + tokens < 200k → jsonl-canonical / unknown-model-default-200k", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-23T10:00:00Z",
      message: {
        model: "claude-future-frontier",
        usage: { cache_read_input_tokens: 50_000 },
      },
    });
    await writeFile(jsonlPath, line);

    const usage = await readContextUsage(makeSessionRefWithJsonl());
    expect(usage?.contextLimitSource).toBe("jsonl-canonical");
    expect(usage?.contextLimitCaveat).toBe("unknown-model-default-200k");
    expect(usage?.contextLimit).toBe(200_000);
  });

  test("turnInProgress=true when last event is user postdating last assistant", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-23T10:00:00Z",
        message: {
          model: "claude-opus-4-7",
          usage: { cache_read_input_tokens: 100_000 },
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-23T10:01:00Z",
        message: { content: "další prompt" },
      }),
    ];
    await writeFile(jsonlPath, lines.join("\n"));

    const usage = await readContextUsage(makeSessionRefWithJsonl());
    expect(usage?.turnInProgress).toBe(true);
    expect(usage?.tokensUsed).toBe(100_000); // last assistant usage — lower bound
  });

  test("statusLine primary wins over JSONL when both present", async () => {
    // Write both — statusLine should take priority.
    await writeStatusLineLive({
      capturedAt: "2026-07-23T10:05:00Z",
      sessionId: "test-session",
      payload: {
        model: { display_name: "Opus 4.7" },
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 30,
          current_usage: { input_tokens: 300_000 },
        },
      },
    });
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-23T10:00:00Z",
      message: {
        model: "claude-opus-4-7",
        usage: { cache_read_input_tokens: 999_999 }, // very different from statusLine
      },
    });
    await writeFile(jsonlPath, line);

    const usage = await readContextUsage(makeSessionRefWithJsonl());
    expect(usage?.contextLimitSource).toBe("statusline-stdin");
    expect(usage?.percentUsed).toBe(0.3); // from statusLine, not JSONL
    expect(usage?.effortLevel).toBeNull(); // no effort in this payload but source is statusLine
  });

  test("returns null when neither source available", async () => {
    // No statusLine capture written, no JSONL either.
    const usage = await readContextUsage(makeSessionRefWithJsonl());
    expect(usage).toBeNull();
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
      // Match the envelope's sessionId so per-session read finds it.
      sessionId: "test-session",
      filePath: join(tmp, "session.jsonl"),
      sizeBytes: 0,
      modifiedAt: new Date(),
    };
    const usage = await readContextUsageForSession([ref]);
    expect(usage?.contextLimit).toBe(1_000_000);
    expect(usage?.contextLimitSource).toBe("statusline-stdin");
  });
});

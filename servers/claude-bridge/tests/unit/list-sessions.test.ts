import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ListSessionsArgs, type ToolResult, listSessionsTool } from "../../src/mcp/tools.ts";

const ORIGINAL_HOME = process.env["HOME"];

let homeDir: string;
let projectDir: string;
let counter = 0;

function uuid(): string {
  counter++;
  const hex = counter.toString(16).padStart(8, "0");
  return `${hex}-0000-0000-0000-000000000000`;
}

interface JsonlEvent {
  type: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: unknown;
  aiTitle?: string;
  customTitle?: string;
}

function userPromptEvent(sessionId: string, ts: string, text: string): JsonlEvent {
  return {
    type: "user",
    uuid: uuid(),
    sessionId,
    timestamp: ts,
    message: { role: "user", content: text },
  };
}

function userToolResultEvent(sessionId: string, ts: string, toolUseId: string): JsonlEvent {
  return {
    type: "user",
    uuid: uuid(),
    sessionId,
    timestamp: ts,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
  };
}

function assistantEndTurnEvent(sessionId: string, ts: string, text: string): JsonlEvent {
  return {
    type: "assistant",
    uuid: uuid(),
    sessionId,
    timestamp: ts,
    message: {
      id: `msg-${counter}`,
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {},
    },
  };
}

function assistantToolUseEvent(sessionId: string, ts: string, toolName: string): JsonlEvent {
  return {
    type: "assistant",
    uuid: uuid(),
    sessionId,
    timestamp: ts,
    message: {
      id: `msg-${counter}`,
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "tool_use", id: `tu-${counter}`, name: toolName, input: {} }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {},
    },
  };
}

function aiTitleEvent(sessionId: string, title: string): JsonlEvent {
  return { type: "ai-title", sessionId, aiTitle: title };
}

async function writeSession(sessionId: string, events: JsonlEvent[]): Promise<string> {
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(filePath, `${lines}\n`, "utf-8");
  return filePath;
}

async function writeHeartbeat(sessionId: string, ageSeconds: number): Promise<void> {
  const statusDir = join(homeDir, ".claude-bridge", "status");
  await mkdir(statusDir, { recursive: true });
  const path = join(statusDir, `${sessionId}.json`);
  await writeFile(path, JSON.stringify({ id: sessionId, lastSeen: new Date().toISOString() }));
  if (ageSeconds > 0) {
    const { utimes } = await import("node:fs/promises");
    const old = new Date(Date.now() - ageSeconds * 1000);
    await utimes(path, old, old);
  }
}

async function callList(args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = ListSessionsArgs.parse(args);
  return listSessionsTool(parsed);
}

function parseResult(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("list_sessions enhancement", () => {
  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "claude-bridge-list-sessions-"));
    process.env["HOME"] = homeDir;
    projectDir = join(homeDir, ".claude", "projects", "-opt-test");
    await mkdir(projectDir, { recursive: true });
  });

  afterAll(async () => {
    if (ORIGINAL_HOME !== undefined) process.env["HOME"] = ORIGINAL_HOME;
    // biome-ignore lint/performance/noDelete: coercing to "undefined" string would corrupt other tests
    else delete process.env["HOME"];
    await rm(homeDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await mkdir(projectDir, { recursive: true });
    await rm(join(homeDir, ".claude-bridge"), { recursive: true, force: true });
  });

  test("default returns metadata + active flag (no event counts)", async () => {
    const sid = uuid();
    await writeSession(sid, [userPromptEvent(sid, "2026-01-01T10:00:00Z", "hi")]);
    await writeHeartbeat(sid, 0); // fresh heartbeat

    const result = await callList({});
    const payload = parseResult(result);
    const sessions = payload["sessions"] as Array<Record<string, unknown>>;
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.["active"]).toBe(true);
    // includeMeta=false → no aiTitle/userPrompts/assistantReplies
    expect(sessions[0]?.["aiTitle"]).toBeUndefined();
    expect(sessions[0]?.["userPrompts"]).toBeUndefined();
    expect(sessions[0]?.["assistantReplies"]).toBeUndefined();
  });

  test("active flag: heartbeat older than 30s → inactive", async () => {
    const sid = uuid();
    await writeSession(sid, [userPromptEvent(sid, "2026-01-01T10:00:00Z", "hi")]);
    await writeHeartbeat(sid, 120); // 2 minutes old

    const result = await callList({});
    const payload = parseResult(result);
    const sessions = payload["sessions"] as Array<Record<string, unknown>>;
    expect(sessions[0]?.["active"]).toBe(false);
  });

  test("active flag: no heartbeat → inactive", async () => {
    const sid = uuid();
    await writeSession(sid, [userPromptEvent(sid, "2026-01-01T10:00:00Z", "hi")]);
    // no writeHeartbeat call

    const result = await callList({});
    const payload = parseResult(result);
    const sessions = payload["sessions"] as Array<Record<string, unknown>>;
    expect(sessions[0]?.["active"]).toBe(false);
  });

  test("includeActive: false skips heartbeat check entirely", async () => {
    const sid = uuid();
    await writeSession(sid, [userPromptEvent(sid, "2026-01-01T10:00:00Z", "hi")]);
    await writeHeartbeat(sid, 0);

    const result = await callList({ includeActive: false });
    const payload = parseResult(result);
    const sessions = payload["sessions"] as Array<Record<string, unknown>>;
    expect(sessions[0]?.["active"]).toBeUndefined();
  });

  test("includeMeta: true populates aiTitle, userPrompts, assistantReplies", async () => {
    const sid = uuid();
    await writeSession(sid, [
      aiTitleEvent(sid, "Important Discussion"),
      userPromptEvent(sid, "2026-01-01T10:00:00Z", "real prompt 1"),
      assistantToolUseEvent(sid, "2026-01-01T10:01:00Z", "Read"), // not a reply
      userToolResultEvent(sid, "2026-01-01T10:02:00Z", "tu-x"), // not a real prompt
      assistantEndTurnEvent(sid, "2026-01-01T10:03:00Z", "first reply"), // counts as reply
      userPromptEvent(sid, "2026-01-01T10:04:00Z", "real prompt 2"),
      assistantEndTurnEvent(sid, "2026-01-01T10:05:00Z", "second reply"),
    ]);

    const result = await callList({ includeMeta: true });
    const payload = parseResult(result);
    const sessions = payload["sessions"] as Array<Record<string, unknown>>;
    expect(sessions[0]?.["aiTitle"]).toBe("Important Discussion");
    expect(sessions[0]?.["userPrompts"]).toBe(2);
    expect(sessions[0]?.["assistantReplies"]).toBe(2);
  });

  test("includeMeta: tool_result wrappers are NOT counted as user prompts", async () => {
    const sid = uuid();
    await writeSession(sid, [
      userPromptEvent(sid, "2026-01-01T10:00:00Z", "real prompt"),
      // 5 tool result wrappers — should NOT inflate userPrompts
      userToolResultEvent(sid, "2026-01-01T10:01:00Z", "tu-1"),
      userToolResultEvent(sid, "2026-01-01T10:02:00Z", "tu-2"),
      userToolResultEvent(sid, "2026-01-01T10:03:00Z", "tu-3"),
      userToolResultEvent(sid, "2026-01-01T10:04:00Z", "tu-4"),
      userToolResultEvent(sid, "2026-01-01T10:05:00Z", "tu-5"),
    ]);

    const result = await callList({ includeMeta: true });
    const payload = parseResult(result);
    const sessions = payload["sessions"] as Array<Record<string, unknown>>;
    expect(sessions[0]?.["userPrompts"]).toBe(1);
  });

  test("includeMeta: assistant events with stop_reason='tool_use' are NOT counted as replies", async () => {
    const sid = uuid();
    await writeSession(sid, [
      userPromptEvent(sid, "2026-01-01T10:00:00Z", "ask"),
      assistantToolUseEvent(sid, "2026-01-01T10:01:00Z", "Read"),
      assistantToolUseEvent(sid, "2026-01-01T10:02:00Z", "Edit"),
      assistantToolUseEvent(sid, "2026-01-01T10:03:00Z", "Bash"),
      assistantEndTurnEvent(sid, "2026-01-01T10:04:00Z", "done"),
    ]);

    const result = await callList({ includeMeta: true });
    const payload = parseResult(result);
    const sessions = payload["sessions"] as Array<Record<string, unknown>>;
    expect(sessions[0]?.["assistantReplies"]).toBe(1);
  });

  test("includeMeta: last ai-title wins (re-titled session)", async () => {
    const sid = uuid();
    await writeSession(sid, [
      aiTitleEvent(sid, "Initial title"),
      userPromptEvent(sid, "2026-01-01T10:00:00Z", "msg"),
      aiTitleEvent(sid, "Refined title"),
      assistantEndTurnEvent(sid, "2026-01-01T10:01:00Z", "reply"),
      aiTitleEvent(sid, "Final title"),
    ]);

    const result = await callList({ includeMeta: true });
    const payload = parseResult(result);
    const sessions = payload["sessions"] as Array<Record<string, unknown>>;
    expect(sessions[0]?.["aiTitle"]).toBe("Final title");
  });

  test("includeMeta: session with no ai-title returns aiTitle=null", async () => {
    const sid = uuid();
    await writeSession(sid, [
      userPromptEvent(sid, "2026-01-01T10:00:00Z", "untitled"),
      assistantEndTurnEvent(sid, "2026-01-01T10:01:00Z", "reply"),
    ]);

    const result = await callList({ includeMeta: true });
    const payload = parseResult(result);
    const sessions = payload["sessions"] as Array<Record<string, unknown>>;
    expect(sessions[0]?.["aiTitle"]).toBeNull();
  });

  test("project filter restricts to one project dir", async () => {
    // Create second project
    const projectBDir = join(homeDir, ".claude", "projects", "-opt-other");
    await mkdir(projectBDir, { recursive: true });
    const sidA = uuid();
    const sidB = uuid();
    await writeSession(sidA, [userPromptEvent(sidA, "2026-01-01T10:00:00Z", "in A")]);
    await writeFile(
      join(projectBDir, `${sidB}.jsonl`),
      `${JSON.stringify(userPromptEvent(sidB, "2026-01-01T10:00:00Z", "in B"))}\n`,
    );

    const resultA = await callList({ project: "-opt-test" });
    const payloadA = parseResult(resultA);
    expect((payloadA["sessions"] as unknown[]).length).toBe(1);

    const resultB = await callList({ project: "-opt-other" });
    const payloadB = parseResult(resultB);
    expect((payloadB["sessions"] as unknown[]).length).toBe(1);
  });

  test("limit caps returned session count", async () => {
    for (let i = 0; i < 5; i++) {
      const sid = uuid();
      await writeSession(sid, [userPromptEvent(sid, "2026-01-01T10:00:00Z", `s${i}`)]);
    }
    const result = await callList({ limit: 3 });
    const payload = parseResult(result);
    expect((payload["sessions"] as unknown[]).length).toBe(3);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type ServerContext, buildContext } from "../../src/mcp/context.ts";
import { PeerChatReadArgs, type ToolResult, peerChatReadTool } from "../../src/mcp/tools.ts";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"]; // Windows: os.homedir() reads this, not HOME

let homeDir: string;
let baseDir: string;
let projectDir: string;
let counter = 0;

function uuid(): string {
  counter++;
  const hex = counter.toString(16).padStart(8, "0");
  return `${hex}-0000-0000-0000-000000000000`;
}

async function makeContext(name: string): Promise<ServerContext> {
  return buildContext({
    identity: { id: uuid(), name, displayName: name, source: "env" },
    baseDir,
    withHeartbeat: false,
    emitTerminalTitle: false,
    version: "0.0.1-test",
    nameRefreshIntervalMs: 0,
  });
}

async function registerPeer(ctx: ServerContext): Promise<void> {
  await ctx.registry.startHeartbeat({
    id: ctx.self.id,
    name: ctx.self.name,
    displayName: ctx.self.displayName,
    pid: 1,
    source: ctx.self.source,
    cwd: "/opt/test",
  });
}

interface JsonlEvent {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  userType?: string;
  entrypoint?: string;
  isSidechain?: boolean;
  message?: unknown;
}

function userEvent(sessionId: string, timestamp: string, text: string): JsonlEvent {
  return {
    type: "user",
    uuid: uuid(),
    parentUuid: null,
    sessionId,
    timestamp,
    cwd: "/opt/test",
    gitBranch: "main",
    version: "2.1.145",
    userType: "external",
    entrypoint: "cli",
    isSidechain: false,
    message: { role: "user", content: text },
  };
}

function assistantEvent(
  sessionId: string,
  timestamp: string,
  content: Array<{ type: string; [k: string]: unknown }>,
): JsonlEvent {
  return {
    type: "assistant",
    uuid: uuid(),
    parentUuid: null,
    sessionId,
    timestamp,
    cwd: "/opt/test",
    gitBranch: "main",
    version: "2.1.145",
    userType: "external",
    entrypoint: "cli",
    isSidechain: false,
    message: {
      id: `msg-${counter}`,
      role: "assistant",
      model: "claude-opus-4-7",
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {},
    },
  };
}

async function writeSession(sessionId: string, events: JsonlEvent[]): Promise<void> {
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(filePath, `${lines}\n`, "utf-8");
}

function parseResult(result: ToolResult): { ok: boolean; payload: Record<string, unknown> } {
  expect(result.content.length).toBeGreaterThan(0);
  const first = result.content[0];
  if (!first) throw new Error("empty content");
  const payload = JSON.parse(first.text) as Record<string, unknown>;
  return { ok: !result.isError && payload["ok"] === true, payload };
}

/** Default tests use JSON format (parseable). Format-specific tests pass overrides. */
async function callRead(ctx: ServerContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = PeerChatReadArgs.parse({ format: "json", ...args });
  return peerChatReadTool(ctx, parsed);
}

async function callReadRaw(ctx: ServerContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = PeerChatReadArgs.parse(args);
  return peerChatReadTool(ctx, parsed);
}

describe("peer_chat_read", () => {
  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "claude-bridge-chat-read-home-"));
    baseDir = join(homeDir, ".claude-bridge");
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir; // Windows os.homedir() resolution
    projectDir = join(homeDir, ".claude", "projects", "-opt-test");
    await mkdir(projectDir, { recursive: true });
  });

  afterAll(async () => {
    // Restore HOME + USERPROFILE — using delete here is correct (assignment to
    // undefined would coerce to the string "undefined" and break subsequent tests).
    if (ORIGINAL_HOME !== undefined) {
      process.env["HOME"] = ORIGINAL_HOME;
    } else {
      // biome-ignore lint/performance/noDelete: undefined assignment would coerce to "undefined"
      delete process.env["HOME"];
    }
    if (ORIGINAL_USERPROFILE !== undefined) {
      process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    } else {
      // biome-ignore lint/performance/noDelete: undefined assignment would coerce to "undefined"
      delete process.env["USERPROFILE"];
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(baseDir, "inbox"), { recursive: true, force: true });
    await rm(join(baseDir, "status"), { recursive: true, force: true });
  });

  test("default returns last 10 messages, text only, drops thinking + tool_use", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    const events: JsonlEvent[] = [];
    for (let i = 0; i < 15; i++) {
      const ts = `2026-01-01T10:${i.toString().padStart(2, "0")}:00Z`;
      if (i % 2 === 0) events.push(userEvent(peer.self.id, ts, `user msg ${i}`));
      else
        events.push(
          assistantEvent(peer.self.id, ts, [{ type: "text", text: `assistant msg ${i}` }]),
        );
    }
    await writeSession(peer.self.id, events);

    const result = await callRead(me, { to: "peer" });
    const { ok, payload } = parseResult(result);
    expect(ok).toBe(true);
    expect(payload["returnedCount"]).toBe(10);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(10);
    // Last 10 of 15 events (indices 5..14)
    expect(messages[0]?.["text"]).toBe("assistant msg 5");
    expect(messages[9]?.["text"]).toBe("user msg 14");
    const truncated = payload["truncated"] as Record<string, unknown>;
    expect(truncated["byLastN"]).toBe(true);
    expect(truncated["byBytes"]).toBe(false);
  });

  test("lastN respects custom value", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    const events: JsonlEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(userEvent(peer.self.id, `2026-01-01T10:0${i}:00Z`, `msg ${i}`));
    }
    await writeSession(peer.self.id, events);

    const result = await callRead(me, { to: "peer", lastN: 3 });
    const { payload } = parseResult(result);
    expect(payload["returnedCount"]).toBe(3);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["text"]).toBe("msg 2");
    expect(messages[2]?.["text"]).toBe("msg 4");
  });

  test("sinceTimestamp filters out older events", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    const events: JsonlEvent[] = [
      userEvent(peer.self.id, "2026-01-01T09:00:00Z", "old"),
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "boundary"),
      userEvent(peer.self.id, "2026-01-01T11:00:00Z", "new"),
    ];
    await writeSession(peer.self.id, events);

    const result = await callRead(me, {
      to: "peer",
      sinceTimestamp: "2026-01-01T10:00:00Z",
    });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    expect(messages[0]?.["text"]).toBe("boundary");
    expect(messages[1]?.["text"]).toBe("new");
  });

  test("rolesOnly:['user'] returns prompt-only view", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    const events: JsonlEvent[] = [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "prompt 1"),
      assistantEvent(peer.self.id, "2026-01-01T10:01:00Z", [{ type: "text", text: "response 1" }]),
      userEvent(peer.self.id, "2026-01-01T10:02:00Z", "prompt 2"),
    ];
    await writeSession(peer.self.id, events);

    const result = await callRead(me, { to: "peer", rolesOnly: ["user"] });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    expect(messages.every((m) => m["role"] === "user")).toBe(true);
  });

  test("includeThinking + includeToolCalls expose them", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    const events: JsonlEvent[] = [
      assistantEvent(peer.self.id, "2026-01-01T10:00:00Z", [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "text" },
        { type: "tool_use", id: "tu_1", name: "Read", input: { path: "/x" } },
      ]),
    ];
    await writeSession(peer.self.id, events);

    const result = await callRead(me, {
      to: "peer",
      includeThinking: true,
      includeToolCalls: true,
    });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["thinking"]).toBe("hmm");
    const calls = messages[0]?.["toolCalls"] as Array<Record<string, unknown>>;
    expect(calls.length).toBe(1);
    expect(calls[0]?.["name"]).toBe("Read");
  });

  test("maxBytes truncates oldest first", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    const big = "x".repeat(200);
    const events: JsonlEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(userEvent(peer.self.id, `2026-01-01T10:0${i}:00Z`, `${big}_${i}`));
    }
    await writeSession(peer.self.id, events);

    const result = await callRead(me, { to: "peer", lastN: 100, maxBytes: 1000 });
    const { payload } = parseResult(result);
    const truncated = payload["truncated"] as Record<string, unknown>;
    expect(truncated["byBytes"]).toBe(true);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBeLessThan(10);
    const lastMsg = messages[messages.length - 1];
    expect((lastMsg?.["text"] as string).endsWith("_9")).toBe(true);
  });

  test("peer_not_found when name unknown and crossProject:false", async () => {
    const me = await makeContext("me");
    await registerPeer(me);

    const result = await callRead(me, { to: "ghost" });
    expect(result.isError).toBe(true);
    expect(parseResult(result).payload["code"]).toBe("peer_not_found");
  });

  test("crossProject:true reads any session by UUID", async () => {
    const me = await makeContext("me");
    await registerPeer(me);

    const deadId = uuid();
    await writeSession(deadId, [userEvent(deadId, "2026-01-01T10:00:00Z", "ghost text")]);

    const result = await callRead(me, { to: deadId, crossProject: true });
    const { ok, payload } = parseResult(result);
    expect(ok).toBe(true);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["text"]).toBe("ghost text");
  });

  test("self_read when target is self id or name", async () => {
    const me = await makeContext("me");
    await registerPeer(me);

    const byName = await callRead(me, { to: "me" });
    expect(byName.isError).toBe(true);
    expect(parseResult(byName).payload["code"]).toBe("self_read");

    const byId = await callRead(me, { to: me.self.id });
    expect(byId.isError).toBe(true);
    expect(parseResult(byId).payload["code"]).toBe("self_read");
  });

  test("invalid_timestamp on unparseable sinceTimestamp", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);
    await writeSession(peer.self.id, [userEvent(peer.self.id, "2026-01-01T10:00:00Z", "x")]);

    const result = await callRead(me, { to: "peer", sinceTimestamp: "not-a-date" });
    expect(result.isError).toBe(true);
    expect(parseResult(result).payload["code"]).toBe("invalid_timestamp");
  });

  test("format:markdown (default) returns readable transcript", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "hello"),
      assistantEvent(peer.self.id, "2026-01-01T10:01:00Z", [{ type: "text", text: "world" }]),
    ]);

    // No format → markdown default
    const result = await callReadRaw(me, { to: "peer" });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("# Peer chat: peer");
    expect(text).toContain("**Session:**");
    expect(text).toContain("## [10:00:00] user");
    expect(text).toContain("hello");
    expect(text).toContain("## [10:01:00] assistant");
    expect(text).toContain("world");
    // Not JSON
    expect(() => JSON.parse(text)).toThrow();
  });

  test("format:compact returns one-line-per-message summary", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "first message text"),
      userEvent(peer.self.id, "2026-01-01T10:01:00Z", "second"),
    ]);

    const result = await callReadRaw(me, { to: "peer", format: "compact" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("peer: peer");
    expect(text).toContain("[10:00:00] U");
    expect(text).toContain("first message text");
    expect(text).toContain("[10:01:00] U");
    expect(text).toContain("second");
  });

  test("compact truncates long text at ~180 chars", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    const longText = "x".repeat(300);
    await writeSession(peer.self.id, [userEvent(peer.self.id, "2026-01-01T10:00:00Z", longText)]);

    const result = await callReadRaw(me, { to: "peer", format: "compact" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("…");
    // The line should not contain the full 300-char string
    expect(text.length).toBeLessThan(longText.length + 200);
  });

  test("markdown includes thinking + toolCalls when flags set", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    await writeSession(peer.self.id, [
      assistantEvent(peer.self.id, "2026-01-01T10:00:00Z", [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "visible answer" },
        { type: "tool_use", id: "tu_long_id_1", name: "Read", input: { path: "/x" } },
      ]),
    ]);

    const result = await callReadRaw(me, {
      to: "peer",
      includeThinking: true,
      includeToolCalls: true,
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("### thinking");
    expect(text).toContain("secret reasoning");
    expect(text).toContain("### tool_calls");
    expect(text).toContain("**Read**");
    expect(text).toContain('{"path":"/x"}');
  });

  test("strips <ide_opened_file>, <ide_selection>, <system-reminder> tags from user text", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    const noisyContent =
      "<ide_opened_file>/some/file.ts</ide_opened_file>\nReal message here.\n<system-reminder>nag nag</system-reminder>\nMore real text.";
    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", noisyContent),
    ]);

    const result = await callRead(me, { to: "peer" });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    const text = messages[0]?.["text"] as string;
    expect(text).not.toContain("ide_opened_file");
    expect(text).not.toContain("system-reminder");
    expect(text).toContain("Real message here.");
    expect(text).toContain("More real text.");
  });

  test("aiTitle from session JSONL fills peer header when name is null (cross-project)", async () => {
    const me = await makeContext("me");
    await registerPeer(me);

    const deadId = uuid();
    const aiTitleEvent: JsonlEvent = {
      type: "ai-title",
      sessionId: deadId,
      message: undefined,
    };
    // Add aiTitle field by extending the event (passthrough allows it)
    const extendedEvent = { ...aiTitleEvent, aiTitle: "Old Forgotten Chat" };
    await writeSession(deadId, [
      extendedEvent as JsonlEvent,
      userEvent(deadId, "2026-01-01T10:00:00Z", "hello from old chat"),
    ]);

    const result = await callReadRaw(me, { to: deadId, crossProject: true, format: "markdown" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("# Peer chat: Old Forgotten Chat");
    expect(text).not.toContain("(no name)");
  });

  test("sinceLastUserPrompt returns messages from most recent user turn onward", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "first prompt"),
      assistantEvent(peer.self.id, "2026-01-01T10:01:00Z", [{ type: "text", text: "first reply" }]),
      userEvent(peer.self.id, "2026-01-01T10:02:00Z", "second prompt"),
      assistantEvent(peer.self.id, "2026-01-01T10:03:00Z", [
        { type: "text", text: "second reply" },
      ]),
      userEvent(peer.self.id, "2026-01-01T10:04:00Z", "LATEST prompt"),
      assistantEvent(peer.self.id, "2026-01-01T10:05:00Z", [
        { type: "text", text: "latest reply" },
      ]),
    ]);

    const result = await callRead(me, { to: "peer", sinceLastUserPrompt: true });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    expect(messages[0]?.["text"]).toBe("LATEST prompt");
    expect(messages[1]?.["text"]).toBe("latest reply");
    const truncated = payload["truncated"] as Record<string, unknown>;
    expect(truncated["bySinceLastUserPrompt"]).toBe(true);
  });

  test("tool_use input + tool_result content truncated above 500 chars", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    const hugeBlob = "A".repeat(2000);
    await writeSession(peer.self.id, [
      assistantEvent(peer.self.id, "2026-01-01T10:00:00Z", [
        { type: "tool_use", id: "tu_1", name: "Read", input: { contents: hugeBlob } },
      ]),
    ]);

    const result = await callRead(me, { to: "peer", includeToolCalls: true });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    const calls = messages[0]?.["toolCalls"] as Array<Record<string, unknown>>;
    const inputStr = JSON.stringify(calls[0]?.["input"]);
    expect(inputStr.length).toBeLessThan(700);
    expect(inputStr).toContain("more chars");
  });

  test("query filters to messages containing substring (case-insensitive)", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "talking about Agent Teams"),
      userEvent(peer.self.id, "2026-01-01T10:01:00Z", "now talking about something else"),
      assistantEvent(peer.self.id, "2026-01-01T10:02:00Z", [
        { type: "text", text: "AGENT TEAMS feature flag exists" },
      ]),
      userEvent(peer.self.id, "2026-01-01T10:03:00Z", "completely unrelated"),
    ]);

    const result = await callRead(me, { to: "peer", query: "agent teams" });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    expect(messages[0]?.["text"]).toContain("Agent Teams");
    expect(messages[1]?.["text"]).toContain("AGENT TEAMS");
    const scanned = payload["scanned"] as Record<string, unknown>;
    expect(scanned["queryMatches"]).toBe(2);
  });

  test("queryRegex: true uses regex pattern matching", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "msg 42"),
      userEvent(peer.self.id, "2026-01-01T10:01:00Z", "msg 100"),
      userEvent(peer.self.id, "2026-01-01T10:02:00Z", "msg abc"),
    ]);

    const result = await callRead(me, {
      to: "peer",
      query: "msg \\d+",
      queryRegex: true,
    });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    expect(messages[0]?.["text"]).toBe("msg 42");
    expect(messages[1]?.["text"]).toBe("msg 100");
  });

  test("invalid_query_regex on bad pattern", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);
    await writeSession(peer.self.id, [userEvent(peer.self.id, "2026-01-01T10:00:00Z", "x")]);

    const result = await callRead(me, {
      to: "peer",
      query: "[unclosed",
      queryRegex: true,
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result).payload["code"]).toBe("invalid_query_regex");
  });

  test("contextLines includes ±N neighbors around each match", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "alpha"),
      userEvent(peer.self.id, "2026-01-01T10:01:00Z", "beta"),
      userEvent(peer.self.id, "2026-01-01T10:02:00Z", "TARGET"),
      userEvent(peer.self.id, "2026-01-01T10:03:00Z", "gamma"),
      userEvent(peer.self.id, "2026-01-01T10:04:00Z", "delta"),
    ]);

    const result = await callRead(me, {
      to: "peer",
      query: "TARGET",
      contextLines: 1,
    });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(3);
    expect(messages[0]?.["text"]).toBe("beta");
    expect(messages[1]?.["text"]).toBe("TARGET");
    expect(messages[2]?.["text"]).toBe("gamma");
  });

  test("query with no matches returns empty result, queryMatches: 0", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);
    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "nothing relevant"),
    ]);

    const result = await callRead(me, { to: "peer", query: "ghost text" });
    const { payload } = parseResult(result);
    expect(payload["returnedCount"]).toBe(0);
    const scanned = payload["scanned"] as Record<string, unknown>;
    expect(scanned["queryMatches"]).toBe(0);
  });

  test("query combines with sinceLastUserPrompt (search within recent slice only)", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);

    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "TARGET in old context"),
      assistantEvent(peer.self.id, "2026-01-01T10:01:00Z", [{ type: "text", text: "reply 1" }]),
      userEvent(peer.self.id, "2026-01-01T10:02:00Z", "newer user prompt"),
      assistantEvent(peer.self.id, "2026-01-01T10:03:00Z", [
        { type: "text", text: "reply with TARGET word" },
      ]),
    ]);

    const result = await callRead(me, {
      to: "peer",
      sinceLastUserPrompt: true,
      query: "TARGET",
    });
    const { payload } = parseResult(result);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.["text"]).toContain("reply with TARGET");
    // The older TARGET (before last user prompt) is filtered out by anchor
  });

  test("markdown header shows query metadata when query is set", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);
    await writeSession(peer.self.id, [
      userEvent(peer.self.id, "2026-01-01T10:00:00Z", "hello world"),
    ]);

    const result = await callReadRaw(me, { to: "peer", query: "hello" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("**Query:** `hello`");
    expect(text).toContain("substring");
    expect(text).toContain("1 matches");
  });

  test("json format produces compact JSON (no pretty-print)", async () => {
    const me = await makeContext("me");
    const peer = await makeContext("peer");
    await registerPeer(me);
    await registerPeer(peer);
    await writeSession(peer.self.id, [userEvent(peer.self.id, "2026-01-01T10:00:00Z", "hi")]);

    const result = await callReadRaw(me, { to: "peer", format: "json" });
    const text = result.content[0]?.text ?? "";
    // No 2-space indent — no "\n  " sequences
    expect(text).not.toMatch(/\n {2}/);
    // Parses as JSON
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

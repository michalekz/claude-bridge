import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type ServerContext, buildContext } from "../../src/mcp/context.ts";
import { PeerChatSearchArgs, type ToolResult, peerChatSearchTool } from "../../src/mcp/tools.ts";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"]; // Windows: os.homedir() reads this, not HOME
const ORIGINAL_CWD_FN = process.cwd;

let homeDir: string;
let baseDir: string;
let projectADir: string; // current project (= mocked process.cwd())
let projectBDir: string; // another project (only visible with all-projects)
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
  aiTitle?: string;
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

function assistantEvent(sessionId: string, timestamp: string, text: string): JsonlEvent {
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
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {},
    },
  };
}

function aiTitleEvent(sessionId: string, title: string): JsonlEvent {
  return { type: "ai-title", sessionId, aiTitle: title };
}

async function writeSession(
  projectDir: string,
  sessionId: string,
  events: JsonlEvent[],
  mtime?: Date,
): Promise<string> {
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(filePath, `${lines}\n`, "utf-8");
  if (mtime) {
    const { utimes } = await import("node:fs/promises");
    await utimes(filePath, mtime, mtime);
  }
  return filePath;
}

async function callSearch(ctx: ServerContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = PeerChatSearchArgs.parse(args);
  return peerChatSearchTool(ctx, parsed);
}

describe("peer_chat_search", () => {
  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "claude-bridge-search-home-"));
    baseDir = join(homeDir, ".claude-bridge");
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir; // Windows os.homedir() resolution
    // Two projects in the encoded form
    projectADir = join(homeDir, ".claude", "projects", "-opt-project-a");
    projectBDir = join(homeDir, ".claude", "projects", "-opt-project-b");
    await mkdir(projectADir, { recursive: true });
    await mkdir(projectBDir, { recursive: true });

    // Mock process.cwd() so scope='project' resolves to project A
    process.cwd = () => "/opt/project-a";
  });

  afterAll(async () => {
    if (ORIGINAL_HOME !== undefined) process.env["HOME"] = ORIGINAL_HOME;
    // biome-ignore lint/performance/noDelete: undefined coerces to "undefined"
    else delete process.env["HOME"];
    if (ORIGINAL_USERPROFILE !== undefined) process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    // biome-ignore lint/performance/noDelete: undefined coerces to "undefined"
    else delete process.env["USERPROFILE"];
    process.cwd = ORIGINAL_CWD_FN;
    await rm(homeDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean projects between tests
    await rm(projectADir, { recursive: true, force: true });
    await rm(projectBDir, { recursive: true, force: true });
    await mkdir(projectADir, { recursive: true });
    await mkdir(projectBDir, { recursive: true });
  });

  test("scope='project' searches current project sessions, excludes self", async () => {
    const me = await makeContext("me");
    const peerSessionId = uuid();
    await writeSession(projectADir, peerSessionId, [
      aiTitleEvent(peerSessionId, "Project A peer chat"),
      userEvent(peerSessionId, "2026-05-25T10:00:00Z", "talking about agent teams"),
      assistantEvent(peerSessionId, "2026-05-25T10:01:00Z", "yes agent teams are nice"),
      userEvent(peerSessionId, "2026-05-25T10:02:00Z", "unrelated message"),
    ]);
    // Self's own session — should NOT be searched
    await writeSession(projectADir, me.self.id, [
      userEvent(me.self.id, "2026-05-25T10:05:00Z", "agent teams in my own chat"),
    ]);

    const result = await callSearch(me, { query: "agent teams" });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Project A peer chat");
    expect(text).toContain("agent teams are nice");
    expect(text).toContain("← match");
    // Self session must be excluded
    expect(text).not.toContain("agent teams in my own chat");
  });

  test("scope='project' does NOT scan other projects", async () => {
    const me = await makeContext("me");
    const a = uuid();
    const b = uuid();
    await writeSession(projectADir, a, [
      userEvent(a, "2026-05-25T10:00:00Z", "UNIQUE_TOKEN found in A"),
    ]);
    await writeSession(projectBDir, b, [
      userEvent(b, "2026-05-25T10:00:00Z", "UNIQUE_TOKEN found in B"),
    ]);

    const result = await callSearch(me, { query: "UNIQUE_TOKEN" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("UNIQUE_TOKEN found in A");
    expect(text).not.toContain("UNIQUE_TOKEN found in B");
  });

  test("scope='all-projects' works without any env gate (v0.4.1+)", async () => {
    // v0.4.0 had CLAUDE_BRIDGE_ALLOW_ALL_PROJECTS env gate. Removed in v0.4.1 —
    // agent already has FS read access, gate added friction without security value.
    const me = await makeContext("me");
    const a = uuid();
    await writeSession(projectADir, a, [userEvent(a, "2026-05-25T10:00:00Z", "anything")]);

    const result = await callSearch(me, { query: "anything", scope: "all-projects" });
    expect(result.isError).toBeFalsy();
  });

  test("scope='all-projects' finds matches in other projects", async () => {
    const me = await makeContext("me");
    const a = uuid();
    const b = uuid();
    await writeSession(projectADir, a, [
      userEvent(a, "2026-05-25T10:00:00Z", "alpha in project A"),
    ]);
    await writeSession(projectBDir, b, [
      userEvent(b, "2026-05-25T10:00:00Z", "alpha in project B"),
    ]);

    const result = await callSearch(me, { query: "alpha", scope: "all-projects" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("alpha in project A");
    expect(text).toContain("alpha in project B");
  });

  test("maxAgeDays filter excludes old sessions (hardcoded 30 days)", async () => {
    const me = await makeContext("me");
    const oldId = uuid();
    const newId = uuid();
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

    await writeSession(
      projectADir,
      oldId,
      [userEvent(oldId, "2025-01-01T10:00:00Z", "old TOKEN here")],
      oldDate,
    );
    await writeSession(
      projectADir,
      newId,
      [userEvent(newId, "2026-05-25T10:00:00Z", "new TOKEN here")],
      newDate,
    );

    const result = await callSearch(me, { query: "TOKEN" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("new TOKEN here");
    expect(text).not.toContain("old TOKEN here");
  });

  test("queryRegex: true uses regex matching", async () => {
    const me = await makeContext("me");
    const s = uuid();
    await writeSession(projectADir, s, [
      userEvent(s, "2026-05-25T10:00:00Z", "version 1.2.3"),
      userEvent(s, "2026-05-25T10:01:00Z", "no version here"),
      userEvent(s, "2026-05-25T10:02:00Z", "version 4.5"),
    ]);

    const result = await callSearch(me, {
      query: "version \\d+\\.\\d+\\.\\d+",
      queryRegex: true,
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("version 1.2.3");
    // 4.5 doesn't match \d+\.\d+\.\d+ (no patch number)
    expect(text).not.toContain("version 4.5");
  });

  test("contextLines includes surrounding messages around match", async () => {
    const me = await makeContext("me");
    const s = uuid();
    await writeSession(projectADir, s, [
      userEvent(s, "2026-05-25T10:00:00Z", "before context"),
      userEvent(s, "2026-05-25T10:01:00Z", "TARGET message"),
      userEvent(s, "2026-05-25T10:02:00Z", "after context"),
    ]);

    const result = await callSearch(me, { query: "TARGET", contextLines: 1 });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("before context");
    expect(text).toContain("TARGET message");
    expect(text).toContain("after context");
    expect(text).toContain("(context)");
  });

  test("maxMatches caps result + reports truncation", async () => {
    const me = await makeContext("me");
    const s = uuid();
    const events: JsonlEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(userEvent(s, `2026-05-25T10:${i.toString().padStart(2, "0")}:00Z`, `MATCH ${i}`));
    }
    await writeSession(projectADir, s, events);

    const result = await callSearch(me, { query: "MATCH", maxMatches: 5 });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(truncated at maxMatches)");
    // First 5 matches kept, rest dropped
    expect(text).toContain("MATCH 0");
    expect(text).toContain("MATCH 4");
    expect(text).not.toContain("MATCH 19");
  });

  test("invalid_query_regex on bad pattern", async () => {
    const me = await makeContext("me");
    await writeSession(projectADir, uuid(), [
      userEvent(uuid(), "2026-05-25T10:00:00Z", "anything"),
    ]);

    const result = await callSearch(me, { query: "[unclosed", queryRegex: true });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}")["code"]).toBe("invalid_query_regex");
  });

  test("no matches in scope returns clean empty-result message", async () => {
    const me = await makeContext("me");
    const s = uuid();
    await writeSession(projectADir, s, [
      userEvent(s, "2026-05-25T10:00:00Z", "totally unrelated content"),
    ]);

    const result = await callSearch(me, { query: "GHOST_QUERY" });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("0 matches");
    expect(text).toContain("No matches found");
  });

  test("ai-title surfaces in markdown header per session", async () => {
    const me = await makeContext("me");
    const s = uuid();
    await writeSession(projectADir, s, [
      aiTitleEvent(s, "Important Discussion About Architecture"),
      userEvent(s, "2026-05-25T10:00:00Z", "architecture matters"),
    ]);

    const result = await callSearch(me, { query: "architecture" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Important Discussion About Architecture");
  });

  test("substring match is case-insensitive by default", async () => {
    const me = await makeContext("me");
    const s = uuid();
    await writeSession(projectADir, s, [
      userEvent(s, "2026-05-25T10:00:00Z", "AGENT TEAMS in caps"),
      userEvent(s, "2026-05-25T10:01:00Z", "agent teams lowercase"),
    ]);

    const result = await callSearch(me, { query: "Agent Teams" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("AGENT TEAMS in caps");
    expect(text).toContain("agent teams lowercase");
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ENV_PEER_NAME,
  IdentityError,
  readLatestTitleFromJsonl,
  readSessionJsonAt,
  resolvePeerIdentity,
  resolvePeerIdentityWithRetry,
  resolvePeerName,
  sanitizePeerName,
  slugFromCwd,
} from "../../src/identity.ts";
import { encodeProjectDir } from "../../src/util/paths.ts";

describe("sanitizePeerName", () => {
  test("accepts simple lowercase", () => {
    expect(sanitizePeerName("mantis")).toBe("mantis");
  });

  test("lowercases input", () => {
    expect(sanitizePeerName("Mantis")).toBe("mantis");
  });

  test("converts spaces to dashes", () => {
    expect(sanitizePeerName("my peer name")).toBe("my-peer-name");
  });

  test("replaces invalid chars", () => {
    expect(sanitizePeerName("foo/bar:baz")).toBe("foo-bar-baz");
  });

  test("collapses consecutive dashes", () => {
    expect(sanitizePeerName("foo---bar")).toBe("foo-bar");
  });

  test("trims edge dashes", () => {
    expect(sanitizePeerName("-foo-")).toBe("foo");
  });

  test("trims edge dots", () => {
    expect(sanitizePeerName(".foo.")).toBe("foo");
  });

  test("rejects empty after sanitization", () => {
    expect(sanitizePeerName("///")).toBeNull();
    expect(sanitizePeerName("   ")).toBeNull();
  });

  test("truncates over 64 chars", () => {
    const long = "a".repeat(100);
    const result = sanitizePeerName(long);
    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(64);
  });

  test("handles realistic Claude Code title", () => {
    expect(sanitizePeerName("Build MCP server for Claude Code chat integration")).toBe(
      "build-mcp-server-for-claude-code-chat-integration",
    );
  });

  test("preserves dots and underscores", () => {
    expect(sanitizePeerName("foo.bar_baz")).toBe("foo.bar_baz");
  });
});

describe("slugFromCwd", () => {
  test("Linux path", () => {
    expect(slugFromCwd("/opt/my-project")).toBe("my-project");
  });

  test("Linux deep path", () => {
    expect(slugFromCwd("/home/user/projects/my-app")).toBe("my-app");
  });

  test("trailing slash", () => {
    expect(slugFromCwd("/opt/my-project/")).toBe("my-project");
  });

  test("uppercase", () => {
    expect(slugFromCwd("/Users/Me/MyProject")).toBe("myproject");
  });

  test("root path", () => {
    expect(slugFromCwd("/")).toBe("root");
  });
});

describe("resolvePeerIdentity — requires session.json with sessionId", () => {
  let tmp: string;
  const SESSION_ID = "1873a793-e924-4b39-b39c-89d50e394a82";

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "claude-bridge-identity-"));
    await mkdir(join(tmp, ".claude", "sessions"), { recursive: true });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeSessionJson(ppid: number, body: Record<string, unknown>): Promise<void> {
    await writeFile(
      join(tmp, ".claude", "sessions", `${ppid}.json`),
      JSON.stringify({ pid: ppid, ...body }),
    );
  }

  async function writeJsonlEvents(sessionId: string, cwd: string, events: object[]): Promise<void> {
    const encoded = encodeProjectDir(cwd);
    const dir = join(tmp, ".claude", "projects", encoded);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n"),
    );
  }

  test("throws IdentityError when session.json is missing", async () => {
    await expect(
      resolvePeerIdentity({ ppid: 111111, home: tmp, cwd: "/opt/foo", env: {} }),
    ).rejects.toThrow(IdentityError);
  });

  test("throws IdentityError when session.json missing sessionId", async () => {
    await writeSessionJson(111112, { cwd: "/opt/foo" });
    await expect(
      resolvePeerIdentity({ ppid: 111112, home: tmp, cwd: "/opt/foo", env: {} }),
    ).rejects.toThrow(IdentityError);
  });

  test("D fallback: cwd-slug when no JSONL title, no .name, no env", async () => {
    await writeSessionJson(111113, { sessionId: SESSION_ID, cwd: "/opt/my-project" });
    const result = await resolvePeerIdentity({
      ppid: 111113,
      home: tmp,
      cwd: "/opt/my-project",
      env: {},
    });
    expect(result.id).toBe(SESSION_ID);
    expect(result.name).toBe("my-project");
    expect(result.source).toBe("cwd-slug");
  });

  test("C: env override beats cwd-slug", async () => {
    await writeSessionJson(111114, { sessionId: SESSION_ID, cwd: "/opt/my-project" });
    const result = await resolvePeerIdentity({
      ppid: 111114,
      home: tmp,
      cwd: "/opt/my-project",
      env: { [ENV_PEER_NAME]: "Override Name" },
    });
    expect(result.name).toBe("override-name");
    expect(result.source).toBe("env");
  });

  test("B: session.json .name beats env + cwd-slug", async () => {
    const ppid = 111115;
    await writeSessionJson(ppid, { sessionId: SESSION_ID, cwd: "/opt/my-project", name: "Mantis" });
    const result = await resolvePeerIdentity({
      ppid,
      home: tmp,
      cwd: "/opt/my-project",
      env: { [ENV_PEER_NAME]: "Override" },
    });
    expect(result.name).toBe("mantis");
    expect(result.source).toBe("session-json-name");
  });

  test("A: JSONL ai-title beats session.json .name (Claude Code populates ai-title automatically)", async () => {
    const ppid = 111116;
    const sessionId = "00000000-0000-0000-0000-000000000001";
    const cwd = "/opt/my-project-a";
    await writeSessionJson(ppid, { sessionId, cwd, name: "ManualName" });
    await writeJsonlEvents(sessionId, cwd, [
      { type: "ai-title", aiTitle: "Explore MCP server claude-bridge", sessionId },
    ]);

    const result = await resolvePeerIdentity({ ppid, home: tmp, cwd, env: {} });
    expect(result.id).toBe(sessionId);
    expect(result.name).toBe("explore-mcp-server-claude-bridge");
    expect(result.source).toBe("jsonl-title");
  });

  test("A: custom-title in JSONL wins over ai-title (user-set override)", async () => {
    const ppid = 111117;
    const sessionId = "00000000-0000-0000-0000-000000000002";
    const cwd = "/opt/proj-b";
    await writeSessionJson(ppid, { sessionId, cwd });
    await writeJsonlEvents(sessionId, cwd, [
      { type: "ai-title", aiTitle: "AI Title", sessionId },
      { type: "custom-title", customTitle: "Custom Title", sessionId },
    ]);

    const result = await resolvePeerIdentity({ ppid, home: tmp, cwd, env: {} });
    expect(result.name).toBe("custom-title");
  });

  test("A: picks LATEST title (not the first occurrence)", async () => {
    const ppid = 111118;
    const sessionId = "00000000-0000-0000-0000-000000000003";
    const cwd = "/opt/proj-c";
    await writeSessionJson(ppid, { sessionId, cwd });
    await writeJsonlEvents(sessionId, cwd, [
      { type: "custom-title", customTitle: "Old", sessionId },
      { type: "custom-title", customTitle: "Newer", sessionId },
      { type: "custom-title", customTitle: "Latest", sessionId },
    ]);

    const result = await resolvePeerIdentity({ ppid, home: tmp, cwd, env: {} });
    expect(result.name).toBe("latest");
  });

  test("displayName preserves raw title from JSONL (no slugify)", async () => {
    const ppid = 211116;
    const sessionId = "00000000-0000-0000-0000-0000000000d1";
    const cwd = "/opt/proj-display";
    await writeSessionJson(ppid, { sessionId, cwd });
    await writeJsonlEvents(sessionId, cwd, [
      { type: "ai-title", aiTitle: "Restore missing chat history for project", sessionId },
    ]);

    const result = await resolvePeerIdentity({ ppid, home: tmp, cwd, env: {} });
    expect(result.name).toBe("restore-missing-chat-history-for-project");
    expect(result.displayName).toBe("Restore missing chat history for project");
  });

  test("displayName for session-json-name source = raw .name field", async () => {
    const ppid = 211117;
    const cwd = "/opt/proj-disp-sj";
    await writeSessionJson(ppid, { sessionId: SESSION_ID, cwd, name: "My Custom Chat" });

    const result = await resolvePeerIdentity({ ppid, home: tmp, cwd, env: {} });
    expect(result.name).toBe("my-custom-chat");
    expect(result.displayName).toBe("My Custom Chat");
    expect(result.source).toBe("session-json-name");
  });

  test("displayName for env source = raw env value", async () => {
    const ppid = 211118;
    const cwd = "/opt/proj-disp-env";
    await writeSessionJson(ppid, { sessionId: SESSION_ID, cwd });

    const result = await resolvePeerIdentity({
      ppid,
      home: tmp,
      cwd,
      env: { [ENV_PEER_NAME]: "Orchestrator Lead" },
    });
    expect(result.name).toBe("orchestrator-lead");
    expect(result.displayName).toBe("Orchestrator Lead");
  });

  test("displayName for cwd-slug source defaults to slug (no raw available)", async () => {
    const ppid = 211119;
    const cwd = "/opt/some-project";
    await writeSessionJson(ppid, { sessionId: SESSION_ID, cwd });

    const result = await resolvePeerIdentity({ ppid, home: tmp, cwd, env: {} });
    expect(result.name).toBe("some-project");
    expect(result.displayName).toBe("some-project");
    expect(result.source).toBe("cwd-slug");
  });

  test("id is always sessionId regardless of cascade source", async () => {
    const ppid = 111119;
    const cwd = "/opt/proj-d";
    await writeSessionJson(ppid, { sessionId: SESSION_ID, cwd });
    const result = await resolvePeerIdentity({ ppid, home: tmp, cwd, env: {} });
    expect(result.id).toBe(SESSION_ID);
  });
});

describe("resolvePeerIdentityWithRetry — cold-boot race condition", () => {
  let tmp: string;
  const SESSION_ID = "11111111-2222-3333-4444-555555555555";

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "claude-bridge-identity-retry-"));
    await mkdir(join(tmp, ".claude", "sessions"), { recursive: true });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("succeeds on first attempt when session.json already present", async () => {
    const ppid = 411111;
    await writeFile(
      join(tmp, ".claude", "sessions", `${ppid}.json`),
      JSON.stringify({ pid: ppid, sessionId: SESSION_ID, cwd: "/opt/retry-fast" }),
    );
    const result = await resolvePeerIdentityWithRetry({
      ppid,
      home: tmp,
      cwd: "/opt/retry-fast",
      env: {},
      retryDelays: [10, 20, 40],
    });
    expect(result.id).toBe(SESSION_ID);
    expect(result.name).toBe("retry-fast");
  });

  test("succeeds after session.json appears mid-retry (cold-boot race)", async () => {
    const ppid = 411112;
    const cwd = "/opt/retry-late";
    // Schedule session.json creation after the second retry delay (~30 ms)
    setTimeout(() => {
      void writeFile(
        join(tmp, ".claude", "sessions", `${ppid}.json`),
        JSON.stringify({ pid: ppid, sessionId: SESSION_ID, cwd }),
      );
    }, 30);

    const result = await resolvePeerIdentityWithRetry({
      ppid,
      home: tmp,
      cwd,
      env: {},
      retryDelays: [10, 20, 40, 80, 160],
    });
    expect(result.id).toBe(SESSION_ID);
    expect(result.name).toBe("retry-late");
  });

  test("throws after exhausting all retries", async () => {
    await expect(
      resolvePeerIdentityWithRetry({
        ppid: 411113,
        home: tmp,
        cwd: "/opt/never",
        env: {},
        retryDelays: [1, 1, 1],
      }),
    ).rejects.toThrow(IdentityError);
  });

  test("retryDelays: [] disables retry (single attempt)", async () => {
    const start = Date.now();
    await expect(
      resolvePeerIdentityWithRetry({
        ppid: 411114,
        home: tmp,
        cwd: "/opt/no-retry",
        env: {},
        retryDelays: [],
      }),
    ).rejects.toThrow(IdentityError);
    // Should fail fast — no sleeps
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("resolvePeerName (legacy shim — backwards compat)", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "claude-bridge-identity-legacy-"));
    await mkdir(join(tmp, ".claude", "sessions"), { recursive: true });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("returns {name, source} when session.json valid", async () => {
    const ppid = 222222;
    await writeFile(
      join(tmp, ".claude", "sessions", `${ppid}.json`),
      JSON.stringify({ pid: ppid, sessionId: "00000000-0000-0000-0000-000000000099" }),
    );
    const result = await resolvePeerName({ ppid, home: tmp, cwd: "/opt/legacy", env: {} });
    expect(result.name).toBe("legacy");
    expect(result.source).toBe("cwd-slug");
  });

  test("throws on missing session.json (no silent fallback)", async () => {
    await expect(
      resolvePeerName({ ppid: 333333, home: tmp, cwd: "/opt/foo", env: {} }),
    ).rejects.toThrow(IdentityError);
  });
});

describe("readSessionJsonAt", () => {
  test("returns null for non-existent", async () => {
    expect(await readSessionJsonAt("/non/existent/path.json")).toBeNull();
  });
});

describe("readLatestTitleFromJsonl", () => {
  test("returns null for non-existent", async () => {
    expect(await readLatestTitleFromJsonl("/non/existent/file.jsonl")).toBeNull();
  });
});

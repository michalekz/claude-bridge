import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateMessageId } from "../../src/inbox/store.ts";
import {
  type ServerContext,
  buildContext,
  refreshIdentityNow,
  shutdownContext,
} from "../../src/mcp/context.ts";
import { encodeProjectDir } from "../../src/util/paths.ts";

/**
 * Simulates the VS Code Claude Code boot race: session.json briefly has a
 * different sessionId at boot, then settles on the real one after --resume
 * kicks in. The MCP server must catch this on the next refresh and migrate.
 */

describe("identity migration (id-change recovery)", () => {
  let bridgeBase: string;
  let homeBase: string;
  const PPID = 444444;
  const OLD_ID = "00000000-0000-0000-0000-000000000aaa";
  const NEW_ID = "11111111-1111-1111-1111-111111111bbb";

  beforeEach(async () => {
    bridgeBase = await mkdtemp(join(tmpdir(), "claude-bridge-mig-bridge-"));
    homeBase = await mkdtemp(join(tmpdir(), "claude-bridge-mig-home-"));
    await mkdir(join(homeBase, ".claude", "sessions"), { recursive: true });
  });

  afterEach(async () => {
    await rm(bridgeBase, { recursive: true, force: true });
    await rm(homeBase, { recursive: true, force: true });
  });

  async function writeSessionJson(sessionId: string): Promise<void> {
    await writeFile(
      join(homeBase, ".claude", "sessions", `${PPID}.json`),
      JSON.stringify({ pid: PPID, sessionId, cwd: "/opt/test-cwd" }),
    );
  }

  async function startCtx(): Promise<ServerContext> {
    return buildContext({
      baseDir: bridgeBase,
      identityOptions: { ppid: PPID, home: homeBase, cwd: "/opt/test-cwd", env: {} },
      nameRefreshIntervalMs: 0, // disable auto, drive manually
      emitTerminalTitle: false,
      version: "test",
    });
  }

  test("when session.json sessionId changes, ctx.self.id migrates to new value", async () => {
    await writeSessionJson(OLD_ID);
    const ctx = await startCtx();
    expect(ctx.self.id).toBe(OLD_ID);

    await writeSessionJson(NEW_ID);
    await refreshIdentityNow(ctx, { ppid: PPID, home: homeBase, cwd: "/opt/test-cwd", env: {} });

    expect(ctx.self.id).toBe(NEW_ID);

    await shutdownContext(ctx);
  });

  test("heartbeat file migrates from <oldId>.json to <newId>.json", async () => {
    await writeSessionJson(OLD_ID);
    const ctx = await startCtx();

    const oldHb = join(bridgeBase, "status", `${OLD_ID}.json`);
    expect((await stat(oldHb)).isFile()).toBe(true);

    await writeSessionJson(NEW_ID);
    await refreshIdentityNow(ctx, { ppid: PPID, home: homeBase, cwd: "/opt/test-cwd", env: {} });

    await expect(stat(oldHb)).rejects.toThrow();
    const newHb = join(bridgeBase, "status", `${NEW_ID}.json`);
    const content = JSON.parse(await readFile(newHb, "utf-8"));
    expect(content.id).toBe(NEW_ID);

    await shutdownContext(ctx);
  });

  test("inbox dir migrates from <oldId> to <newId> preserving pending messages", async () => {
    await writeSessionJson(OLD_ID);
    const ctx = await startCtx();

    // Simulate a peer sending to OLD_ID before we noticed
    const oldPending = join(bridgeBase, "inbox", OLD_ID, "pending");
    await mkdir(oldPending, { recursive: true });
    const msgId = generateMessageId();
    await writeFile(
      join(oldPending, `${msgId}.json`),
      JSON.stringify({
        id: msgId,
        from: "33333333-3333-3333-3333-333333333333",
        fromName: "ghost-sender",
        to: OLD_ID,
        kind: "ask",
        sentAt: new Date().toISOString(),
        content: "pre-migration message",
      }),
    );

    await writeSessionJson(NEW_ID);
    await refreshIdentityNow(ctx, { ppid: PPID, home: homeBase, cwd: "/opt/test-cwd", env: {} });

    // Old dir should be gone
    await expect(stat(oldPending)).rejects.toThrow();

    // Message should now be under NEW_ID
    const newPending = await ctx.inbox.listPending(NEW_ID);
    expect(newPending.length).toBe(1);
    expect(newPending[0]?.id).toBe(msgId);
    expect(newPending[0]?.content).toBe("pre-migration message");

    await shutdownContext(ctx);
  });

  test("name-only change (same id) updates name without migration", async () => {
    await writeSessionJson(OLD_ID);
    const ctx = await startCtx();
    const initialName = ctx.self.name;
    expect(ctx.self.source).toBe("cwd-slug");

    // Write JSONL ai-title for the same sessionId
    const encoded = encodeProjectDir("/opt/test-cwd");
    const jsonlDir = join(homeBase, ".claude", "projects", encoded);
    await mkdir(jsonlDir, { recursive: true });
    await writeFile(
      join(jsonlDir, `${OLD_ID}.jsonl`),
      JSON.stringify({ type: "ai-title", aiTitle: "Refreshed Title", sessionId: OLD_ID }),
    );

    await refreshIdentityNow(ctx, { ppid: PPID, home: homeBase, cwd: "/opt/test-cwd", env: {} });

    expect(ctx.self.id).toBe(OLD_ID);
    expect(ctx.self.name).toBe("refreshed-title");
    expect(ctx.self.name).not.toBe(initialName);
    expect(ctx.self.source).toBe("jsonl-title");

    // Old heartbeat file should still exist (id unchanged)
    expect((await stat(join(bridgeBase, "status", `${OLD_ID}.json`))).isFile()).toBe(true);

    await shutdownContext(ctx);
  });

  test("session.json disappearing after boot keeps current identity (no crash)", async () => {
    await writeSessionJson(OLD_ID);
    const ctx = await startCtx();

    await rm(join(homeBase, ".claude", "sessions", `${PPID}.json`));
    await refreshIdentityNow(ctx, { ppid: PPID, home: homeBase, cwd: "/opt/test-cwd", env: {} });

    // Should NOT throw, ctx.self should remain at OLD_ID
    expect(ctx.self.id).toBe(OLD_ID);

    await shutdownContext(ctx);
  });
});

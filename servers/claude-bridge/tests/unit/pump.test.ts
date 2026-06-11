import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createChannelSender } from "../../src/mcp/channel.ts";
import { type ServerContext, buildContext, pumpInboxToChannel } from "../../src/mcp/context.ts";
import { peerAskTool } from "../../src/mcp/tools.ts";

interface PushLog {
  id: string;
  from: string;
  content: string;
}

function fakeServerCapturing(log: PushLog[], shouldFail = false) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: stub
    async notification(n: any) {
      if (shouldFail) throw new Error("channel unavailable");
      log.push({
        id: n.params.meta.msgId,
        from: n.params.meta.from,
        content: n.params.content,
      });
    },
  };
}

let counter = 0;
function makeId(label: string): string {
  counter++;
  return `${label.slice(0, 7).padEnd(7, "0")}${counter}-0000-0000-0000-000000000000`.slice(0, 36);
}

async function mkCtx(baseDir: string, name: string, id?: string): Promise<ServerContext> {
  return buildContext({
    identity: { id: id ?? makeId(name), name, displayName: name, source: "env" },
    baseDir,
    withHeartbeat: false,
    emitTerminalTitle: false,
    version: "test",
    nameRefreshIntervalMs: 0,
  });
}

async function register(ctx: ServerContext): Promise<void> {
  await ctx.registry.startHeartbeat({
    id: ctx.self.id,
    name: ctx.self.name,
    pid: 1,
    source: ctx.self.source,
  });
}

describe("pumpInboxToChannel", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "claude-bridge-pump-"));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(baseDir, "inbox"), { recursive: true, force: true });
    await rm(join(baseDir, "status"), { recursive: true, force: true });
  });

  test("no-op when channel is null", async () => {
    const ctx = await mkCtx(baseDir, "alice");
    const { pushed } = await pumpInboxToChannel(ctx);
    expect(pushed).toBe(0);
  });

  test("pushes all pending and KEEPS them in pending (piggyback drains later)", async () => {
    const coord = await mkCtx(baseDir, "coordinator");
    const mantis = await mkCtx(baseDir, "mantis");
    await register(coord);
    await register(mantis);

    await peerAskTool(coord, { to: "mantis", content: "ping 1" });
    await peerAskTool(coord, { to: "mantis", content: "ping 2" });

    const log: PushLog[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: stub
    mantis.channel = createChannelSender(fakeServerCapturing(log) as any);

    const { pushed } = await pumpInboxToChannel(mantis);
    expect(pushed).toBe(2);
    expect(log.length).toBe(2);
    // v0.2.5: push doesn't consume — pending stays so piggyback can drain.
    // Claude Code may have dropped the channel notification silently; piggyback
    // is the only mechanism that's guaranteed to inject into agent context.
    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(2);
    expect((await mantis.inbox.listDone(mantis.self.id)).length).toBe(0);
  });

  test("dedup: pumping twice on same pending only pushes each msg once", async () => {
    const coord = await mkCtx(baseDir, "coordinator");
    const mantis = await mkCtx(baseDir, "mantis");
    await register(coord);
    await register(mantis);

    await peerAskTool(coord, { to: "mantis", content: "ping" });

    const log: PushLog[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: stub
    mantis.channel = createChannelSender(fakeServerCapturing(log) as any);

    const first = await pumpInboxToChannel(mantis);
    const second = await pumpInboxToChannel(mantis);

    expect(first.pushed).toBe(1);
    expect(second.pushed).toBe(0); // dedup via pushedMsgIds
    expect(log.length).toBe(1);
  });

  test("leaves messages in pending on channel failure (graceful)", async () => {
    const coord = await mkCtx(baseDir, "coordinator");
    const mantis = await mkCtx(baseDir, "mantis");
    await register(coord);
    await register(mantis);

    await peerAskTool(coord, { to: "mantis", content: "ping" });

    // biome-ignore lint/suspicious/noExplicitAny: stub
    mantis.channel = createChannelSender(fakeServerCapturing([], true) as any);

    const { pushed } = await pumpInboxToChannel(mantis);
    expect(pushed).toBe(0);
    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(1);
  });

  test("pushes only own peer's pending (isolation by id)", async () => {
    const coord = await mkCtx(baseDir, "coordinator");
    const alice = await mkCtx(baseDir, "alice");
    const bob = await mkCtx(baseDir, "bob");
    await register(coord);
    await register(alice);
    await register(bob);

    await peerAskTool(coord, { to: "alice", content: "for alice" });
    await peerAskTool(coord, { to: "bob", content: "for bob" });

    const log: PushLog[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: stub
    alice.channel = createChannelSender(fakeServerCapturing(log) as any);

    const { pushed } = await pumpInboxToChannel(alice);
    expect(pushed).toBe(1);
    expect(log[0]?.content).toContain("for alice");
    expect(await alice.inbox.countPending(bob.self.id)).toBe(1);
  });

  test("preserves order (chronological) when pushing batch", async () => {
    const coord = await mkCtx(baseDir, "coordinator");
    const mantis = await mkCtx(baseDir, "mantis");
    await register(coord);
    await register(mantis);

    await peerAskTool(coord, { to: "mantis", content: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await peerAskTool(coord, { to: "mantis", content: "second" });
    await new Promise((r) => setTimeout(r, 5));
    await peerAskTool(coord, { to: "mantis", content: "third" });

    const log: PushLog[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: stub
    mantis.channel = createChannelSender(fakeServerCapturing(log) as any);

    await pumpInboxToChannel(mantis);

    expect(log.map((l) => l.content.match(/first|second|third/)?.[0])).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

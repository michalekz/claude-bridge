import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type ServerContext, buildContext } from "../../src/mcp/context.ts";
import {
  type ToolResult,
  peerAskTool,
  peerInboxReadTool,
  peerListTool,
  peerReplyTool,
  piggybackInbox,
} from "../../src/mcp/tools.ts";

let peerCounter = 0;
function makeId(name: string): string {
  peerCounter++;
  return `${name}-${peerCounter.toString(16).padStart(4, "0")}-0000-0000-0000-000000000000`;
}

async function makeContext(baseDir: string, name: string, id?: string): Promise<ServerContext> {
  return buildContext({
    identity: { id: id ?? makeId(name), name, displayName: name, source: "env" },
    baseDir,
    withHeartbeat: false,
    version: "0.0.1-test",
    nameRefreshIntervalMs: 0,
  });
}

/** Make peer A's heartbeat visible to B and vice versa — write to registry. */
async function registerInRegistry(...peers: ServerContext[]): Promise<void> {
  for (const p of peers) {
    await p.registry.startHeartbeat({
      id: p.self.id,
      name: p.self.name,
      displayName: p.self.displayName,
      pid: 1,
      source: p.self.source,
    });
  }
}

function parseResult(result: ToolResult): { ok: boolean; payload: Record<string, unknown> } {
  expect(result.content.length).toBeGreaterThan(0);
  const first = result.content[0];
  if (!first) throw new Error("empty content");
  const payload = JSON.parse(first.text) as Record<string, unknown>;
  return { ok: !result.isError && payload["ok"] === true, payload };
}

describe("peer_list tool", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "claude-bridge-peer-list-"));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test("returns self id + name + displayName in response", async () => {
    const ctx = await makeContext(baseDir, "alice");
    const result = await peerListTool(ctx);
    const { ok, payload } = parseResult(result);
    expect(ok).toBe(true);
    const self = payload["self"] as Record<string, string>;
    expect(self["name"]).toBe("alice");
    expect(self["displayName"]).toBe("alice");
    expect(self["id"]).toBe(ctx.self.id);
  });

  test("each peer in list exposes displayName (falls back to name if absent)", async () => {
    const me = await makeContext(baseDir, "me");
    const other = await buildContext({
      identity: {
        id: makeId("other"),
        name: "other-slug",
        displayName: "Other Pretty Name",
        source: "jsonl-title",
      },
      baseDir,
      withHeartbeat: false,
      nameRefreshIntervalMs: 0,
    });
    await registerInRegistry(me, other);

    const result = await peerListTool(me);
    const { payload } = parseResult(result);
    const peers = payload["peers"] as Array<Record<string, unknown>>;

    const found = peers.find((p) => p["id"] === other.self.id);
    expect(found).toBeDefined();
    expect(found?.["name"]).toBe("other-slug");
    expect(found?.["displayName"]).toBe("Other Pretty Name");
  });
});

describe("peer_ask + peer_inbox_read", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "claude-bridge-peer-ask-"));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(baseDir, "inbox"), { recursive: true, force: true });
    await rm(join(baseDir, "status"), { recursive: true, force: true });
  });

  test("peer_ask resolves name → id, writes to recipient inbox; read drains", async () => {
    const coordinator = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coordinator, mantis);

    const askResult = await peerAskTool(coordinator, {
      to: "mantis",
      content: "kolik je open ticketů?",
    });
    const { ok: askOk, payload: askPayload } = parseResult(askResult);
    expect(askOk).toBe(true);
    const msgId = askPayload["msgId"] as string;
    const toRef = askPayload["to"] as { id: string; name: string };
    expect(toRef.id).toBe(mantis.self.id);
    expect(toRef.name).toBe("mantis");

    const readResult = await peerInboxReadTool(mantis);
    const { ok: readOk, payload: readPayload } = parseResult(readResult);
    expect(readOk).toBe(true);
    expect(readPayload["count"]).toBe(1);
    const messages = readPayload["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["id"]).toBe(msgId);
    expect(messages[0]?.["from"]).toBe(coordinator.self.id);
    expect(messages[0]?.["fromName"]).toBe("coordinator");
    expect(messages[0]?.["content"]).toBe("kolik je open ticketů?");
  });

  test("peer_ask accepts id directly (no name lookup)", async () => {
    const coordinator = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coordinator, mantis);

    const result = await peerAskTool(coordinator, {
      to: mantis.self.id,
      content: "by id",
    });
    expect(parseResult(result).ok).toBe(true);

    const read = await peerInboxReadTool(mantis);
    const msgs = parseResult(read).payload["messages"] as Array<Record<string, unknown>>;
    expect(msgs[0]?.["content"]).toBe("by id");
  });

  test("peer_ask returns ambiguous_peer when name matches 2+ peers", async () => {
    const coordinator = await makeContext(baseDir, "coordinator");
    const twin1 = await makeContext(baseDir, "twin");
    const twin2 = await makeContext(baseDir, "twin");
    await registerInRegistry(coordinator, twin1, twin2);

    const result = await peerAskTool(coordinator, { to: "twin", content: "hi" });
    expect(result.isError).toBe(true);
    const { payload } = parseResult(result);
    expect(payload["code"]).toBe("ambiguous_peer");
    const candidates = payload["details"] as Array<Record<string, string>>;
    expect(candidates.length).toBe(2);
  });

  test("peer_ask returns peer_not_found when unknown", async () => {
    const ctx = await makeContext(baseDir, "alone");
    await registerInRegistry(ctx);
    const result = await peerAskTool(ctx, { to: "ghost", content: "?" });
    expect(result.isError).toBe(true);
    expect(parseResult(result).payload["code"]).toBe("peer_not_found");
  });

  test("peer_ask rejects sending to self (by name or id)", async () => {
    const ctx = await makeContext(baseDir, "alice");
    await registerInRegistry(ctx);

    const byName = await peerAskTool(ctx, { to: "alice", content: "ping" });
    expect(byName.isError).toBe(true);
    expect(parseResult(byName).payload["code"]).toBe("self_send");

    const byId = await peerAskTool(ctx, { to: ctx.self.id, content: "ping" });
    expect(byId.isError).toBe(true);
    expect(parseResult(byId).payload["code"]).toBe("self_send");
  });

  test("peer_ask preserves threadId", async () => {
    const ctx = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(ctx, mantis);

    const result = await peerAskTool(ctx, {
      to: "mantis",
      content: "ping",
      threadId: "thread-42",
    });
    expect(parseResult(result).ok).toBe(true);

    const read = await peerInboxReadTool(mantis);
    const { payload } = parseResult(read);
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["threadId"]).toBe("thread-42");
  });

  test("peer_inbox_read returns empty when nothing pending", async () => {
    const ctx = await makeContext(baseDir, "lonely");
    const result = await peerInboxReadTool(ctx);
    const { ok, payload } = parseResult(result);
    expect(ok).toBe(true);
    expect(payload["count"]).toBe(0);
  });
});

describe("peer_reply (correlation via inReplyTo + done/)", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "claude-bridge-peer-reply-"));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(baseDir, "inbox"), { recursive: true, force: true });
    await rm(join(baseDir, "status"), { recursive: true, force: true });
  });

  test("reply finds original in done/ and sends back to original sender id", async () => {
    const coordinator = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coordinator, mantis);

    const ask = await peerAskTool(coordinator, { to: "mantis", content: "ping" });
    const askMsgId = parseResult(ask).payload["msgId"] as string;

    await peerInboxReadTool(mantis);

    const reply = await peerReplyTool(mantis, { inReplyTo: askMsgId, content: "pong" });
    const { ok, payload } = parseResult(reply);
    expect(ok).toBe(true);
    const toRef = payload["to"] as { id: string; name: string };
    expect(toRef.id).toBe(coordinator.self.id);
    expect(toRef.name).toBe("coordinator");
    expect(payload["inReplyTo"]).toBe(askMsgId);

    const incoming = await peerInboxReadTool(coordinator);
    const messages = parseResult(incoming).payload["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.["from"]).toBe(mantis.self.id);
    expect(messages[0]?.["fromName"]).toBe("mantis");
    expect(messages[0]?.["content"]).toBe("pong");
    expect(messages[0]?.["inReplyTo"]).toBe(askMsgId);
    expect(messages[0]?.["kind"]).toBe("reply");
  });

  test("reply fails when original not in done/ (not consumed yet)", async () => {
    const ctx = await makeContext(baseDir, "mantis");
    const result = await peerReplyTool(ctx, {
      inReplyTo: "nonexistent-msg-id",
      content: "ghost reply",
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result).payload["code"]).toBe("original_not_found");
  });

  test("reply preserves threadId from original", async () => {
    const coordinator = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coordinator, mantis);

    const ask = await peerAskTool(coordinator, {
      to: "mantis",
      content: "ping",
      threadId: "session-7",
    });
    const askMsgId = parseResult(ask).payload["msgId"] as string;

    await peerInboxReadTool(mantis);
    await peerReplyTool(mantis, { inReplyTo: askMsgId, content: "pong" });

    const incoming = await peerInboxReadTool(coordinator);
    const messages = parseResult(incoming).payload["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["threadId"]).toBe("session-7");
  });

  test("reply works when original still in pending/ (push delivered, not drained)", async () => {
    // Simulates the channel-push path: zpráva dorazí inline jako <channel> tag,
    // ale piggyback ji ještě nedrainoval (still in pending/). peer_reply musí
    // umět najít originál a archivovat ho on the fly.
    const coordinator = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coordinator, mantis);

    const ask = await peerAskTool(coordinator, { to: "mantis", content: "ping" });
    const askMsgId = parseResult(ask).payload["msgId"] as string;

    // NOTE: záměrně NEvoláme peerInboxReadTool — zpráva zůstává v pending/
    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(1);
    expect((await mantis.inbox.listDone(mantis.self.id)).length).toBe(0);

    const reply = await peerReplyTool(mantis, {
      inReplyTo: askMsgId,
      content: "pong via push",
    });
    const { ok, payload } = parseResult(reply);
    expect(ok).toBe(true);
    expect(payload["inReplyTo"]).toBe(askMsgId);

    // Post-condition: peer_reply by měl archivovat původní zprávu (pending → done)
    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(0);
    expect((await mantis.inbox.listDone(mantis.self.id)).length).toBe(1);

    // Coordinator dostane reply normálně
    const incoming = await peerInboxReadTool(coordinator);
    const msgs = parseResult(incoming).payload["messages"] as Array<Record<string, unknown>>;
    expect(msgs[0]?.["content"]).toBe("pong via push");
  });
});

describe("piggyback inbox consumption", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "claude-bridge-piggyback-"));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(baseDir, "inbox"), { recursive: true, force: true });
    await rm(join(baseDir, "status"), { recursive: true, force: true });
  });

  test("returns result unchanged when inbox is empty", async () => {
    const ctx = await makeContext(baseDir, "lonely");
    const result: ToolResult = { content: [{ type: "text", text: '{"ok": true}' }] };
    const out = await piggybackInbox(ctx, "list_projects", result);
    expect(out.content.length).toBe(1);
  });

  test("appends inbox block when messages pending", async () => {
    const coord = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coord, mantis);
    await peerAskTool(coord, { to: "mantis", content: "ping" });

    const result: ToolResult = { content: [{ type: "text", text: '{"ok": true}' }] };
    const out = await piggybackInbox(mantis, "list_projects", result);

    expect(out.content.length).toBe(2);
    const block = out.content[1]?.text ?? "";
    expect(block).toContain("📬 INBOX");
    expect(block).toContain("coordinator");
    expect(block).toContain("ping");
  });

  test("piggyback consumes (moves pending → done)", async () => {
    const coord = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coord, mantis);
    await peerAskTool(coord, { to: "mantis", content: "ping" });

    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(1);

    const result: ToolResult = { content: [{ type: "text", text: "{}" }] };
    await piggybackInbox(mantis, "list_projects", result);

    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(0);
    expect((await mantis.inbox.listDone(mantis.self.id)).length).toBe(1);
  });

  test("piggyback is SKIPPED for peer_inbox_read (avoid double-consume)", async () => {
    const coord = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coord, mantis);
    await peerAskTool(coord, { to: "mantis", content: "ping" });

    const result: ToolResult = { content: [{ type: "text", text: "{}" }] };
    const out = await piggybackInbox(mantis, "peer_inbox_read", result);
    expect(out.content.length).toBe(1);

    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(1);
  });

  test("piggyback is SKIPPED on error result (don't drain on failure)", async () => {
    const coord = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coord, mantis);
    await peerAskTool(coord, { to: "mantis", content: "ping" });

    const errorResult: ToolResult = {
      isError: true,
      content: [{ type: "text", text: '{"ok": false}' }],
    };
    const out = await piggybackInbox(mantis, "list_projects", errorResult);

    expect(out.content.length).toBe(1);
    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(1);
  });

  test("piggyback dedup: messages delivered via push are drained but NOT re-rendered in block", async () => {
    const coord = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coord, mantis);

    // Send two messages — A delivered via push, B not
    const askA = await peerAskTool(coord, { to: "mantis", content: "msg A (via push)" });
    const askB = await peerAskTool(coord, { to: "mantis", content: "msg B (not pushed)" });
    const msgA = parseResult(askA).payload["msgId"] as string;
    const msgB = parseResult(askB).payload["msgId"] as string;

    // Simulate push delivery of A — pump would set this after server.notification
    mantis.pushedMsgIds.add(msgA);

    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(2);

    const result: ToolResult = { content: [{ type: "text", text: "{}" }] };
    const out = await piggybackInbox(mantis, "list_projects", result);

    // Both messages should be archived (state management runs for all)
    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(0);
    expect((await mantis.inbox.listDone(mantis.self.id)).length).toBe(2);

    // But block should only mention msg B (msg A already shown via push)
    expect(out.content.length).toBe(2);
    const block = out.content[1]?.text ?? "";
    expect(block).toContain("msg B (not pushed)");
    expect(block).not.toContain("msg A (via push)");
    expect(block).toContain("1 new");

    // pushedMsgIds should be cleaned (consumed)
    expect(mantis.pushedMsgIds.has(msgA)).toBe(false);
    expect(mantis.pushedMsgIds.has(msgB)).toBe(false);
  });

  test("piggyback: when ALL pending messages were pushed, no INBOX block appended", async () => {
    const coord = await makeContext(baseDir, "coordinator");
    const mantis = await makeContext(baseDir, "mantis");
    await registerInRegistry(coord, mantis);

    const ask = await peerAskTool(coord, { to: "mantis", content: "pushed" });
    const msgId = parseResult(ask).payload["msgId"] as string;
    mantis.pushedMsgIds.add(msgId);

    const result: ToolResult = { content: [{ type: "text", text: "{}" }] };
    const out = await piggybackInbox(mantis, "list_projects", result);

    // No second content block (everything was pushed → dedup → empty block)
    expect(out.content.length).toBe(1);
    // But message IS archived
    expect(await mantis.inbox.countPending(mantis.self.id)).toBe(0);
    expect((await mantis.inbox.listDone(mantis.self.id)).length).toBe(1);
  });
});

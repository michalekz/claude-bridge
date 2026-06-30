import { describe, expect, test } from "vitest";
import type { MessageEnvelope } from "../../src/inbox/store.ts";
import {
  CHANNEL_METHOD,
  buildChannelNotification,
  createChannelSender,
} from "../../src/mcp/channel.ts";

const COORD_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MANTIS_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: "msg-abc",
    from: COORD_ID,
    fromName: "coordinator",
    to: MANTIS_ID,
    toName: "mantis",
    kind: "ask",
    sentAt: "2026-05-25T10:00:00.000Z",
    content: "how many open tickets?",
    ...overrides,
  };
}

describe("buildChannelNotification", () => {
  test("uses canonical MCP method name", () => {
    const n = buildChannelNotification(envelope());
    expect(n.method).toBe(CHANNEL_METHOD);
    expect(n.method).toBe("notifications/claude/channel");
  });

  test("content includes fromName + kind + msgId", () => {
    const n = buildChannelNotification(envelope());
    expect(n.params.content).toContain("coordinator");
    expect(n.params.content).toContain("(ask, msg msg-abc)");
    expect(n.params.content).toContain("how many open tickets?");
  });

  test("content falls back to id when fromName is missing", () => {
    const n = buildChannelNotification(envelope({ fromName: undefined }));
    expect(n.params.content).toContain(COORD_ID);
  });

  test("ask kind adds peer_reply hint", () => {
    const n = buildChannelNotification(envelope({ kind: "ask" }));
    expect(n.params.content).toContain("peer_reply inReplyTo=msg-abc");
  });

  test("reply kind does NOT add peer_reply hint", () => {
    const n = buildChannelNotification(envelope({ kind: "reply" }));
    expect(n.params.content).not.toContain("peer_reply inReplyTo");
  });

  test("meta contains structured fields (from = id, fromName = display)", () => {
    const n = buildChannelNotification(envelope());
    expect(n.params.meta.from).toBe(COORD_ID);
    expect(n.params.meta.fromName).toBe("coordinator");
    expect(n.params.meta.msgId).toBe("msg-abc");
    expect(n.params.meta.kind).toBe("ask");
  });

  test("meta carries threadId when present", () => {
    const n = buildChannelNotification(envelope({ threadId: "thread-7" }));
    expect(n.params.meta.threadId).toBe("thread-7");
  });

  test("meta carries inReplyTo for replies", () => {
    const n = buildChannelNotification(envelope({ kind: "reply", inReplyTo: "msg-orig" }));
    expect(n.params.meta.inReplyTo).toBe("msg-orig");
  });

  test("optional fields absent when envelope omits them", () => {
    const n = buildChannelNotification(envelope({ fromName: undefined }));
    expect("threadId" in n.params.meta).toBe(false);
    expect("inReplyTo" in n.params.meta).toBe(false);
    expect("fromName" in n.params.meta).toBe(false);
  });
});

describe("createChannelSender", () => {
  test("calls server.notification with built notif on push", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const fakeServer = {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      async notification(n: any) {
        calls.push({ method: n.method, params: n.params });
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: stub
    const sender = createChannelSender(fakeServer as any);
    const result = await sender.push(envelope());
    expect(result.delivered).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe(CHANNEL_METHOD);
  });

  test("returns delivered:false on server.notification error", async () => {
    const fakeServer = {
      async notification() {
        throw new Error("channel not supported");
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: stub
    const sender = createChannelSender(fakeServer as any);
    const result = await sender.push(envelope());
    expect(result.delivered).toBe(false);
  });

  test("delivers multiple envelopes in sequence", async () => {
    let count = 0;
    const fakeServer = {
      async notification() {
        count++;
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: stub
    const sender = createChannelSender(fakeServer as any);
    await sender.push(envelope({ id: "1" }));
    await sender.push(envelope({ id: "2" }));
    await sender.push(envelope({ id: "3" }));
    expect(count).toBe(3);
  });
});

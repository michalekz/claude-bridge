import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  type MessageEnvelope,
  MessageEnvelopeSchema,
  createInboxStore,
  generateMessageId,
} from "../../src/inbox/store.ts";

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: generateMessageId(),
    from: "coordinator",
    to: "mantis",
    kind: "ask",
    sentAt: new Date().toISOString(),
    content: "kolik je open ticketů?",
    ...overrides,
  };
}

describe("generateMessageId", () => {
  test("returns unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateMessageId());
    expect(ids.size).toBe(100);
  });

  test("time-prefixed IDs sort chronologically", () => {
    const a = generateMessageId(1_700_000_000_000);
    const b = generateMessageId(1_700_000_001_000);
    expect(a < b).toBe(true);
  });

  test("format: <ts-base36>-<8-hex-chars>", () => {
    const id = generateMessageId();
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{8}$/);
  });
});

describe("MessageEnvelopeSchema", () => {
  test("accepts valid envelope", () => {
    const env = makeEnvelope();
    expect(MessageEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  test("rejects missing required field", () => {
    const env = { ...makeEnvelope(), content: undefined };
    expect(MessageEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  test("rejects invalid kind", () => {
    const env = { ...makeEnvelope(), kind: "invalid" };
    expect(MessageEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  test("accepts optional threadId and inReplyTo", () => {
    const env = makeEnvelope({ threadId: "thread-1", inReplyTo: "msg-orig" });
    expect(MessageEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  test("passthrough preserves unknown fields", () => {
    const env = { ...makeEnvelope(), customField: "extra" };
    const parsed = MessageEnvelopeSchema.parse(env) as Record<string, unknown>;
    expect(parsed["customField"]).toBe("extra");
  });
});

describe("InboxStore", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "claude-bridge-inbox-"));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Reset between tests for isolation
    await rm(join(baseDir, "inbox"), { recursive: true, force: true });
  });

  test("send writes message to recipient pending dir", async () => {
    const store = createInboxStore({ baseDir });
    const env = makeEnvelope();
    await store.send(env);

    const pending = await store.listPending("mantis");
    expect(pending.length).toBe(1);
    expect(pending[0]?.id).toBe(env.id);
    expect(pending[0]?.content).toBe("kolik je open ticketů?");
  });

  test("listPending returns empty for unknown peer", async () => {
    const store = createInboxStore({ baseDir });
    expect(await store.listPending("nobody")).toEqual([]);
  });

  test("countPending matches listPending length", async () => {
    const store = createInboxStore({ baseDir });
    await store.send(makeEnvelope({ id: generateMessageId() }));
    await new Promise((r) => setTimeout(r, 2));
    await store.send(makeEnvelope({ id: generateMessageId() }));
    expect(await store.countPending("mantis")).toBe(2);
  });

  test("listPending sorts chronologically by ID", async () => {
    const store = createInboxStore({ baseDir });
    const env1 = makeEnvelope({ id: generateMessageId(1_700_000_000_000) });
    const env2 = makeEnvelope({ id: generateMessageId(1_700_000_001_000) });
    // Send in reverse order
    await store.send(env2);
    await store.send(env1);
    const pending = await store.listPending("mantis");
    expect(pending.map((e) => e.id)).toEqual([env1.id, env2.id]);
  });

  test("consume moves message pending → done", async () => {
    const store = createInboxStore({ baseDir });
    const env = makeEnvelope();
    await store.send(env);

    const consumed = await store.consume("mantis", env.id);
    expect(consumed?.id).toBe(env.id);
    expect(await store.countPending("mantis")).toBe(0);
    expect(await store.findInDone("mantis", env.id)).not.toBeNull();
  });

  test("consume returns null for missing message", async () => {
    const store = createInboxStore({ baseDir });
    const result = await store.consume("mantis", "missing-id");
    expect(result).toBeNull();
  });

  test("findInDone returns null for unknown id", async () => {
    const store = createInboxStore({ baseDir });
    expect(await store.findInDone("mantis", "ghost")).toBeNull();
  });

  test("listDone returns archived messages", async () => {
    const store = createInboxStore({ baseDir });
    const env1 = makeEnvelope({ id: generateMessageId(1_700_000_000_000) });
    const env2 = makeEnvelope({ id: generateMessageId(1_700_000_001_000) });
    await store.send(env1);
    await store.send(env2);
    await store.consume("mantis", env1.id);
    await store.consume("mantis", env2.id);
    const done = await store.listDone("mantis");
    expect(done.map((e) => e.id)).toEqual([env1.id, env2.id]);
  });

  test("reply correlation via inReplyTo + findInDone", async () => {
    const store = createInboxStore({ baseDir });
    const ask = makeEnvelope({
      from: "coordinator",
      to: "mantis",
      kind: "ask",
      content: "ping",
    });
    await store.send(ask);
    await store.consume("mantis", ask.id);

    // Recipient finds the original later when replying
    const found = await store.findInDone("mantis", ask.id);
    expect(found?.from).toBe("coordinator");

    const reply = makeEnvelope({
      from: "mantis",
      to: "coordinator",
      kind: "reply",
      content: "pong",
      inReplyTo: ask.id,
    });
    await store.send(reply);

    const pendingForCoord = await store.listPending("coordinator");
    expect(pendingForCoord.length).toBe(1);
    expect(pendingForCoord[0]?.inReplyTo).toBe(ask.id);
  });

  test("send validates envelope shape via Zod", async () => {
    const store = createInboxStore({ baseDir });
    const bad = { ...makeEnvelope(), kind: "nonsense" } as unknown as MessageEnvelope;
    await expect(store.send(bad)).rejects.toThrow();
  });

  test("malformed JSON in pending is skipped silently", async () => {
    const store = createInboxStore({ baseDir });
    await store.send(makeEnvelope({ id: "valid-id" }));

    // Plant a malformed JSON file alongside
    const pendingDir = join(baseDir, "inbox", "mantis", "pending");
    await mkdir(pendingDir, { recursive: true });
    await writeFile(join(pendingDir, "broken-id.json"), "{ this is not json");

    const list = await store.listPending("mantis");
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe("valid-id");
  });

  test("multiple peers are isolated", async () => {
    const store = createInboxStore({ baseDir });
    await store.send(makeEnvelope({ to: "alice", content: "hi alice" }));
    await store.send(makeEnvelope({ to: "bob", content: "hi bob" }));

    const alice = await store.listPending("alice");
    const bob = await store.listPending("bob");
    expect(alice.length).toBe(1);
    expect(bob.length).toBe(1);
    expect(alice[0]?.content).toBe("hi alice");
    expect(bob[0]?.content).toBe("hi bob");
  });
});

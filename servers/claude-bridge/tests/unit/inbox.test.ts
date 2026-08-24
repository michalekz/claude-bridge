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
    content: "how many open tickets?",
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
    expect(pending[0]?.content).toBe("how many open tickets?");
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

/**
 * `pending/` means "not confirmed seen by the agent", not "not delivered".
 *
 * That is deliberate: `pumpInboxToChannel` pushes best-effort and does NOT
 * consume, because `server.notification()` succeeding only proves the MCP
 * protocol accepted the payload — not that Claude Code rendered the channel tag
 * into the agent's prompt. Consuming on protocol success would lose every
 * message the agent never saw. Piggyback, which runs on the next tool call, is
 * the only evidence of "seen", and that is what archives.
 *
 * The cost was that both situations looked identical from outside: a file in
 * `pending/`. On 2026-08-05 plt-designer diagnosed a peer as deaf from one, and
 * hours later so did I, on a different peer — both had received and answered.
 * Of nineteen decidable pending files across the live fleet, seventeen had been
 * delivered. `pushedMsgIds` knew, but it is a Set for the life of one process.
 *
 * These cases hold the note on disk, and hold it to being only a note.
 */
describe("push provenance separates 'not confirmed' from 'never sent'", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cb-pushrec-"));
  });

  test("THE DISCRIMINATION: a pushed and an unpushed message are told apart", async () => {
    const store = createInboxStore({ baseDir: dir });
    const pushedMsg = makeEnvelope({ to: "peer-a", content: "went out" });
    const stuckMsg = makeEnvelope({ to: "peer-a", content: "never left" });
    await store.send(pushedMsg);
    await store.send(stuckMsg);
    await store.markPushed("peer-a", pushedMsg.id);

    // Both still pending — that is correct, and that is why pending alone
    // could never answer the question.
    expect(await store.countPending("peer-a")).toBe(2);
    expect(await store.pushRecord("peer-a", pushedMsg.id)).not.toBeNull();
    expect(await store.pushRecord("peer-a", stuckMsg.id)).toBeNull();
  });

  test("a repeated push is counted, not overwritten into looking like one", async () => {
    const store = createInboxStore({ baseDir: dir });
    const env = makeEnvelope({ to: "peer-b" });
    await store.send(env);
    await store.markPushed("peer-b", env.id);
    await store.markPushed("peer-b", env.id);
    await store.markPushed("peer-b", env.id);
    // Three pushes with no confirmation says something one push does not.
    expect((await store.pushRecord("peer-b", env.id))?.pushCount).toBe(3);
  });

  test("the note is provenance, not a suppression flag — the message stays pending", async () => {
    // If marking as pushed ever removed a message from pending, piggyback
    // would stop draining it and the silent loss this design avoids would be
    // back.
    const store = createInboxStore({ baseDir: dir });
    const env = makeEnvelope({ to: "peer-c" });
    await store.send(env);
    await store.markPushed("peer-c", env.id);
    const pending = await store.listPending("peer-c");
    expect(pending.map((p) => p.id)).toEqual([env.id]);
  });

  test("consuming clears the note — an archived message raises no question", async () => {
    const store = createInboxStore({ baseDir: dir });
    const env = makeEnvelope({ to: "peer-d" });
    await store.send(env);
    await store.markPushed("peer-d", env.id);
    await store.consume("peer-d", env.id);
    expect(await store.pushRecord("peer-d", env.id)).toBeNull();
    expect(await store.countPending("peer-d")).toBe(0);
  });

  test("failing to write the note never fails the delivery it describes", async () => {
    // The note is diagnostic. An unwritable inbox root must not turn a
    // successful push into an error — `pumpInboxToChannel` awaits this call.
    //
    // The unwritable root is a FILE, so every path under it is ENOTDIR: a
    // real, instant errno. An earlier version of this test used a path under
    // /proc and hung, because `mkdir -p` there does not fail so much as stop
    // answering — a property of that filesystem, not of this code.
    const notADir = join(dir, "root-is-a-file");
    await writeFile(notADir, "", "utf-8");
    const store = createInboxStore({ baseDir: notADir });
    await expect(store.markPushed("peer-e", "msg-1")).resolves.toBeUndefined();
    expect(await store.pushRecord("peer-e", "msg-1")).toBeNull();
  });
});

// 🔴 Dluh #4: `listPending` zahazoval neschématické obálky BEZE STOPY.
// Zpráva mohla ležet v cizí frontě a být neviditelná pro každého čtenáře
// včetně počítadel, která odpovídají na otázku „tahá ten peer frontu?".
describe("neschématická obálka se zahodí, ale ne potichu", () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bridge-drop-"));
  });

  test("nečitelná obálka se nevrátí, ale ohlásí se do logu", async () => {
    const store = createInboxStore({ baseDir });
    const peer = "11111111-1111-4111-8111-111111111111";
    const dir = join(baseDir, "inbox", peer, "pending");
    await mkdir(dir, { recursive: true });

    // Jedna platná, jedna rozbitý JSON, jedna platný JSON mimo schéma.
    const good: MessageEnvelope = MessageEnvelopeSchema.parse({
      id: generateMessageId(),
      kind: "ask",
      from: "22222222-2222-4222-8222-222222222222",
      fromName: "odesilatel",
      to: peer,
      toName: "prijemce",
      content: "platná",
      sentAt: new Date().toISOString(),
    });
    await writeFile(join(dir, `${good.id}.json`), JSON.stringify(good), "utf-8");
    await writeFile(join(dir, "aaa-rozbity.json"), "{tohle není json", "utf-8");
    await writeFile(join(dir, "bbb-mimo-schema.json"), JSON.stringify({ kind: "ask" }), "utf-8");

    const listed = await store.listPending(peer);
    expect(listed.map((e) => e.content)).toEqual(["platná"]);

    // Podstata dluhu: počítadlo je vidělo, čtenář ne. Surový výpis je
    // musí vidět pořád — jinak by se fronta jevila kratší, než je.
    const raw = await store.listPendingRaw(peer);
    expect(raw).toHaveLength(3);
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageEnvelopeSchema, syntheticSenderId, writeEnvelope } from "@claude-bridge/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `peer_compact` never completed once, from the day it shipped to the day this
 * test was written.
 *
 * The daemon built its anchor request by hand and wrote it with a raw
 * `atomicWriteJson`. That object disagreed with `MessageEnvelopeSchema` in five
 * places at once — `from` and `to` were `{sessionId, name}` rather than
 * strings, the timestamp was `ts` rather than `sentAt`, `content` was an
 * object, and `kind` was `compact-anchor-request`, which the enum does not
 * contain.
 *
 * The recipient reads its inbox through `readEnvelope`, which `safeParse`s and
 * returns null on failure, so `listPending` simply did not include the file.
 * The write succeeded, the watcher fired, the push pump ran, and nothing was
 * delivered — with no error at either end. Every run ended in `anchor_timeout`,
 * which reads as "the peer is not answering", and for two days that is exactly
 * how three people read it: a deaf peer, then an open TUI dialog, then a
 * dropped `--channels` flag. All three were measured and disproved. The
 * envelope was never looked at, because nothing pointed at it.
 *
 * Both halves of the fix are load-bearing:
 *
 *   - the daemon writes through `writeEnvelope`, which `parse`s and therefore
 *     throws at the writer instead of vanishing at the reader;
 *   - this test holds the contract, because the two packages carry their own
 *     copies of the schema (task #65) and nothing else compares them.
 */

const ANCHOR_INSTRUCTION =
  "Compact anchor requested by the control plane. Write your compact anchor, " +
  "then touch ~/.claude-bridge/control/compact-ack/<sessionId>.json — the daemon " +
  "injects `/compact` only after that file appears, so that nothing is compacted " +
  "without a durable anchor behind it.";

const PEER = "70a00bc8-e68c-4ae2-9c8a-e1a87092454d";

describe("the anchor request is readable by the peer it is written for", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cbd-anchor-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("THE REGRESSION: what the daemon writes parses as a message envelope", async () => {
    const path = await writeEnvelope(
      {
        id: "msg-anchor-1",
        from: syntheticSenderId("control-plane-daemon"),
        fromName: "control-plane-daemon",
        to: PEER,
        kind: "ask",
        sentAt: new Date().toISOString(),
        threadId: `compact:${PEER}:msg-anchor-1`,
        content: ANCHOR_INSTRUCTION,
      },
      root,
    );

    // Read it back the way the recipient does — parse, do not assume.
    const onDisk: unknown = JSON.parse(await readFile(path, "utf-8"));
    const parsed = MessageEnvelopeSchema.safeParse(onDisk);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.to).toBe(PEER);
    expect(typeof parsed.data.content).toBe("string");
    expect(parsed.data.threadId).toContain("compact:");
  });

  it("it lands in the pending directory the recipient watches", async () => {
    const path = await writeEnvelope(
      {
        id: "msg-anchor-2",
        from: syntheticSenderId("control-plane-daemon"),
        to: PEER,
        kind: "ask",
        sentAt: new Date().toISOString(),
        content: ANCHOR_INSTRUCTION,
      },
      root,
    );
    // A correct envelope in the wrong directory is just as undelivered.
    expect(path).toBe(join(root, "inbox", PEER, "pending", "msg-anchor-2.json"));
  });

  it("THE GUARD: a malformed envelope throws at the writer, it does not vanish", async () => {
    // The exact shape the daemon used to write. It must now be impossible to
    // get onto disk — a reader that silently skips cannot tell anyone.
    const legacy = {
      id: "msg-anchor-3",
      ts: new Date().toISOString(),
      from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
      to: { sessionId: PEER, name: PEER },
      kind: "compact-anchor-request",
      content: { instruction: ANCHOR_INSTRUCTION },
    };
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately the wrong shape
      writeEnvelope(legacy as any, root),
    ).rejects.toThrow();
  });

  it("names the daemon as a sender that is not a peer", () => {
    const from = syntheticSenderId("control-plane-daemon");
    // `external:` keeps a reply from being addressed back to a peer id that
    // does not exist.
    expect(from.startsWith("external:")).toBe(true);
    expect(
      MessageEnvelopeSchema.safeParse({
        id: "x",
        from,
        to: PEER,
        kind: "ask",
        sentAt: new Date().toISOString(),
        content: "hi",
      }).success,
    ).toBe(true);
  });
});

/**
 * The same defect stood in `wake.ts`, and it stood there alone for longer.
 *
 * Two hand-rolled inbox writers, both disagreeing with the schema in the same
 * five ways, is not two accidents — it is a missing rule. Waking therefore only
 * ever worked by half: the key injection made the peer take a turn, while the
 * message saying WHY it had been woken was never readable, including the
 * warning that its previous stop was forced and its anchor may be mid-write.
 *
 * These cases hold BOTH writers to the contract, because holding one is how the
 * second survived the first fix.
 */
describe("every daemon-written inbox message is readable by its recipient", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cbd-wake-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("THE REGRESSION: the wake message parses as a message envelope", async () => {
    const path = await writeEnvelope(
      {
        id: "msg-wake-1",
        from: syntheticSenderId("control-plane-daemon"),
        fromName: "control-plane-daemon",
        to: PEER,
        kind: "ask",
        sentAt: new Date().toISOString(),
        threadId: `wake:${PEER}:abc`,
        content: "You were resumed from a stopped state.\n\nReason: team_layout_resume:smoke",
      },
      root,
    );
    const parsed = MessageEnvelopeSchema.safeParse(JSON.parse(await readFile(path, "utf-8")));
    expect(parsed.success).toBe(true);
  });

  it("the forced-stop warning survives as readable text, not a hidden field", async () => {
    // It used to live in `content.warning`, which no reader ever reached. A
    // safety instruction the recipient cannot see is worse than none, because
    // the sender believes it was given.
    const content = [
      "You were resumed from a stopped state.",
      "",
      "⚠ Your previous stop was FORCED — verify your anchor before trusting it.",
    ].join("\n");
    const path = await writeEnvelope(
      {
        id: "msg-wake-2",
        from: syntheticSenderId("control-plane-daemon"),
        to: PEER,
        kind: "ask",
        sentAt: new Date().toISOString(),
        content,
      },
      root,
    );
    const parsed = MessageEnvelopeSchema.parse(JSON.parse(await readFile(path, "utf-8")));
    expect(parsed.content).toContain("FORCED");
  });

  it("THE GUARD: the old wake shape cannot reach disk either", async () => {
    const legacy = {
      id: "msg-wake-3",
      ts: new Date().toISOString(),
      from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
      to: { sessionId: PEER, name: PEER },
      kind: "peer-wake",
      content: { instruction: "re-onboard", stoppedCleanly: false },
    };
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately the wrong shape
      writeEnvelope(legacy as any, root),
    ).rejects.toThrow();
  });
});

import { readFile, readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateMessageId,
  isSyntheticSender,
  syntheticSenderId,
  writeEnvelope,
} from "@claude-bridge/shared";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MessageEnvelopeSchema, createInboxStore } from "../../src/inbox/store.ts";
import { peerReplyTool } from "../../src/mcp/tools.ts";

/**
 * The on-disk message format has two definitions: this package's
 * `inbox/store.ts` (which every peer READS through) and
 * `@claude-bridge/shared/inbox-envelope.ts` (which
 * `claude-bridge-daemon send` WRITES through, for injectors outside the fleet).
 *
 * Unifying them is task #65. Until then this test is what keeps the split from
 * going wrong quietly: both schemas are `.passthrough()`, so a writer that
 * drifts does not throw. It produces a subtly wrong file, the watcher delivers
 * it, and the recipient gets something broken with no error on either side.
 *
 * If this fails, the two definitions have diverged — fix them, do not relax the
 * assertion.
 */
describe("an externally injected message is readable by the peer that receives it", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cb-contract-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const PEER = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";

  test("THE CONTRACT: what shared writes, this package's schema accepts", async () => {
    await writeEnvelope(
      {
        id: generateMessageId(Date.parse("2026-08-04T16:30:00.000Z")),
        from: syntheticSenderId("teams:uzaverka"),
        fromName: "teams:uzaverka",
        to: PEER,
        toName: "plt-recipient",
        kind: "ask",
        sentAt: "2026-08-04T16:30:00.000Z",
        content: "a message that entered the fleet from outside it",
        threadId: "teams-thread-1",
      },
      root,
    );

    const dir = join(root, "inbox", PEER, "pending");
    const files = await readdir(dir);
    expect(files).toHaveLength(1);

    const raw = JSON.parse(await readFile(join(dir, files[0] ?? ""), "utf-8"));
    // The assertion that matters: the READER's schema, not the writer's.
    const parsed = MessageEnvelopeSchema.safeParse(raw);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  test("and the peer's own store lists it like any other message", async () => {
    const store = createInboxStore({ baseDir: root });
    await writeEnvelope(
      {
        id: generateMessageId(Date.parse("2026-08-04T16:31:00.000Z")),
        from: syntheticSenderId("teams:uzaverka"),
        fromName: "teams:uzaverka",
        to: PEER,
        kind: "ask",
        sentAt: "2026-08-04T16:31:00.000Z",
        content: "delivered from outside",
      },
      root,
    );

    const pending = await store.listPending(PEER);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.content).toBe("delivered from outside");
    // A reply would address `from`, creating inbox/external:teams:uzaverka/ —
    // a directory nothing drains. The prefix is what lets a caller refuse.
    expect(isSyntheticSender(pending[0]?.from ?? "")).toBe(true);
  });

  test("a real peer sender is not mistaken for a synthetic one", () => {
    expect(isSyntheticSender("1e222264-e4ea-4679-ab0f-bcc54b47db6b")).toBe(false);
  });
});

/**
 * A reply to an external sender used to be written to
 * `inbox/external:<label>/pending/` and reported `ok`. Nothing drains that
 * directory, so the answer sat on disk looking delivered — the same
 * confirmed-without-checking shape as the push that reported `delivered` for a
 * message nobody rendered.
 */
describe("replying to something that has no inbox", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cb-reply-ext-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const SELF = "12121212-3434-5656-7878-909090909090";

  async function contextFor(baseDir: string) {
    const store = createInboxStore({ baseDir });
    return {
      self: { id: SELF, name: "plt-self" },
      inbox: store,
    } as unknown as Parameters<typeof peerReplyTool>[0];
  }

  test("THE REGRESSION: peer_reply refuses instead of writing into the void", async () => {
    await writeEnvelope(
      {
        id: "mseutphx-dbc670cf",
        from: syntheticSenderId("teams:uzaverka"),
        fromName: "teams:uzaverka",
        to: SELF,
        kind: "ask",
        sentAt: "2026-08-04T16:40:00.000Z",
        content: "from outside the fleet",
      },
      root,
    );

    const res = await peerReplyTool(await contextFor(root), {
      inReplyTo: "mseutphx-dbc670cf",
      content: "an answer that would have gone nowhere",
    });

    const payload = JSON.parse(res.content[0]?.text ?? "{}");
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("sender_is_external");

    // And nothing was created for the phantom recipient.
    await expect(
      readdir(join(root, "inbox", syntheticSenderId("teams:uzaverka"), "pending")),
    ).rejects.toThrow();
  });

  test("a reply to a real peer still goes through", async () => {
    const PEER = "abababab-cdcd-efef-0101-232323232323";
    const store = createInboxStore({ baseDir: root });
    await store.send({
      id: "msreal01-aaaaaaaa",
      from: PEER,
      fromName: "plt-real",
      to: SELF,
      kind: "ask",
      sentAt: "2026-08-04T16:41:00.000Z",
      content: "a peer asking a question",
    });

    const res = await peerReplyTool(await contextFor(root), {
      inReplyTo: "msreal01-aaaaaaaa",
      content: "an answer with somewhere to land",
    });

    const payload = JSON.parse(res.content[0]?.text ?? "{}");
    expect(payload.ok).toBe(true);
    expect((await store.listPending(PEER))[0]?.content).toBe("an answer with somewhere to land");
  });
});

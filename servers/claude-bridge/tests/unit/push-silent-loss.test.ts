import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createChannelSender } from "../../src/mcp/channel.ts";
import { type ServerContext, buildContext, pumpInboxToChannel } from "../../src/mcp/context.ts";
import { peerAskTool, piggybackInbox } from "../../src/mcp/tools.ts";

/**
 * Silently lost messages when a push "succeeds" but renders nothing.
 *
 * Found live on 2026-08-04 during the plugin-identity migration. A peer on
 * the renamed plugin had its channel notifications dropped by Claude Code —
 * no error anywhere. `channel.push()` returned `delivered: true`, because
 * that only means `server.notification()` did not throw. The id went into
 * `pushedMsgIds`; the next tool call archived the message to `done/` and
 * omitted it from the inbox block on the grounds that it had "already been
 * shown". It had not. Evidence: msg msdv3vmc, sent 23:30:24, moved to done/
 * at 23:34:04, `peer_inbox_read` → count 0.
 *
 * The bug predates v0.10.2 — the code is unchanged since before v0.10.0-rc.2,
 * so the whole fleet carries it. The rename only created the conditions.
 *
 * The rule these tests hold: a message that reached done/ must have been put
 * in front of the agent. A duplicate is noise; a silent drop is data loss.
 */

function fakeServer(sink: unknown[], drop = false) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: stub
    async notification(n: any) {
      // `drop` models the real failure: Claude Code accepts the notification
      // and renders nothing. No throw — so the sender cannot tell.
      if (!drop) sink.push(n);
    },
  };
}

let counter = 0;
const makeId = (label: string) =>
  `${label.slice(0, 7).padEnd(7, "0")}${++counter}-0000-0000-0000-000000000000`.slice(0, 36);

async function mkCtx(baseDir: string, name: string): Promise<ServerContext> {
  return buildContext({
    identity: { id: makeId(name), name, displayName: name, source: "env" },
    baseDir,
    withHeartbeat: false,
    emitTerminalTitle: false,
    version: "test",
    nameRefreshIntervalMs: 0,
  });
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

describe("push that renders nothing must not swallow the message", () => {
  let baseDir: string;
  let sender: ServerContext;
  let receiver: ServerContext;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "cb-pushloss-"));
  });
  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    sender = await mkCtx(baseDir, "designer");
    receiver = await mkCtx(baseDir, "bridgedev");
    for (const c of [sender, receiver]) {
      await c.registry.startHeartbeat({ id: c.self.id, name: c.self.name, pid: 1, source: "env" });
    }
  });

  test("THE REGRESSION: dropped notification still reaches the agent via the inbox block", async () => {
    const rendered: unknown[] = [];
    // drop = true: the exact live failure. Push resolves, nothing is rendered.
    receiver.channel = createChannelSender(fakeServer(rendered, true) as never);

    await peerAskTool(sender, { to: receiver.self.id, content: "ROZHODUJÍCÍ TEST" });

    const { pushed } = await pumpInboxToChannel(receiver);
    // The sender genuinely believes it delivered — this is the lying instrument.
    expect(pushed).toBe(1);
    expect(rendered.length).toBe(0);
    expect(receiver.pushedMsgIds.size).toBe(1);

    // Any later tool call triggers the piggyback drain.
    const out = await piggybackInbox(receiver, "peer_list", {
      content: [{ type: "text", text: "{}" }],
    });

    // Before the fix this block was empty and the message was gone.
    expect(textOf(out)).toContain("ROZHODUJÍCÍ TEST");
    expect(textOf(out)).toContain("📬 INBOX");

    // Archived exactly once, and reply correlation still works.
    expect((await receiver.inbox.listPending(receiver.self.id)).length).toBe(0);
    expect((await receiver.inbox.listDone(receiver.self.id)).length).toBe(1);
  });

  test("a push that DID render is still shown, but marked as an echo", async () => {
    const rendered: unknown[] = [];
    receiver.channel = createChannelSender(fakeServer(rendered, false) as never);

    await peerAskTool(sender, { to: receiver.self.id, content: "normální provoz" });
    await pumpInboxToChannel(receiver);
    expect(rendered.length).toBe(1);

    const out = await piggybackInbox(receiver, "peer_list", {
      content: [{ type: "text", text: "{}" }],
    });

    // Duplicate content is the accepted cost — the marker keeps it honest so
    // the agent can tell a second copy from a second message.
    expect(textOf(out)).toContain("normální provoz");
    expect(textOf(out)).toContain("already pushed to channel");
  });

  test("a message never pushed at all carries no echo marker", async () => {
    // No channel configured — piggyback is the only delivery path.
    await peerAskTool(sender, { to: receiver.self.id, content: "jen piggyback" });

    const out = await piggybackInbox(receiver, "peer_list", {
      content: [{ type: "text", text: "{}" }],
    });

    expect(textOf(out)).toContain("jen piggyback");
    expect(textOf(out)).not.toContain("already pushed to channel");
  });

  test("nothing pending means no block — count 0 now genuinely means empty", async () => {
    // Once messages can no longer be swallowed, an empty answer is
    // trustworthy. It was not before: count 0 also meant "eaten".
    const out = await piggybackInbox(receiver, "peer_list", {
      content: [{ type: "text", text: "{}" }],
    });
    expect(textOf(out)).not.toContain("📬 INBOX");
  });
});

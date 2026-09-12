import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ServerContext, buildContext } from "../../src/mcp/context.ts";
import {
	peerAskTool,
	peerContextStatusTool,
	peerInboxReadTool,
} from "../../src/mcp/tools.ts";

/**
 * v0.11.53 — two reports from the fleet, both about a tool answering from the
 * wrong place.
 *
 * ③ `peer_context_status` took its own name from `ctx.self`, decided ONCE when
 *    the MCP server booted — the moment with the least information there will
 *    ever be. `peer_list` was fixed for this in v0.11.50; etl-velitel then
 *    measured the same split HERE, 29 seconds after `peer_list` already
 *    reported the real title. A timing window was ruled out by that gap: it
 *    was two paths to one name, only one of which woke up.
 *
 * ④ `peer_inbox_read` returned bare JSON, so a message read by DRAINING said
 *    nothing about how to answer it, while the identical message read by PUSH
 *    carried the footer. The asymmetry fell exactly on external senders — the
 *    case where the obvious answer (`peer_reply`) is the wrong one.
 */

let dir = "";
let counter = 0;
const id = (n: string) =>
	`${n}-${(++counter).toString(16).padStart(4, "0")}-0000-0000-0000-000000000000`;

async function context(
	name: string,
	source: "env" | "cwd-slug" = "env",
): Promise<ServerContext> {
	return buildContext({
		identity: { id: id(name), name, displayName: name, source },
		baseDir: dir,
		withHeartbeat: false,
		emitTerminalTitle: false,
		version: "0.11.53-test",
		nameRefreshIntervalMs: 0,
	});
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "cb-053-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function payloadOf(result: { content: { text: string }[] }): Record<
	string,
	unknown
> {
	return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("③ peer_context_status answers its own name from the roster", () => {
	test("🔴 THE DEFECT: a name that changed after boot reaches the `to`-less call", async () => {
		// Born with the cwd slug, as every session is before it has a title…
		const ctx = await context("oxy-kb", "cwd-slug");
		// …and the heartbeat, rewritten continuously, learns the real one.
		await ctx.registry.startHeartbeat({
			id: ctx.self.id,
			name: "etl-dev",
			displayName: "etl-dev",
			pid: 1,
			source: "jsonl-title",
		});

		const res = await peerContextStatusTool(ctx, {});
		const peers = payloadOf(res)["peers"] as Record<string, unknown>[];
		expect(peers).toHaveLength(1);
		expect(peers[0]?.["name"]).toBe("etl-dev");
		expect(peers[0]?.["nameSource"]).toBe("jsonl-title");
		// `nameIsFallback` is what made this visible in the first place — it must
		// now be ABSENT, because the name is no longer a fallback.
		expect(peers[0]?.["nameIsFallback"]).toBeUndefined();
	});

	test('`to: "all"` reports self the same way — one answer, one truth', async () => {
		const ctx = await context("oxy-kb", "cwd-slug");
		await ctx.registry.startHeartbeat({
			id: ctx.self.id,
			name: "etl-velitel",
			displayName: "etl-velitel",
			pid: 1,
			source: "jsonl-title",
		});
		const res = await peerContextStatusTool(ctx, { to: "all" });
		const peers = payloadOf(res)["peers"] as Record<string, unknown>[];
		const mine = peers.find((p) => p["id"] === ctx.self.id);
		expect(mine?.["name"]).toBe("etl-velitel");
		expect(mine?.["nameSource"]).toBe("jsonl-title");
	});
});

describe("④ peer_inbox_read carries the footer the push channel carries", () => {
	test("a drained message says how to answer it", async () => {
		const sender = await context("sender");
		const reader = await context("reader");
		for (const c of [sender, reader]) {
			await c.registry.startHeartbeat({
				id: c.self.id,
				name: c.self.name,
				displayName: c.self.displayName,
				pid: 1,
				source: c.self.source,
			});
		}
		await peerAskTool(sender, { to: reader.self.id, content: "ping" });

		const res = await peerInboxReadTool(reader);
		// The JSON is unchanged — this adds a block, it does not replace one.
		expect(payloadOf(res)["count"]).toBe(1);
		const rendered = res.content.map((c) => c.text).join("\n");
		expect(rendered).toContain("📬 INBOX");
		expect(rendered).toContain("peer_reply");
	});

	test("an empty inbox stays quiet — no block, no noise", async () => {
		const lonely = await context("lonely");
		const res = await peerInboxReadTool(lonely);
		expect(payloadOf(res)["count"]).toBe(0);
		expect(res.content).toHaveLength(1);
	});
});

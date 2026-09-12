import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v0.11.57 — the result did not come back to whoever ordered it.
 *
 * Measured by plt-velitel on 2026-09-12, and his own correction is the point:
 * his compact order `mty2z353-cb66` did NOT get lost. It ran, finished, and
 * `events.jsonl` holds the whole chain, ending in `peer_compact_skipped_busy`
 * after 100 seconds. What got lost was the answer reaching HIM — he ordered a
 * compact, heard nothing more, and found out hours later by measuring the
 * target's context. "The result does not come back to the orderer; whoever
 * does not read events.jsonl or measure the target knows nothing."
 *
 * The notice is deliberately narrow: only outcomes where SILENCE READS AS
 * SUCCESS. A successful restart announces itself when the peer says hello.
 */

const homeHolder = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

let home = "";
const CALLER = "11111111-2222-3333-4444-555555555555";

/** A caller with an inbox is a peer; an operator on the CLI is not. */
async function giveCallerAnInbox(): Promise<void> {
  const dir = join(home, ".claude-bridge", "status");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${CALLER}.json`), JSON.stringify({ name: "plt-velitel" }));
}

async function delivered(): Promise<Record<string, unknown>[]> {
  const dir = join(home, ".claude-bridge", "inbox", CALLER, "pending");
  const files = await readdir(dir).catch(() => [] as string[]);
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8"))));
}

function request(tool = "peer_compact", args: Record<string, unknown> = { peer: "ai-velitel" }) {
  return {
    schemaVersion: 1,
    id: "mty2z353-cb66",
    ts: new Date().toISOString(),
    tool,
    args,
    requestedBy: { sessionId: CALLER, name: "plt-velitel" },
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
  } as any;
}

function okResult(data: unknown) {
  return {
    schemaVersion: 1,
    id: "mty2z353-cb66",
    tool: "peer_compact",
    outcome: "ok",
    finishedAt: new Date().toISOString(),
    data,
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
  } as any;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-notify-"));
  homeHolder.current = home;
  vi.resetModules();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("a declined operation reaches the caller", () => {
  it("🔴 THE CASE: skipped_busy is delivered, with the handler's own note", async () => {
    await giveCallerAnInbox();
    const { notifyRequesterIfDeclined } = await import("../src/notify-requester.ts");
    const msgId = await notifyRequesterIfDeclined(
      request(),
      okResult({ outcome: "skipped_busy", note: "The peer was still mid-turn after 100000 ms." }),
    );
    expect(msgId).not.toBeNull();
    const msgs = await delivered();
    expect(msgs).toHaveLength(1);
    const body = String(msgs[0]?.["content"]);
    expect(body).toMatch(/did NOT do what you asked: skipped_busy/);
    expect(body).toMatch(/still mid-turn/);
    // The id is what makes it actionable — control_result and events.jsonl.
    expect(body).toContain("mty2z353-cb66");
    expect(body).toMatch(/on 'ai-velitel'/);
  });

  it("an ERROR result is declined too — the code travels", async () => {
    await giveCallerAnInbox();
    const { notifyRequesterIfDeclined } = await import("../src/notify-requester.ts");
    await notifyRequesterIfDeclined(request("peer_restart"), {
      schemaVersion: 1,
      id: "mty2z353-cb66",
      tool: "peer_restart",
      outcome: "error",
      finishedAt: new Date().toISOString(),
      error: { code: "restart_ready_timeout", message: "NOTHING WAS STOPPED" },
      // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal envelope
    } as any);
    const body = String((await delivered())[0]?.["content"]);
    expect(body).toMatch(/restart_ready_timeout/);
    expect(body).toMatch(/NOTHING WAS STOPPED/);
  });

  it("🟢 a SUCCESS is not announced — the notice must keep meaning 'look at this'", async () => {
    await giveCallerAnInbox();
    const { notifyRequesterIfDeclined } = await import("../src/notify-requester.ts");
    const msgId = await notifyRequesterIfDeclined(
      request(),
      okResult({ outcome: "executed", verified: true }),
    );
    expect(msgId).toBeNull();
    expect(await delivered()).toHaveLength(0);
  });

  it("a caller with no inbox gets nothing — an operator's cli id is not a peer", async () => {
    // No status file written: `cli:test` must not grow a message directory as
    // a side effect of being named in an envelope.
    const { notifyRequesterIfDeclined } = await import("../src/notify-requester.ts");
    const msgId = await notifyRequesterIfDeclined(
      request(),
      okResult({ outcome: "skipped_below_threshold", note: "below the 85% threshold" }),
    );
    expect(msgId).toBeNull();
    expect(await delivered()).toHaveLength(0);
  });
});

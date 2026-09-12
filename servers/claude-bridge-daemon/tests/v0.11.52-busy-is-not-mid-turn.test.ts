/**
 * v0.11.52 — `busy` is not `mid-turn`, and the gate had to learn the difference.
 *
 * Measured within hours of shipping v0.11.51: of 14 fleet restarts, 2 could
 * never pass the new gate. `ai-kb-ops` sat at an empty prompt with an
 * 11-minute-old transcript; `ai-velitel` the same for 4 minutes. Both were
 * reported `busy` by `claude agents --json`, because a peer running a
 * persistent Monitor or background agents is busy by that source's definition
 * for as long as they run. Their graceful restarts could never complete — the
 * only way through was a deliberate `force`, twice in one wave.
 *
 * The fix is a second source, and the whole risk lives in one place: it must
 * pass the two peers that were finished, and must NOT pass the shape the gate
 * exists for (oxy-marketing, 2026-09-12, killed mid-turn with its assistant
 * message still unwritten). Both are reproduced below from the real row
 * shapes.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { turnConcludedFor } from "../src/handlers/turn-end-gate.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cb-turnconcl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function at(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

async function transcript(rows: unknown[]): Promise<string> {
  const path = join(dir, "t.jsonl");
  await writeFile(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

const assistantText = (msAgo: number) => ({
  type: "assistant",
  timestamp: at(msAgo),
  message: { model: "claude-opus-5", content: [{ type: "text", text: "Ack zapsán." }] },
});
const assistantToolUse = (msAgo: number) => ({
  type: "assistant",
  timestamp: at(msAgo),
  message: { model: "claude-opus-5", content: [{ type: "tool_use", name: "Bash", input: {} }] },
});
const userRow = (msAgo: number) => ({
  type: "user",
  timestamp: at(msAgo),
  message: { role: "user", content: "<channel …>restart requested</channel>" },
});

describe("the second source answers `is a turn in flight`, not `is the session busy`", () => {
  it("🟢 ai-kb-ops / ai-velitel: closing text, minutes quiet → the turn is over", async () => {
    const path = await transcript([
      assistantToolUse(11 * 60_000 + 10_000),
      { type: "user", timestamp: at(11 * 60_000 + 9_000), message: { content: [] } },
      assistantText(11 * 60_000),
    ]);
    const quiet = await turnConcludedFor(path);
    expect(quiet).not.toBeNull();
    expect(quiet).toBeGreaterThan(10 * 60_000);
  });

  it("🔴 THE INCIDENT: the request is in, the assistant message is not → still busy", async () => {
    // oxy-marketing at 07:39:55. The kill landed here, and everything the peer
    // had done since the request — including the tool_use that wrote the ack —
    // was still unwritten. A user row means the model has work in hand, and no
    // amount of quiet changes that.
    const path = await transcript([assistantText(600_000), userRow(9 * 60_000)]);
    expect(await turnConcludedFor(path)).toBeNull();
  });

  it("an assistant row that ANNOUNCES a tool call is mid-turn, however old", async () => {
    const path = await transcript([assistantToolUse(30 * 60_000)]);
    expect(await turnConcludedFor(path)).toBeNull();
  });

  it("a turn that ended two seconds ago has not been quiet — keep waiting", async () => {
    // The tail of the acking turn, exactly what v0.11.51 waits out. An interim
    // text block is followed by its tool call within seconds, so a short quiet
    // proves nothing.
    const path = await transcript([assistantText(2_000)]);
    expect(await turnConcludedFor(path)).toBeNull();
  });

  it("bookkeeping rows are skipped — they say nothing about whose turn it is", async () => {
    const path = await transcript([
      assistantText(5 * 60_000),
      { type: "queue-operation", operation: "dequeue" },
      { type: "file-history-snapshot", messageId: "x" },
    ]);
    expect(await turnConcludedFor(path)).not.toBeNull();
  });

  it("an unreadable transcript is `cannot say`, never `the turn is over`", async () => {
    expect(await turnConcludedFor(join(dir, "nope.jsonl"))).toBeNull();
    const partial = join(dir, "half.jsonl");
    await writeFile(partial, '{"type":"assist');
    expect(await turnConcludedFor(partial)).toBeNull();
  });
});

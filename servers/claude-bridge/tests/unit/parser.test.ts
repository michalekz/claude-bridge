import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { countEventsByType, parseSessionFile, readSessionFile } from "../../src/parser/jsonl.ts";
import { isMessageEvent, isMetadataEvent } from "../../src/parser/schemas.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "fixtures", "genesis-session.jsonl");

describe("parseSessionFile (fixture)", () => {
  test("parses without errors and yields events", async () => {
    let count = 0;
    let jsonErrors = 0;
    let validationErrors = 0;
    for await (const _event of parseSessionFile(FIXTURE, {
      onJsonError: () => {
        jsonErrors++;
      },
      onValidationError: () => {
        validationErrors++;
      },
    })) {
      count++;
    }
    expect(count).toBeGreaterThan(0);
    expect(jsonErrors).toBe(0);
    // No tolerance for schema violations — if this fires, schema needs update.
    expect(validationErrors).toBe(0);
  });

  test("readSessionFile returns array", async () => {
    const events = await readSessionFile(FIXTURE);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(50);
  });

  test("countEventsByType detects expected event types", async () => {
    const counts = await countEventsByType(FIXTURE);
    // Genesis session contains all the canonical types except `system`.
    expect(counts.byType["user"]).toBeGreaterThan(0);
    expect(counts.byType["assistant"]).toBeGreaterThan(0);
    expect(counts.byType["queue-operation"]).toBeGreaterThan(0);
    // This fixture happens to use only modelled types — which is precisely why
    // it never caught the 13% undercount on real transcripts. See the
    // "counting does not validate" block below for the representative case.
    expect(counts.unmodelledTypes).toEqual({});
    expect(counts.total).toBe(65);
  });

  test("classifies events as message or metadata", async () => {
    const events = await readSessionFile(FIXTURE);
    const messageEvents = events.filter(isMessageEvent);
    const metadataEvents = events.filter(isMetadataEvent);
    // Every event must be exactly one of the two.
    expect(messageEvents.length + metadataEvents.length).toBe(events.length);
  });

  test("message events have uuid + sessionId", async () => {
    const events = await readSessionFile(FIXTURE);
    for (const e of events) {
      if (!isMessageEvent(e)) continue;
      expect(e.uuid).toBeDefined();
      expect(e.sessionId).toBeDefined();
      // parentUuid is null only for first user message or system compact_boundary.
      expect(e.parentUuid === null || typeof e.parentUuid === "string").toBe(true);
    }
  });

  test("queue-operation enqueue with content is task-notification", async () => {
    const events = await readSessionFile(FIXTURE);
    const queues = events.filter((e) => e.type === "queue-operation");
    const enqueuesWithContent = queues.filter(
      (e) => e.type === "queue-operation" && e.operation === "enqueue" && e.content,
    );
    // If any present, they must contain task-notification markers.
    for (const e of enqueuesWithContent) {
      if (e.type !== "queue-operation") continue;
      expect(e.content).toContain("<task-notification>");
    }
  });
});

/**
 * `session_stats` reported 1 859 events for a session an independent recount
 * put at 2 393 (MCP test 2026-08-04, defect #4).
 *
 * `countEventsByType` streamed through `parseSessionFile`, which drops every
 * line `SessionEventSchema` rejects — and, given no `onValidationError`
 * callback, drops it without a trace. The schema models nine `type`
 * discriminants; a live transcript carries fourteen.
 *
 * The fixture above could not have caught this: every type in it is modelled.
 * These cases use a transcript shaped like a real one instead.
 */
describe("counting does not validate", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cb-count-"));
    file = join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (lines: string[]) => writeFile(file, `${lines.join("\n")}\n`, "utf-8");

  test("THE REGRESSION: types outside the schema are counted, not subtracted", async () => {
    await write([
      // Modelled — these were the only lines the old counter could see.
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({ type: "queue-operation", uuid: randomUUID() }),
      // Written by Claude Code, absent from the schema. On a real session these
      // five types were 2 591 of 19 767 lines.
      JSON.stringify({ type: "pr-link", url: "https://example.invalid/pr/1" }),
      JSON.stringify({ type: "mode", mode: "acceptEdits" }),
      JSON.stringify({ type: "permission-mode", mode: "default" }),
      JSON.stringify({ type: "file-history-delta", delta: {} }),
      JSON.stringify({ type: "agent-name", name: "plt-bridge-dev" }),
    ]);

    const counts = await countEventsByType(file);

    // Before the fix this was 2.
    expect(counts.total).toBe(7);
    expect(counts.byType["pr-link"]).toBe(1);
    expect(counts.byType["mode"]).toBe(1);
    expect(counts.byType["agent-name"]).toBe(1);
  });

  test("the gap is named, so a short count cannot pass for a complete one", async () => {
    await write([
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({ type: "mode", mode: "plan" }),
      JSON.stringify({ type: "mode", mode: "default" }),
      JSON.stringify({ type: "pr-link", url: "https://example.invalid/pr/2" }),
    ]);

    const counts = await countEventsByType(file);

    expect(counts.unmodelledTypes).toEqual({ mode: 2, "pr-link": 1 });
    // The whole point: the caller can see the schema is three lines behind
    // rather than receiving a total quietly three short.
    expect(counts.total).toBe(4);
  });

  test("SECOND LOSS CHANNEL: a modelled type with a bad field still counts", async () => {
    // `last-prompt` is in the schema, but 3 of 1 185 such lines in a real
    // transcript failed field validation and vanished the same way. A type-level
    // fix alone would have left those three unaccounted for.
    await write([
      JSON.stringify({ type: "last-prompt", uuid: randomUUID(), prompt: "ok" }),
      JSON.stringify({ type: "last-prompt", uuid: "not-a-uuid" }),
      JSON.stringify({ type: "last-prompt" }),
    ]);

    const counts = await countEventsByType(file);

    expect(counts.byType["last-prompt"]).toBe(3);
    expect(counts.total).toBe(3);
    // The type IS modelled — the loss was field-level, so it must not be
    // reported as a schema gap.
    expect(counts.unmodelledTypes).toEqual({});
  });

  test("unparseable lines are reported rather than ignored", async () => {
    await write([
      JSON.stringify({ type: "user", uuid: randomUUID(), message: { role: "user", content: "x" } }),
      "{ this is not json",
      JSON.stringify({ type: "assistant", uuid: randomUUID() }),
    ]);

    const counts = await countEventsByType(file);

    expect(counts.total).toBe(2);
    expect(counts.malformedLines).toBe(1);
  });

  test("a line without a type field is named, not dropped", async () => {
    await write([JSON.stringify({ uuid: randomUUID(), note: "no type key" })]);

    const counts = await countEventsByType(file);

    expect(counts.total).toBe(1);
    expect(counts.byType["(no type field)"]).toBe(1);
    expect(counts.unmodelledTypes["(no type field)"]).toBe(1);
  });
});

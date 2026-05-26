import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
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
    expect(counts["user"]).toBeGreaterThan(0);
    expect(counts["assistant"]).toBeGreaterThan(0);
    expect(counts["queue-operation"]).toBeGreaterThan(0);
    // Sanity: no unknown types leak through (would mean schema rejected event).
    const knownTypes = new Set([
      "assistant",
      "user",
      "queue-operation",
      "last-prompt",
      "custom-title",
      "file-history-snapshot",
      "ai-title",
      "attachment",
      "system",
    ]);
    for (const k of Object.keys(counts)) {
      expect(knownTypes.has(k)).toBe(true);
    }
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

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * events.jsonl rotation (v0.10.2).
 *
 * The alpha left a comment saying rotation "lives in F2". F2 never happened,
 * so the audit log was append-only forever. It looked harmless because the
 * daemon was idle — 33 KB after 256 hours. The RPC overlap bug found on
 * 3. 8. would have written ~12 000 entries from one `team_stop` call, which
 * is what turns "grows slowly" into "grows without bound".
 *
 * Rotation must never lose a written entry to truncation: rename only.
 */

describe("events.jsonl rotation", () => {
  let home: string;
  let controlDir: string;
  let eventsPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cb-events-"));
    process.env["HOME"] = home;
    controlDir = join(home, ".claude-bridge", "control");
    eventsPath = join(controlDir, "events.jsonl");
    // Fresh module per test — rotation keeps a byte counter in module state.
    // Reusing it across tests would make each test depend on the last.
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    // process.env is Record<string,string>: assigning undefined stores the
    // literal string "undefined", so delete is the only way to unset a var.
    // biome-ignore lint/performance/noDelete: see above
    delete process.env["CLAUDE_BRIDGE_EVENTS_MAX_BYTES"];
  });

  const load = async () => await import("../src/events.ts");

  it("appends without rotating while under the size cap", async () => {
    const { writeEvent } = await load();
    for (let i = 0; i < 20; i++) {
      await writeEvent({ event: "test_event", details: { i } });
    }
    const lines = (await readFile(eventsPath, "utf-8")).trim().split("\n");
    expect(lines.length).toBe(20);
    expect(JSON.parse(lines[0] as string).event).toBe("test_event");
    await expect(stat(`${eventsPath}.1`)).rejects.toThrow();
  });

  it("rotates to .1 once the cap is crossed, moving content rather than truncating", async () => {
    // Drive rotation with REAL writes at a small cap. Pre-filling the file
    // behind the module's back proved nothing: the size counter assumes a
    // single writer, so an external append is invisible to it by design.
    // An entry with a 100-char pad measures 251 B (measured, not guessed).
    // Cap at 6 entries' worth and write 10: rotation fires once, and the 4
    // that follow stay under the cap so a second rotation cannot happen.
    // Sizing this loosely is how the first version of this test ended up
    // asserting against generations it never read.
    process.env["CLAUDE_BRIDGE_EVENTS_MAX_BYTES"] = String(6 * 251);
    const { writeEvent } = await load();

    const TOTAL = 10;
    for (let i = 0; i < TOTAL; i++) {
      await writeEvent({
        event: "filler",
        details: { i, pad: "x".repeat(100) },
      });
    }

    const rotated = (await readFile(`${eventsPath}.1`, "utf-8")).trim().split("\n");
    const live = (await readFile(eventsPath, "utf-8")).trim().split("\n");

    // Exactly one rotation, and nothing lost across the boundary.
    await expect(stat(`${eventsPath}.2`)).rejects.toThrow();
    expect(rotated.length + live.length).toBe(TOTAL);

    // Every index appears exactly once — no entry truncated away, none doubled.
    const indices = [...rotated, ...live].map((l) => JSON.parse(l).details.i).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: TOTAL }, (_, i) => i));
  });

  it("keeps three generations and drops the fourth", async () => {
    process.env["CLAUDE_BRIDGE_EVENTS_MAX_BYTES"] = "600";
    const { writeEvent, EVENTS_KEEP_ROTATIONS } = await load();

    for (let i = 0; i < 60; i++) {
      await writeEvent({
        event: "filler",
        details: { i, pad: "y".repeat(100) },
      });
    }

    for (let i = 1; i <= EVENTS_KEEP_ROTATIONS; i++) {
      await expect(stat(`${eventsPath}.${i}`)).resolves.toBeDefined();
    }
    await expect(stat(`${eventsPath}.${EVENTS_KEEP_ROTATIONS + 1}`)).rejects.toThrow();
  });

  it("serialises concurrent writers — no interleaved or lost lines", async () => {
    // writeEvent is called from many handlers at once. Without the chain, an
    // append could land in a file that a rotation had just renamed away.
    const { writeEvent } = await load();
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => writeEvent({ event: "concurrent", details: { i } })),
    );
    const lines = (await readFile(eventsPath, "utf-8")).trim().split("\n");
    expect(lines.length).toBe(200);
    // Every line must be complete JSON — a torn write would throw here.
    const seen = new Set<number>();
    for (const line of lines) seen.add(JSON.parse(line).details.i);
    expect(seen.size).toBe(200);
  });
});

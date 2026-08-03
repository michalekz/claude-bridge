import { appendFile, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLatestTitleFromJsonl, resetTitleScanCache } from "../../src/identity.ts";

/**
 * Incremental title scan (fix, 2026-08-03).
 *
 * The scan reads a transcript once and then only the bytes appended since, so
 * correctness now depends on cache invalidation rather than on re-reading
 * everything. These tests cover the ways that can go wrong; the performance
 * numbers are in the CHANGELOG.
 */
describe("readLatestTitleFromJsonl — incremental scan", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cb-title-"));
    file = join(dir, "transcript.jsonl");
    resetTitleScanCache();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const noise = (n: number) =>
    Array.from({ length: n }, (_, i) => line({ type: "user", message: `filler ${i}` })).join("");

  it("finds the ai-title on the first pass", async () => {
    await writeFile(
      file,
      noise(50) + line({ type: "ai-title", aiTitle: "First Title" }) + noise(50),
    );
    expect(await readLatestTitleFromJsonl(file)).toBe("First Title");
  });

  it("picks up a custom-title APPENDED after the first scan — the /rename case", async () => {
    await writeFile(file, noise(20) + line({ type: "ai-title", aiTitle: "Auto Title" }));
    expect(await readLatestTitleFromJsonl(file)).toBe("Auto Title");

    // /rename writes at the END of the file, long after the initial scan. This
    // is the case a head-only read would miss entirely.
    await appendFile(file, noise(20) + line({ type: "custom-title", customTitle: "renamed-peer" }));
    expect(await readLatestTitleFromJsonl(file)).toBe("renamed-peer");
  });

  it("keeps returning the cached answer while the file is untouched", async () => {
    await writeFile(file, line({ type: "ai-title", aiTitle: "Stable" }));
    expect(await readLatestTitleFromJsonl(file)).toBe("Stable");
    expect(await readLatestTitleFromJsonl(file)).toBe("Stable");
    expect(await readLatestTitleFromJsonl(file)).toBe("Stable");
  });

  it("rescans from scratch when the file SHRINKS below the cached offset", async () => {
    await writeFile(file, noise(30) + line({ type: "ai-title", aiTitle: "Before Rotation" }));
    expect(await readLatestTitleFromJsonl(file)).toBe("Before Rotation");

    // Rotated / replaced / restored. Reading at the stale offset would return
    // garbage or nothing.
    await writeFile(file, line({ type: "ai-title", aiTitle: "After Rotation" }));
    expect(await readLatestTitleFromJsonl(file)).toBe("After Rotation");
  });

  it("rescans when mtime moves BACKWARDS at the same size", async () => {
    const a = line({ type: "ai-title", aiTitle: "AAAAA" });
    const b = line({ type: "ai-title", aiTitle: "BBBBB" });
    expect(a.length).toBe(b.length); // same size on purpose — only mtime differs

    await writeFile(file, a);
    expect(await readLatestTitleFromJsonl(file)).toBe("AAAAA");

    // A restore from backup can leave an OLDER mtime with an identical size.
    // Without the backwards-mtime check this would answer from a stale cache.
    await writeFile(file, b);
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);
    expect(await readLatestTitleFromJsonl(file)).toBe("BBBBB");
  });

  it("prefers custom-title over ai-title regardless of order", async () => {
    await writeFile(
      file,
      line({ type: "custom-title", customTitle: "chosen" }) +
        line({ type: "ai-title", aiTitle: "generated" }),
    );
    expect(await readLatestTitleFromJsonl(file)).toBe("chosen");
  });

  it("takes the LAST title when several are appended over time", async () => {
    await writeFile(file, line({ type: "custom-title", customTitle: "one" }));
    expect(await readLatestTitleFromJsonl(file)).toBe("one");
    await appendFile(file, line({ type: "custom-title", customTitle: "two" }));
    expect(await readLatestTitleFromJsonl(file)).toBe("two");
    await appendFile(file, line({ type: "custom-title", customTitle: "three" }));
    expect(await readLatestTitleFromJsonl(file)).toBe("three");
  });

  it("survives a multi-byte character landing exactly on the 256 KB chunk seam", async () => {
    // Two hazards at the same edge, built with exact byte arithmetic:
    //   1. a two-byte character whose bytes fall on either side of the seam —
    //      a naive Buffer.toString() per chunk would replace it with U+FFFD;
    //   2. the title line itself starting before the seam and ending after it,
    //      so the line-carry has to work too.
    const CHUNK = 256 * 1024;
    const PREFIX = '{"type":"user","message":"';
    const SEAM_CHAR = "ž"; // 2 bytes in UTF-8

    // Place SEAM_CHAR so its first byte is the last byte of chunk 1.
    const fillerLen = CHUNK - 1 - Buffer.byteLength(PREFIX);
    const padLine = `${PREFIX}${"a".repeat(fillerLen)}${SEAM_CHAR}"}\n`;
    expect(Buffer.byteLength(padLine.slice(0, PREFIX.length + fillerLen))).toBe(CHUNK - 1);

    const target = line({ type: "custom-title", customTitle: "žluťoučký-kůň-úpěl" });
    await writeFile(file, padLine + target);

    // The padding line must survive as valid JSON (proves the decoder handled
    // the seam) and the title after it must be found (proves the line carry).
    const contents = await readFile(file, "utf-8");
    const firstLine = contents.split("\n")[0] as string;
    expect(JSON.parse(firstLine).message.endsWith(SEAM_CHAR)).toBe(true);
    expect(await readLatestTitleFromJsonl(file)).toBe("žluťoučký-kůň-úpěl");
  });

  it("returns null for a missing file and survives a malformed line", async () => {
    expect(await readLatestTitleFromJsonl(join(dir, "nope.jsonl"))).toBeNull();
    await writeFile(
      file,
      `{"type":"ai-title" BROKEN\n${line({ type: "ai-title", aiTitle: "ok" })}`,
    );
    expect(await readLatestTitleFromJsonl(file)).toBe("ok");
  });
});

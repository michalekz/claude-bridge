import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { atomicWrite, atomicWriteJson } from "../../src/util/atomic-write.ts";

describe("atomicWrite", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-bridge-atomic-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes content to fresh path", async () => {
    const target = join(dir, "fresh.txt");
    await atomicWrite(target, "hello world");
    expect(await readFile(target, "utf-8")).toBe("hello world");
  });

  test("overwrites existing file", async () => {
    const target = join(dir, "overwrite.txt");
    await writeFile(target, "old content");
    await atomicWrite(target, "new content");
    expect(await readFile(target, "utf-8")).toBe("new content");
  });

  test("creates parent directory by default", async () => {
    const target = join(dir, "deep", "nested", "file.txt");
    await atomicWrite(target, "content");
    expect(await readFile(target, "utf-8")).toBe("content");
  });

  test("writes Buffer / Uint8Array content", async () => {
    const target = join(dir, "binary.bin");
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0xff]);
    await atomicWrite(target, bytes);
    const read = await readFile(target);
    expect(Array.from(read)).toEqual([0x01, 0x02, 0x03, 0xff]);
  });

  test("does not leave temp files on success", async () => {
    const target = join(dir, "clean.txt");
    await atomicWrite(target, "data");
    const files = await readdir(dir);
    const tempFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tempFiles).toEqual([]);
  });

  test("concurrent writes do not corrupt — final state is one of the writers", async () => {
    const target = join(dir, "concurrent.txt");
    const writers = Array.from({ length: 10 }, (_, i) => atomicWrite(target, `writer-${i}`));
    await Promise.all(writers);
    const content = await readFile(target, "utf-8");
    expect(content.startsWith("writer-")).toBe(true);
    expect(content.length).toBe(8); // exactly "writer-X"
  });

  test("custom encoding (utf-16)", async () => {
    const target = join(dir, "utf16.txt");
    await atomicWrite(target, "ahoj", { encoding: "utf16le" });
    const read = await readFile(target);
    // utf-16le encodes each char as 2 bytes
    expect(read.length).toBe(8);
  });

  test("propagates write errors (invalid path)", async () => {
    // Path with embedded null byte — write should fail
    const bad = join(dir, "bad\0name.txt");
    await expect(atomicWrite(bad, "x")).rejects.toThrow();
  });

  test("preserves content even when target's parent has stale temp files", async () => {
    const target = join(dir, "with-stale.txt");
    // Pre-create a stale temp file that should not interfere
    await writeFile(join(dir, ".staletmp.tmp"), "stale");
    await atomicWrite(target, "real");
    expect(await readFile(target, "utf-8")).toBe("real");
    // Stale temp file is untouched (we only clean up our OWN temp on error)
    expect(await readFile(join(dir, ".staletmp.tmp"), "utf-8")).toBe("stale");
  });

  test("file mtime updates on overwrite (proxy for replace, not in-place edit)", async () => {
    const target = join(dir, "mtime.txt");
    await atomicWrite(target, "v1");
    const stat1 = await stat(target);
    await new Promise((r) => setTimeout(r, 20));
    await atomicWrite(target, "v2");
    const stat2 = await stat(target);
    expect(stat2.mtimeMs).toBeGreaterThanOrEqual(stat1.mtimeMs);
  });
});

describe("atomicWriteJson", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-bridge-atomic-json-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes JSON with pretty print", async () => {
    const target = join(dir, "obj.json");
    await atomicWriteJson(target, { name: "mantis", count: 42 });
    const content = await readFile(target, "utf-8");
    expect(content).toContain('"name": "mantis"');
    expect(content).toContain('"count": 42');
    // Pretty-printed → multi-line
    expect(content.split("\n").length).toBeGreaterThan(2);
  });

  test("appends trailing newline", async () => {
    const target = join(dir, "newline.json");
    await atomicWriteJson(target, { x: 1 });
    const content = await readFile(target, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  test("roundtrip parse equals input", async () => {
    const target = join(dir, "roundtrip.json");
    const original = { peer: "mantis", tags: ["a", "b"], nested: { ok: true } };
    await atomicWriteJson(target, original);
    const parsed = JSON.parse(await readFile(target, "utf-8"));
    expect(parsed).toEqual(original);
  });
});

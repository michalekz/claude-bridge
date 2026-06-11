import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  emitTerminalTitle,
  findParentTty,
  isTerminalTitleEnabled,
  parseTtyNrFromProcStat,
} from "../../src/util/terminal-title.ts";

describe("parseTtyNrFromProcStat", () => {
  test("decodes pts/0 tty_nr (major 136, minor 0)", () => {
    // tty_nr = (major << 8) | minor → 136*256 = 34816
    // Stat: pid (comm) state ppid pgrp session tty_nr ...
    const stat = "1234 (bash) S 1000 1234 1234 34816 0 ...";
    expect(parseTtyNrFromProcStat(stat)).toEqual({ major: 136, minor: 0 });
  });

  test("decodes pts/5 tty_nr (major 136, minor 5)", () => {
    const ttyNr = (136 << 8) | 5;
    const stat = `4242 (cmd) S 1 4242 4242 ${ttyNr} 0 ...`;
    expect(parseTtyNrFromProcStat(stat)).toEqual({ major: 136, minor: 5 });
  });

  test("decodes high-minor pty (e.g. minor 257) from split LSB/MSB bits", () => {
    // minor 257 = 0x101 — LSB=0x01, MSB high bits=0x1
    // Encoding: bits 0..7 = LSB (0x01), bits 12..19 (shifted left 12) for MSB upper bits
    // tty_nr = (major << 8) | (minorLSB) | ((minorMSB) << 12) — minorMSB upper bits start at bit 8 of minor
    // minor 257 → LSB = 257 & 0xFF = 1; MSB = (257 >> 8) << 12 = 1 << 12 = 0x1000
    // Plus major << 8 = 136 * 256 = 0x8800
    // Total tty_nr = 0x8800 | 0x01 | 0x1000 = 0x9801
    const ttyNr = (136 << 8) | (257 & 0xff) | ((257 >> 8) << 20);
    const stat = `5555 (cmd) S 1 5555 5555 ${ttyNr} 0 ...`;
    const result = parseTtyNrFromProcStat(stat);
    expect(result?.major).toBe(136);
    expect(result?.minor).toBe(257);
  });

  test("handles comm with embedded space and parens", () => {
    // /proc/PID/stat: comm is enclosed in parens but the inner string can
    // contain spaces and parens. Robust parser splits on LAST `)`.
    const ttyNr = (136 << 8) | 3;
    const stat = `1234 (some app (with) parens) S 1 1234 1234 ${ttyNr} 0 ...`;
    expect(parseTtyNrFromProcStat(stat)).toEqual({ major: 136, minor: 3 });
  });

  test("returns null when tty_nr is 0 (no controlling terminal)", () => {
    const stat = "1234 (daemon) S 1 1234 1234 0 -1 ...";
    expect(parseTtyNrFromProcStat(stat)).toBeNull();
  });

  test("returns null for malformed stat (no closing paren)", () => {
    expect(parseTtyNrFromProcStat("malformed")).toBeNull();
  });

  test("returns null when tty_nr field missing", () => {
    expect(parseTtyNrFromProcStat("1234 (cmd) S 1 2 3")).toBeNull();
  });
});

describe("emitTerminalTitle", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "claude-bridge-tty-emit-"));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("writes OSC 2 escape sequence to the target path", async () => {
    const target = join(tmp, "fake-tty");
    await writeFile(target, ""); // pre-create so openSync("w") truncates predictably
    emitTerminalTitle(target, "Marketingový stratég");
    const content = await readFile(target, "utf-8");
    expect(content).toBe("\x1b]2;Marketingový stratég\x07");
  });

  test("silently fails on non-existent path (no throw)", () => {
    // Target dir doesn't exist — openSync should fail, but emit absorbs it.
    expect(() => emitTerminalTitle("/no/such/path/fake-tty", "X")).not.toThrow();
  });

  test("supports titles with embedded special chars (slashes, dashes, unicode)", async () => {
    const target = join(tmp, "fake-tty-special");
    await writeFile(target, "");
    emitTerminalTitle(target, "Web Developer — /opt/project");
    const content = await readFile(target, "utf-8");
    expect(content).toBe("\x1b]2;Web Developer — /opt/project\x07");
  });
});

describe("isTerminalTitleEnabled", () => {
  test("defaults to enabled when env var unset", () => {
    expect(isTerminalTitleEnabled({})).toBe(true);
  });

  test("defaults to enabled when env var is empty string", () => {
    expect(isTerminalTitleEnabled({ CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE: "" })).toBe(true);
  });

  test('disabled when env var is "0"', () => {
    expect(isTerminalTitleEnabled({ CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE: "0" })).toBe(false);
  });

  test('disabled when env var is "false" (case-insensitive)', () => {
    expect(isTerminalTitleEnabled({ CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE: "false" })).toBe(false);
    expect(isTerminalTitleEnabled({ CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE: "FALSE" })).toBe(false);
    expect(isTerminalTitleEnabled({ CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE: "False" })).toBe(false);
  });

  test('enabled for "1" / "true" / arbitrary non-disable values', () => {
    expect(isTerminalTitleEnabled({ CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE: "1" })).toBe(true);
    expect(isTerminalTitleEnabled({ CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE: "true" })).toBe(true);
    expect(isTerminalTitleEnabled({ CLAUDE_BRIDGE_EMIT_TERMINAL_TITLE: "yes" })).toBe(true);
  });
});

describe("findParentTty platform dispatch", () => {
  test("returns null on Windows (not yet supported)", () => {
    expect(findParentTty(1234, "win32")).toBeNull();
  });

  test("returns null on freebsd or other unsupported platform", () => {
    expect(findParentTty(1234, "freebsd")).toBeNull();
  });

  // Linux/macOS branches are exercised by integration (real ppid lookup).
  // Unit-testing them would require mocking /proc reads or `ps` spawns —
  // not worth the indirection. The parser logic is tested above in
  // `parseTtyNrFromProcStat`.
});

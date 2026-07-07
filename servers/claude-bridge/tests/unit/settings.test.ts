import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock os.homedir BEFORE importing the module under test so `claudeHome()`
// resolves to our per-test temp directory.
let tmpHome: string;

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import { claudeSettingsPath, readClaudeSettings } from "../../src/parser/settings.ts";

describe("readClaudeSettings", () => {
  let claudeDir: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "cb-settings-test-"));
    claudeDir = join(tmpHome, ".claude");
    // Directory created lazily by writeFile via mkdir; make it ahead so tests
    // that don't write anything still exercise the "file missing" branch.
    await import("node:fs/promises").then((fs) => fs.mkdir(claudeDir, { recursive: true }));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
  });

  test("returns null when settings.json is absent", async () => {
    const result = await readClaudeSettings();
    expect(result).toBeNull();
  });

  test("returns null on malformed JSON", async () => {
    await writeFile(claudeSettingsPath(), "{ not valid json");
    const result = await readClaudeSettings();
    expect(result).toBeNull();
  });

  test("returns null when JSON is not an object (e.g. array)", async () => {
    await writeFile(claudeSettingsPath(), JSON.stringify(["not", "an", "object"]));
    const result = await readClaudeSettings();
    expect(result).toBeNull();
  });

  test("returns { model } when settings.model is a string with [1m] suffix", async () => {
    await writeFile(
      claudeSettingsPath(),
      JSON.stringify({ model: "claude-fable-5[1m]", other: "field" }),
    );
    const result = await readClaudeSettings();
    expect(result).toEqual({ model: "claude-fable-5[1m]" });
  });

  test("returns { model } when settings.model is a bare id (no [1m])", async () => {
    await writeFile(claudeSettingsPath(), JSON.stringify({ model: "claude-opus-4-8" }));
    const result = await readClaudeSettings();
    expect(result).toEqual({ model: "claude-opus-4-8" });
  });

  test("omits model when settings.json exists but has no model key", async () => {
    await writeFile(claudeSettingsPath(), JSON.stringify({ cleanupPeriodDays: 30 }));
    const result = await readClaudeSettings();
    expect(result).toEqual({});
    expect(result?.model).toBeUndefined();
  });

  test("ignores non-string model (e.g. null / number)", async () => {
    await writeFile(claudeSettingsPath(), JSON.stringify({ model: null }));
    const result = await readClaudeSettings();
    expect(result).toEqual({});

    await writeFile(claudeSettingsPath(), JSON.stringify({ model: 42 }));
    const result2 = await readClaudeSettings();
    expect(result2).toEqual({});
  });

  test("claudeSettingsPath points at ~/.claude/settings.json", () => {
    expect(claudeSettingsPath()).toBe(join(tmpHome, ".claude", "settings.json"));
  });
});

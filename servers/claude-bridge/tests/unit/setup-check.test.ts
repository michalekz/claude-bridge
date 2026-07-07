import { describe, expect, test } from "vitest";

// Import internals through their public API. compareVersions and banner logic
// aren't exported directly — we test through the module's overall behavior
// via imports we do expose. For now this file focuses on unit tests of the
// helpers we're most likely to regress on (semver compare, config detection).

// Since setup-check main() has side effects (file writes, process.stderr),
// we mirror its comparison helpers in tests as documented behavior. If we
// export them from main.ts in the future, switch to direct import.

/**
 * Compare semver-ish strings the way setup-check does. Copy of the private
 * helper — kept in sync with src/setup-check/main.ts. If this diverges,
 * setup-check picks the wrong cache dir on version boundaries.
 */
function compareVersions(a: string, b: string): number {
  const [aBase, aPre] = a.split("-", 2);
  const [bBase, bPre] = b.split("-", 2);
  const aParts = (aBase ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bParts = (bBase ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre.localeCompare(bPre);
  return 0;
}

describe("setup-check version comparison", () => {
  test("higher patch wins", () => {
    expect(compareVersions("0.9.1", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.9.1")).toBeLessThan(0);
  });

  test("higher minor wins", () => {
    expect(compareVersions("0.10.0", "0.9.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  test("higher major wins", () => {
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  test("release beats pre-release with same base", () => {
    expect(compareVersions("0.9.0", "0.9.0-alpha.1")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0-alpha.1", "0.9.0")).toBeLessThan(0);
  });

  test("pre-release ordering by suffix", () => {
    expect(compareVersions("0.9.0-alpha.2", "0.9.0-alpha.1")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0-beta.1", "0.9.0-alpha.9")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0-rc.1", "0.9.0-beta.99")).toBeGreaterThan(0);
  });

  test("equal versions return 0", () => {
    expect(compareVersions("0.9.0", "0.9.0")).toBe(0);
    expect(compareVersions("0.9.0-alpha.2", "0.9.0-alpha.2")).toBe(0);
  });

  test("sort() picks the latest via .pop()", () => {
    const versions = ["0.8.3", "0.9.0", "0.9.0-alpha.1", "0.9.0-alpha.2", "0.7.4", "0.8.2"];
    versions.sort(compareVersions);
    expect(versions.pop()).toBe("0.9.0");
  });
});

/**
 * Mirror of setup-check's isStatusLineConfigured helper. Detects whether
 * the user's settings.json already points at our wrapper by substring
 * match on the command string.
 */
function isStatusLineConfigured(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return (
    cmd.includes("claude-bridge-statusline") || cmd.includes("claude-bridge-statusline-wrapper")
  );
}

describe("setup-check statusLine detection", () => {
  test("recognizes wrapper.sh", () => {
    expect(isStatusLineConfigured("~/.claude/claude-bridge-statusline-wrapper.sh")).toBe(true);
  });

  test("recognizes direct statusline.cjs invocation", () => {
    expect(isStatusLineConfigured("node ~/.claude/claude-bridge-statusline.cjs")).toBe(true);
  });

  test("recognizes CLAUDE_PLUGIN_ROOT path in a hook context (defensive)", () => {
    // Not actually valid in statusLine, but users might copy-paste from
    // a hook example. isStatusLineConfigured is substring-only so it
    // matches regardless of path shape.
    expect(
      isStatusLineConfigured("node ${CLAUDE_PLUGIN_ROOT}/dist/claude-bridge-statusline.cjs"),
    ).toBe(true);
  });

  test("does NOT recognize benabraham's status line", () => {
    expect(isStatusLineConfigured("~/.claude/claude-code-status-line.py")).toBe(false);
  });

  test("does NOT recognize empty / undefined", () => {
    expect(isStatusLineConfigured(undefined)).toBe(false);
    expect(isStatusLineConfigured("")).toBe(false);
  });
});

/**
 * Mirror of isHookConfigured. Walks the PostToolUse array (merged with
 * user's own hooks) looking for our refresh-limits command.
 */
function isHookConfigured(
  groups: Array<{ hooks?: Array<{ command?: string }> }> | undefined,
): boolean {
  if (!groups) return false;
  for (const group of groups) {
    for (const h of group.hooks ?? []) {
      if (h.command?.includes("claude-bridge-refresh-limits")) return true;
    }
  }
  return false;
}

describe("setup-check PostToolUse hook detection", () => {
  test("recognizes our hook alone", () => {
    const groups = [
      {
        hooks: [{ command: "node ~/.claude/claude-bridge-refresh-limits.cjs" }],
      },
    ];
    expect(isHookConfigured(groups)).toBe(true);
  });

  test("recognizes our hook mixed with user's own", () => {
    const groups = [
      {
        hooks: [
          { command: "prettier --write" },
          { command: "node ~/.claude/claude-bridge-refresh-limits.cjs" },
        ],
      },
    ];
    expect(isHookConfigured(groups)).toBe(true);
  });

  test("recognizes in multiple matcher groups", () => {
    const groups = [
      { matcher: "Bash", hooks: [{ command: "somelogger" }] },
      { matcher: ".*", hooks: [{ command: "node ~/.claude/claude-bridge-refresh-limits.cjs" }] },
    ] as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    expect(isHookConfigured(groups)).toBe(true);
  });

  test("does NOT recognize unrelated PostToolUse hooks", () => {
    const groups = [
      { hooks: [{ command: "prettier --write" }] },
      { hooks: [{ command: "eslint --fix" }] },
    ];
    expect(isHookConfigured(groups)).toBe(false);
  });

  test("handles undefined / empty gracefully", () => {
    expect(isHookConfigured(undefined)).toBe(false);
    expect(isHookConfigured([])).toBe(false);
    expect(isHookConfigured([{ hooks: [] }])).toBe(false);
  });
});

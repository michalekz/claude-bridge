import { homedir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  bridgeRoot,
  claudeHome,
  encodeProjectDir,
  inboxDir,
  peerRegistryFile,
  projectDir,
  projectsRoot,
  sessionFile,
  sessionIndexFile,
} from "../../src/util/paths.ts";

describe("encodeProjectDir", () => {
  describe("Linux/macOS", () => {
    test("converts /opt/oxy-kb → -opt-oxy-kb", () => {
      expect(encodeProjectDir("/opt/oxy-kb", "linux")).toBe("-opt-oxy-kb");
    });

    test("converts root path /", () => {
      expect(encodeProjectDir("/", "linux")).toBe("-");
    });

    test("collapses consecutive slashes", () => {
      expect(encodeProjectDir("/opt//oxy-kb", "linux")).toBe("-opt-oxy-kb");
    });

    test("handles trailing slash", () => {
      expect(encodeProjectDir("/opt/oxy-kb/", "linux")).toBe("-opt-oxy-kb-");
    });

    test("handles macOS path", () => {
      expect(encodeProjectDir("/Users/me/projects/foo", "darwin")).toBe("-Users-me-projects-foo");
    });
  });

  describe("Windows", () => {
    test("converts C:\\Users\\me\\proj → C--Users-me-proj", () => {
      expect(encodeProjectDir("C:\\Users\\me\\proj", "win32")).toBe("C--Users-me-proj");
    });

    test("handles forward slashes on Windows", () => {
      expect(encodeProjectDir("C:/Users/me/proj", "win32")).toBe("C--Users-me-proj");
    });

    test("handles mixed separators", () => {
      expect(encodeProjectDir("C:\\Users/me\\proj", "win32")).toBe("C--Users-me-proj");
    });

    test("handles drive root C:\\", () => {
      expect(encodeProjectDir("C:\\", "win32")).toBe("C--");
    });

    test("collapses consecutive backslashes", () => {
      expect(encodeProjectDir("C:\\\\Users\\\\me", "win32")).toBe("C--Users-me");
    });
  });
});

describe("path resolvers (current platform)", () => {
  test("claudeHome under user home", () => {
    expect(claudeHome().startsWith(homedir())).toBe(true);
    expect(claudeHome().endsWith(".claude")).toBe(true);
  });

  test("projectsRoot ends with projects", () => {
    expect(projectsRoot().endsWith("projects")).toBe(true);
  });

  test("projectDir for known path", () => {
    const result = projectDir("/opt/oxy-kb");
    expect(result).toContain(".claude");
    expect(result).toContain("projects");
    expect(result.endsWith("-opt-oxy-kb")).toBe(true);
  });

  test("sessionFile composes correctly", () => {
    const result = sessionFile("/opt/oxy-kb", "abc-123");
    expect(result.endsWith("-opt-oxy-kb/abc-123.jsonl")).toBe(true);
  });

  test("bridgeRoot is ~/.claude-bridge", () => {
    expect(bridgeRoot().startsWith(homedir())).toBe(true);
    expect(bridgeRoot().endsWith(".claude-bridge")).toBe(true);
  });

  test("inboxDir composes for peer name", () => {
    expect(inboxDir("mantis").endsWith(".claude-bridge/inbox/mantis")).toBe(true);
  });

  test("peerRegistryFile composes JSON", () => {
    expect(peerRegistryFile("mantis").endsWith(".claude-bridge/peers/mantis.json")).toBe(true);
  });

  test("sessionIndexFile points to SQLite", () => {
    expect(sessionIndexFile().endsWith(".claude-bridge/index/sessions.sqlite")).toBe(true);
  });
});

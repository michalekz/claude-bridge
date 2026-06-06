import { homedir } from "node:os";
import { join } from "node:path";
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
    test("converts /opt/my-project → -opt-my-project", () => {
      expect(encodeProjectDir("/opt/my-project", "linux")).toBe("-opt-my-project");
    });

    test("converts root path /", () => {
      expect(encodeProjectDir("/", "linux")).toBe("-");
    });

    test("collapses consecutive slashes", () => {
      expect(encodeProjectDir("/opt//my-project", "linux")).toBe("-opt-my-project");
    });

    test("handles trailing slash", () => {
      expect(encodeProjectDir("/opt/my-project/", "linux")).toBe("-opt-my-project-");
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

    test("Windows path with spaces (each space → dash, no collapsing)", () => {
      expect(encodeProjectDir("C:\\My Project\\sub dir", "win32")).toBe("C--My-Project-sub-dir");
    });

    test("Windows path with dots (each dot → dash)", () => {
      expect(encodeProjectDir("C:\\Users\\me\\s.r.o", "win32")).toBe("C--Users-me-s-r-o");
    });

    test("Windows path with non-ASCII chars (Czech diacritics → dashes)", () => {
      expect(
        encodeProjectDir("o:\\MICRONIC Přerov s.r.o\\Micronic - Dokumenty\\Marketing", "win32"),
      ).toBe("o--MICRONIC-P-erov-s-r-o-Micronic---Dokumenty-Marketing");
    });

    test("Windows: literal dashes in path are preserved", () => {
      expect(encodeProjectDir("C:\\foo-bar\\baz", "win32")).toBe("C--foo-bar-baz");
    });
  });

  describe("Linux/macOS with non-alphanumeric chars", () => {
    test("Linux path with spaces (each space → dash)", () => {
      expect(encodeProjectDir("/opt/my project/foo bar", "linux")).toBe("-opt-my-project-foo-bar");
    });

    test("Linux path with dots", () => {
      expect(encodeProjectDir("/opt/s.r.o", "linux")).toBe("-opt-s-r-o");
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
    const result = projectDir("/opt/my-project");
    expect(result).toContain(".claude");
    expect(result).toContain("projects");
    expect(result.endsWith("-opt-my-project")).toBe(true);
  });

  test("sessionFile composes correctly", () => {
    const result = sessionFile("/opt/my-project", "abc-123");
    expect(result.endsWith(join("-opt-my-project", "abc-123.jsonl"))).toBe(true);
  });

  test("bridgeRoot is ~/.claude-bridge", () => {
    expect(bridgeRoot().startsWith(homedir())).toBe(true);
    expect(bridgeRoot().endsWith(".claude-bridge")).toBe(true);
  });

  test("inboxDir composes for peer name", () => {
    expect(inboxDir("mantis").endsWith(join(".claude-bridge", "inbox", "mantis"))).toBe(true);
  });

  test("peerRegistryFile composes JSON", () => {
    expect(
      peerRegistryFile("mantis").endsWith(join(".claude-bridge", "peers", "mantis.json")),
    ).toBe(true);
  });

  test("sessionIndexFile points to SQLite", () => {
    expect(sessionIndexFile().endsWith(join(".claude-bridge", "index", "sessions.sqlite"))).toBe(
      true,
    );
  });
});

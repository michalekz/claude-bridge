import { describe, expect, it } from "vitest";
import { BASE_ALLOWLIST, HARD_STRIP_PREFIXES, sanitizeEnv } from "../src/env-whitelist.ts";

describe("env-whitelist", () => {
  it("preserves base allowlist entries", () => {
    const env = sanitizeEnv({ PATH: "/usr/bin", HOME: "/home/x", TERM: "xterm" });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/x");
    expect(env["TERM"]).toBe("xterm");
  });

  it("drops variables NOT on the allowlist", () => {
    const env = sanitizeEnv({ PATH: "/usr/bin", MY_SECRET_TOKEN: "abc" });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["MY_SECRET_TOKEN"]).toBeUndefined();
  });

  it("strips ANTHROPIC_ + CLAUDE_ prefixes even when explicitly allowed (22.7. regression)", () => {
    const env = sanitizeEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-fake",
        CLAUDE_CODE_SESSION_ID: "fake-session",
        CLAUDE_API_KEY: "fake",
        CC_INSTANCE: "1",
      },
      {
        extraAllow: [
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_SESSION_ID",
          "CLAUDE_API_KEY",
          "CC_INSTANCE",
        ],
      },
    );
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
    expect(env["CLAUDE_API_KEY"]).toBeUndefined();
    expect(env["CC_INSTANCE"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("allows CLAUDE_CONFIG_DIR override — the one Claude-namespaced var the daemon needs", () => {
    const env = sanitizeEnv(
      { PATH: "/usr/bin", ANTHROPIC_API_KEY: "leak" },
      { overrides: { CLAUDE_CONFIG_DIR: "/opt/profiles/main", CLAUDE_API_KEY: "still-blocked" } },
    );
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/opt/profiles/main");
    expect(env["CLAUDE_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("BASE_ALLOWLIST + HARD_STRIP_PREFIXES are frozen constants", () => {
    expect(Object.isFrozen(BASE_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(HARD_STRIP_PREFIXES)).toBe(true);
  });
});

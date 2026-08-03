import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TMUX = hasTmux();

describe("paneContains", () => {
  it("matches text that tmux wrapped across pane columns", async () => {
    const { paneContains } = await import("../src/hosts/tmux-driver.ts");
    const sent = "[daemon] Wake — re-onboard from your anchor and report back";
    // tmux hard-wraps, so the captured pane has newlines the sent string lacks.
    const captured =
      "some earlier output\n[daemon] Wake — re-onboard from your\nanchor and report back\n";
    expect(paneContains(captured, sent)).toBe(true);
  });

  it("is false when the text never arrived — the 2026-08-02 failure", async () => {
    const { paneContains } = await import("../src/hosts/tmux-driver.ts");
    // Exactly what was observed: the pane sat at an untouched prompt.
    expect(paneContains("$ \n", "/exit")).toBe(false);
  });

  it("tolerates an empty payload and ignores leading noise", async () => {
    const { paneContains } = await import("../src/hosts/tmux-driver.ts");
    expect(paneContains("anything", "")).toBe(true);
    expect(paneContains("noise noise /compact", "/compact")).toBe(true);
  });
});

/**
 * Live tmux acceptance for the verified send (v0.10.1).
 *
 * The bug this guards against was invisible to unit tests: on 2026-08-02 a
 * `/exit` was sent to a peer, tmux reported success, and the keystrokes never
 * arrived. Only a real pane can prove the difference between "tmux accepted
 * the command" and "the application received the text", so this suite runs
 * against an actual tmux server and skips where there is none.
 */
describe.skipIf(!TMUX)("verified send-keys against a real tmux pane", () => {
  const sessions: string[] = [];
  let tempHome: string;

  function newSessionKey(label: string): string {
    const key = `cbtest-${label}-${process.pid}-${sessions.length}`;
    sessions.push(key);
    return key;
  }

  async function spawnEchoPane(key: string) {
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const driver = new TmuxDriver({ sendVerifyDelayMs: 400 });
    // `cat` echoes typed input back into the pane, so what we send becomes
    // visible exactly the way a real CC input box would show it.
    await driver.spawn({
      sessionKey: key,
      cwd: "/tmp",
      command: "cat",
      args: [],
      env: process.env as Record<string, string>,
    });
    return driver;
  }

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-sendkeys-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const key of sessions) {
      try {
        execFileSync("tmux", ["kill-session", "-t", key], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  });

  it("delivers, confirms the text reached the pane, and logs the attempt", async () => {
    const key = newSessionKey("ok");
    const driver = await spawnEchoPane(key);

    await expect(driver.sendKeys(key, "verified-send-marker-42")).resolves.toBeUndefined();

    // Proof the text really landed, read straight from the pane.
    const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", key], { encoding: "utf-8" });
    expect(pane).toContain("verified-send-marker-42");

    // Proof the attempt is auditable — the missing half of the 2026-08-02 incident.
    const logPath = join(tempHome, ".claude-bridge", "control", "logs", `sendkeys-${key}.log`);
    const entry = JSON.parse((await readFile(logPath, "utf-8")).trim().split("\n").pop() as string);
    expect(entry.verdict).toBe("delivered");
    expect(entry.keys).toBe("verified-send-marker-42");
    expect(entry.sessionKey).toBe(key);
  });

  it("recovers a pane parked in copy-mode, which silently swallows input", async () => {
    const key = newSessionKey("copymode");
    const driver = await spawnEchoPane(key);

    // Someone scrolled back. Without the guard the keys go nowhere.
    execFileSync("tmux", ["copy-mode", "-t", key], { stdio: "ignore" });
    const inModeBefore = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", key, "#{pane_in_mode}"],
      { encoding: "utf-8" },
    ).trim();
    expect(inModeBefore).toBe("1");

    await expect(driver.sendKeys(key, "copymode-marker-7")).resolves.toBeUndefined();

    const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", key], { encoding: "utf-8" });
    expect(pane).toContain("copymode-marker-7");

    const logPath = join(tempHome, ".claude-bridge", "control", "logs", `sendkeys-${key}.log`);
    const entry = JSON.parse((await readFile(logPath, "utf-8")).trim().split("\n").pop() as string);
    expect(entry.paneInMode).toBe(true);
    expect(entry.verdict).toBe("delivered");
  });

  it("THROWS instead of reporting success when the pane is gone", async () => {
    const key = newSessionKey("dead");
    const driver = await spawnEchoPane(key);
    execFileSync("tmux", ["kill-session", "-t", key], { stdio: "ignore" });

    // The old code returned void here and the caller assumed delivery.
    await expect(driver.sendKeys(key, "into-the-void")).rejects.toThrow(/could not be verified/);

    const logPath = join(tempHome, ".claude-bridge", "control", "logs", `sendkeys-${key}.log`);
    const entry = JSON.parse((await readFile(logPath, "utf-8")).trim().split("\n").pop() as string);
    expect(entry.verdict).toBe("not-visible");
    expect(entry.attempts).toBe(2);
  });
});

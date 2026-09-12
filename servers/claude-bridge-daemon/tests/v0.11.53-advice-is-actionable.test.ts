/**
 * v0.11.53 — advice that names a door the reader cannot open.
 *
 * 2026-09-12, ai-velitel: the daemon refused a below-threshold compact and
 * advised "repeat with belowThreshold:true". His session ran bundle 0.11.37,
 * where that parameter does not exist — his own MCP layer rejected it before
 * the daemon could see it, and writing the word into `reason` did nothing
 * because prose is not parsed. The advice was not wrong; it was unexecutable
 * from where it was read, which is worse than silence — it costs a round trip
 * to discover. Same class as the external-sender footer (v0.11.49).
 *
 * The version is READ from the caller's own heartbeat, never asked for.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atLeast, parameterAdvice } from "../src/caller-version.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-callerver-"));
  homeHolder.current = home;
  vi.resetModules();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function heartbeat(sessionId: string, doc: unknown): Promise<void> {
  const dir = join(home, ".claude-bridge", "status");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${sessionId}.json`), JSON.stringify(doc));
}

describe("the caller's bundle version is read, not asked for", () => {
  it("reads it from the peer's own heartbeat", async () => {
    const { callerBundleVersion } = await import("../src/caller-version.ts");
    await heartbeat("s1", { name: "tst", version: "0.11.51", pid: 1 });
    expect(await callerBundleVersion("s1")).toBe("0.11.51");
  });

  it("absent, unreadable or fieldless → null, which means CANNOT SAY", async () => {
    const { callerBundleVersion } = await import("../src/caller-version.ts");
    expect(await callerBundleVersion("nobody")).toBeNull();
    await heartbeat("s2", { name: "tst" });
    expect(await callerBundleVersion("s2")).toBeNull();
    await mkdir(join(home, ".claude-bridge", "status"), { recursive: true });
    await writeFile(join(home, ".claude-bridge", "status", "s3.json"), "{ not json");
    expect(await callerBundleVersion("s3")).toBeNull();
  });
});

describe("atLeast compares, and admits when it cannot", () => {
  it("orders by component, not by string", () => {
    // "0.11.9" > "0.11.48" as strings; the whole point is that it is not.
    expect(atLeast("0.11.48", "0.11.48")).toBe(true);
    expect(atLeast("0.11.51", "0.11.48")).toBe(true);
    expect(atLeast("0.11.9", "0.11.48")).toBe(false);
    expect(atLeast("0.12.0", "0.11.48")).toBe(true);
    expect(atLeast("1.0.0", "0.11.48")).toBe(true);
  });

  it("null in, null out — and a version it cannot parse is also null", () => {
    expect(atLeast(null, "0.11.48")).toBeNull();
    expect(atLeast("0.11.48-rc.1", "0.11.48")).toBeNull();
    expect(atLeast("dev", "0.11.48")).toBeNull();
  });
});

describe("the advice has three shapes, and the third is the reason it exists", () => {
  it("caller can act → say it plainly", () => {
    const s = parameterAdvice("0.11.51", "0.11.48", "belowThreshold:true");
    expect(s).toBe("repeat with belowThreshold:true");
  });

  it("🔴 caller CANNOT act → say that, name the version, name the way out", () => {
    const s = parameterAdvice("0.11.37", "0.11.48", "belowThreshold:true");
    expect(s).toMatch(/0\.11\.37/);
    expect(s).toMatch(/refuse it as unknown/);
    expect(s).toMatch(/Restart this session/);
  });

  it("unknown caller → advise, and warn that the door may not be there", () => {
    const s = parameterAdvice(null, "0.11.48", "belowThreshold:true");
    expect(s).toMatch(/added in 0\.11\.48/);
    expect(s).toMatch(/older bundle/);
  });
});

describe("the ack requests state BOTH conditions after v0.11.51", () => {
  it("restart and stop say the file AND idle, not the file alone", async () => {
    const { requestRestartReady } = await import("../src/handlers/restart-protocol.ts");
    const { requestStop } = await import("../src/handlers/stop-protocol.ts");
    const id = "11111111-2222-3333-4444-555555555555";
    await requestRestartReady(id, "restart:x:1", null);
    await requestStop(id, "stop:x:1", null);
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = join(home, ".claude-bridge", "inbox", id, "pending");
    const files = await readdir(dir);
    const bodies = await Promise.all(files.map((f) => readFile(join(dir, f), "utf-8")));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatch(/goes idle/);
      expect(body).toMatch(/both, not either/);
    }
  });
});

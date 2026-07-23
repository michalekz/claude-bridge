import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

async function importState() {
  return await import("../src/state.ts");
}

describe("daemon state", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-state-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it("bootstraps empty state when file missing", async () => {
    const { loadState, STATE_VERSION } = await importState();
    const doc = await loadState("0.10.0-alpha.0");
    expect(doc.stateVersion).toBe(STATE_VERSION);
    expect(doc.daemonVersion).toBe("0.10.0-alpha.0");
    expect(doc.peers).toEqual({});
  });

  it("round-trips through save + load", async () => {
    const { loadState, saveState } = await importState();
    const doc = await loadState("0.10.0-alpha.0");
    doc.peers["peer-a"] = {
      sessionId: "peer-a",
      name: "alice",
      hostDriver: "tmux",
      tmuxTarget: "hmh:alice",
      pid: 12345,
      status: "live",
      model: "sonnet-5",
      accountProfile: null,
      startedAt: "2026-07-23T11:00:00.000Z",
      lastUpdatedAt: "2026-07-23T11:00:00.000Z",
    };
    await saveState(doc);
    const reloaded = await loadState("0.10.0-alpha.0");
    expect(reloaded.peers["peer-a"]?.name).toBe("alice");
    expect(reloaded.peers["peer-a"]?.hostDriver).toBe("tmux");
  });

  it("refuses to load newer stateVersion (no silent downgrade)", async () => {
    const { loadState, saveState, StateVersionMismatch } = await importState();
    const doc = await loadState("0.10.0-alpha.0");
    // Manually inflate stateVersion above the daemon's known ceiling.
    const inflated = { ...doc, stateVersion: doc.stateVersion + 5 };
    await saveState(inflated);
    await expect(loadState("0.10.0-alpha.0")).rejects.toBeInstanceOf(StateVersionMismatch);
  });
});

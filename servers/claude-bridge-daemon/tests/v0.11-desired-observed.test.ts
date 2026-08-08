import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.0 splits a peer record into what was INTENDED and what was MEASURED.
 *
 * The split is not cosmetic and these tests are not about shape. Every incident
 * of 2026-08-05 was one value crossing that line unnoticed: `spawnEnv` harvested
 * from a pane and replayed as a request, `homeSession` drifting at rename,
 * window names with no separate display field. The type now forces the choice;
 * these cases hold the two behaviours a type cannot express — that a migration
 * loses nothing, and that nothing gets invented on the way.
 */

const V1_PEER = {
  sessionId: "70a00bc8-e68c-4ae2-9c8a-e1a87092454d",
  name: "mic-tester",
  hostDriver: "tmux",
  tmuxTarget: "@1084",
  pid: 247195,
  status: "live",
  team: "mic",
  adopted: true,
  command: "/home/u/.nvm/versions/node/v24.14.0/bin/claude",
  spawnArgs: ["--dangerously-skip-permissions"],
  cwd: "/opt/micronic",
  homeSession: "mic",
  spawnEnv: { PATH: "/home/u/.nvm/versions/node/v24.14.0/bin:/usr/bin", HOME: "/home/u" },
  model: "claude-opus-4-7",
  accountProfile: null,
  startedAt: "2026-08-05T19:10:55.000Z",
  lastUpdatedAt: "2026-08-06T14:04:01.000Z",
};

async function writeStateDoc(doc: unknown): Promise<string> {
  const { stateFilePath } = await import("@claude-bridge/shared");
  const path = stateFilePath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(doc), "utf-8");
  return path;
}

describe("v1 records migrate into desired/observed without loss", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-v11-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("every field arrives on the side that matches how it is USED", async () => {
    await writeStateDoc({
      stateVersion: 1,
      daemonVersion: "0.10.21",
      daemonStartedAt: "2026-08-06T14:04:01.000Z",
      peers: { [V1_PEER.sessionId]: V1_PEER },
    });
    const { loadState } = await import("../src/state.ts");
    const doc = await loadState("0.11.0");
    const rec = doc.peers[V1_PEER.sessionId];
    expect(rec).toBeDefined();
    if (!rec) return;

    // Intent — what a restart replays.
    expect(rec.desired.team).toBe("mic");
    expect(rec.desired.cwd).toBe("/opt/micronic");
    expect(rec.desired.command).toContain("claude");
    expect(rec.desired.spawnArgs).toEqual(["--dangerously-skip-permissions"]);
    expect(rec.desired.homeSession).toBe("mic");
    expect(rec.desired.accountProfile).toBeNull();

    // Measurement — never replayed as intent.
    expect(rec.observed.name).toBe("mic-tester");
    expect(rec.observed.tmuxTarget).toBe("@1084");
    expect(rec.observed.pid).toBe(247195);
    expect(rec.observed.status).toBe("live");
    expect(rec.observed.adopted).toBe(true);
    expect(rec.observed.spawnEnv?.["PATH"]).toContain("/.nvm/");
    expect(rec.observed.startedAt).toBe("2026-08-05T19:10:55.000Z");

    // `model` is the one field that genuinely serves both roles, so it lands on
    // both sides rather than being assigned a winner. Picking one would have
    // silently changed restart behaviour for the whole fleet.
    expect(rec.desired.model).toBe("claude-opus-4-7");
    expect(rec.observed.model).toBe("claude-opus-4-7");
  });

  it("THE POINT: the migration does not invent a provenance it does not have", async () => {
    await writeStateDoc({
      stateVersion: 1,
      daemonVersion: "0.10.21",
      daemonStartedAt: "2026-08-06T14:04:01.000Z",
      peers: { [V1_PEER.sessionId]: V1_PEER },
    });
    const { loadState } = await import("../src/state.ts");
    const doc = await loadState("0.11.0");
    // Stamping `harvestedAt` with the migration time would date a two-day-old
    // environment to now. Unknown has to stay unknown — the whole release is
    // about not passing one kind of fact off as another.
    expect(doc.peers[V1_PEER.sessionId]?.observed.harvestedAt).toBeUndefined();
  });

  it("a version bump keeps the fleet instead of discarding it", async () => {
    // Before v0.11.0 the `onDisk < STATE_VERSION` branch returned `emptyState()`.
    // It had never fired, so the cost stayed invisible until the first real bump
    // — which would have thrown away 23 adopted peers and come up looking fine.
    const peers = Object.fromEntries(
      Array.from({ length: 23 }, (_, i) => [`id-${i}`, { ...V1_PEER, sessionId: `id-${i}` }]),
    );
    await writeStateDoc({
      stateVersion: 1,
      daemonVersion: "0.10.21",
      daemonStartedAt: "2026-08-06T14:04:01.000Z",
      peers,
    });
    const { loadState } = await import("../src/state.ts");
    const doc = await loadState("0.11.0");
    expect(Object.keys(doc.peers)).toHaveLength(23);
    expect(doc.stateVersion).toBe(3);
  });

  it("the pre-migration document is kept on disk", async () => {
    const path = await writeStateDoc({
      stateVersion: 1,
      daemonVersion: "0.10.21",
      daemonStartedAt: "2026-08-06T14:04:01.000Z",
      peers: { [V1_PEER.sessionId]: V1_PEER },
    });
    const { loadState } = await import("../src/state.ts");
    await loadState("0.11.0");
    const files = await readdir(join(path, ".."));
    const backup = files.find((f) => f.includes(".v1.") && f.endsWith(".bak"));
    expect(backup).toBeDefined();
    // The backup has to be the ORIGINAL, not a re-serialisation of the result.
    const raw = JSON.parse(await readFile(join(path, "..", backup ?? ""), "utf-8"));
    expect(raw.stateVersion).toBe(1);
    expect(raw.peers[V1_PEER.sessionId].name).toBe("mic-tester");
  });

  it("an UNRECOGNISABLE shape refuses to start rather than wiping state", async () => {
    await writeStateDoc({
      stateVersion: 0,
      daemonVersion: "ancient",
      daemonStartedAt: "2026-01-01T00:00:00.000Z",
      // Neither flat-v1 nor desired/observed — a shape this daemon has never
      // written. Nothing can be inferred from it, so nothing is attempted.
      peers: { "who-knows": { totally: "unfamiliar" } },
    });
    const { loadState } = await import("../src/state.ts");
    // Refusing is the right failure: an operator can restore a backup, but
    // cannot recover a registry that was silently emptied at boot.
    await expect(loadState("0.11.0")).rejects.toThrow(/no migration path/);
  });

  it("a RECOGNISABLE shape under a bogus stamp migrates on its content", async () => {
    // The other half of the same rule — and the half that reached the daemon.
    // Widened in R3 (v0.11.21): the content check used to run only when the
    // stamp was CURRENT, so a v1 record stamped 2 went down the v2 path and had
    // a field grafted onto a record that has no `observed` at all.
    //
    // Refusing here would be refusing to read data plainly in front of us: a
    // flat record is a v1 record whatever number sits above it.
    await writeStateDoc({
      stateVersion: 0,
      daemonVersion: "ancient",
      daemonStartedAt: "2026-01-01T00:00:00.000Z",
      peers: { [V1_PEER.sessionId]: V1_PEER },
    });
    const { loadState } = await import("../src/state.ts");
    const doc = await loadState("0.11.0");
    expect(doc.stateVersion).toBe(3);
    expect(doc.peers[V1_PEER.sessionId]?.observed.name).toBe("mic-tester");
    expect(doc.peers[V1_PEER.sessionId]?.handle).toBe(V1_PEER.sessionId);
  });

  it("a version stamp that disagrees with the content does not crash the daemon", async () => {
    // Found by a test fixture that stamped the CURRENT version onto a flat
    // record. `repairHarvestedEnv` then dereferenced `record.observed` on
    // undefined and took the daemon down at startup — for the entire fleet, at
    // the one moment nobody can intervene. A version stamp is a claim about
    // content, and it is cheap to check the content instead of trusting it.
    await writeStateDoc({
      stateVersion: 2,
      daemonVersion: "0.11.0",
      daemonStartedAt: "2026-08-06T14:04:01.000Z",
      peers: { [V1_PEER.sessionId]: V1_PEER },
    });
    const { loadState } = await import("../src/state.ts");
    const doc = await loadState("0.11.0");
    expect(doc.peers[V1_PEER.sessionId]?.observed.name).toBe("mic-tester");
    expect(doc.peers[V1_PEER.sessionId]?.desired.team).toBe("mic");
  });

  it("loading an already-migrated document changes nothing", async () => {
    // Idempotence, because `loadState` runs on every daemon start.
    await writeStateDoc({
      stateVersion: 1,
      daemonVersion: "0.10.21",
      daemonStartedAt: "2026-08-06T14:04:01.000Z",
      peers: { [V1_PEER.sessionId]: V1_PEER },
    });
    const { loadState, saveState } = await import("../src/state.ts");
    const once = await loadState("0.11.0");
    await saveState(once);
    const twice = await loadState("0.11.0");
    expect(twice.peers[V1_PEER.sessionId]).toEqual(once.peers[V1_PEER.sessionId]);
  });
});

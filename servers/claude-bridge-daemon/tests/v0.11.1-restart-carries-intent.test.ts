import { describe, expect, it, vi } from "vitest";
import { canonicalHostTarget } from "../src/hosts/driver.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * Two defects found in the v0.11.0 fleet roll, minutes after it finished.
 *
 * ① All 22 rolled tmux windows renamed themselves back to fully qualified
 *    names — `ai-kb-dev` instead of `kb-dev`. `peer_spawn` labels a window with
 *    `windowLabelFor(displayName, team)`, and `peer_restart` never passed a
 *    team, so the label fix shipped in v0.10.21 held only until the first
 *    restart. It covered `team_layout` and direct spawns and left the restart
 *    path alone, where nothing had exercised it since.
 *
 * ② Every one of those records then claimed `harvestedAt` = the restart time,
 *    for an environment sampled at adoption the day before. `peer_spawn` stamps
 *    whenever it is handed an `envBase`, and a restart hands it values copied
 *    out of the record. The release built to stop measurements masquerading as
 *    intent invented a provenance using the very field written to prevent it.
 *
 * These cases drive the REAL `peer_restart` handler and inspect what reaches
 * the driver. The first draft asserted against a helper that rebuilt the spawn
 * arguments the way the handler does — which would have passed against the
 * broken handler, because the hole was in the handler and not in the helper.
 * A test written beside the code checks what the code does; only a test written
 * where the caller stands checks what it should do.
 */

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
});

function makeRequest(args: Record<string, unknown>, id = "req-r111") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-08-06T17:30:00.000Z",
    tool: "peer_restart",
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

/** A live-looking record plus a driver that records what it was asked to spawn. */
async function fixture(over: {
  team?: string;
  label?: string;
  name: string;
  harvestedAt?: string;
  spawnEnv?: Record<string, string>;
}) {
  const { handlers, state, mock } = await importAll();
  const doc = state.emptyState("0.11.1-test");
  doc.peers["p"] = {
    handle: "p",
    desired: {
      ...(over.team !== undefined ? { team: over.team } : {}),
      ...(over.label !== undefined ? { label: over.label } : {}),
      command: "/bin/sh",
      spawnArgs: ["-c", "sleep 30"],
      cwd: "/tmp",
      accountProfile: null,
    },
    observed: {
      name: over.name,
      hostDriver: "mock",
      tmuxTarget: canonicalHostTarget("@652"),
      pid: 500,
      status: "live",
      adopted: true,
      model: null,
      ...(over.spawnEnv ? { spawnEnv: over.spawnEnv } : {}),
      ...(over.harvestedAt !== undefined ? { harvestedAt: over.harvestedAt } : {}),
      startedAt: "2026-08-05T10:00:00.000Z",
      lastUpdatedAt: "2026-08-05T10:00:00.000Z",
    },
  };

  const driver = new mock.MockDriver();
  let windowGone = false;
  // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the optional method
  (driver as any).listWindows = async () =>
    windowGone
      ? []
      : [
          {
            target: "@652",
            label: "t:1",
            session: over.team ?? "t",
            window: 1,
            windowName: over.name,
            pid: 500,
          },
        ];
  const originalKill = driver.kill.bind(driver);
  driver.kill = async (k: string) => {
    windowGone = true;
    return originalKill(k);
  };
  const spawned: Array<{ windowName?: string }> = [];
  const originalSpawn = driver.spawn.bind(driver);
  driver.spawn = async (opts) => {
    spawned.push({ windowName: opts.windowName });
    return originalSpawn(opts);
  };

  return {
    run: () =>
      handlers.dispatch(makeRequest({ peer: "p" }), {
        state: doc,
        hostDriver: driver,
        daemonVersion: "0.11.1-test",
        restartSettleMs: 0,
      }),
    doc,
    driver,
    spawned,
  };
}

describe("a restart keeps the window label the convention gave it", () => {
  it("THE REGRESSION: the relaunched window carries the SHORT name", async () => {
    homeHolder.current = `/tmp/cbd-lbl-${process.hrtime.bigint()}`;
    vi.resetModules();
    const f = await fixture({ team: "ai", name: "ai-kb-dev" });
    await f.run();
    // Before the fix this was `ai-kb-dev`, and one roll renamed 22 windows.
    expect(f.spawned[0]?.windowName).toBe("kb-dev");
    f.driver.reset();
  });

  it("an operator's declared label beats the derived one", async () => {
    // Otherwise `control_config set label=…` sits in the record forever and
    // never reaches the window it names, which makes the field decorative.
    homeHolder.current = `/tmp/cbd-lbl2-${process.hrtime.bigint()}`;
    vi.resetModules();
    const f = await fixture({ team: "mic", label: "QA", name: "mic-tester" });
    await f.run();
    expect(f.spawned[0]?.windowName).toBe("QA");
    f.driver.reset();
  });

  it("a peer outside the convention keeps its whole name", async () => {
    homeHolder.current = `/tmp/cbd-lbl3-${process.hrtime.bigint()}`;
    vi.resetModules();
    const f = await fixture({ team: "ai", name: "legacy-box" });
    await f.run();
    expect(f.spawned[0]?.windowName).toBe("legacy-box");
    f.driver.reset();
  });
});

describe("a restart copies an environment, it never claims to have sampled one", () => {
  it("THE REGRESSION: an unknown sampling time stays unknown across a restart", async () => {
    homeHolder.current = `/tmp/cbd-hv-${process.hrtime.bigint()}`;
    vi.resetModules();
    const f = await fixture({
      team: "mic",
      name: "mic-tester",
      spawnEnv: { PATH: "/nvm/bin", HOME: "/home/u" },
      // No harvestedAt: exactly a record migrated out of v1, where we genuinely
      // do not know when those values were read.
    });
    await f.run();
    // v0.11.0 stamped `now` here, for 22 peers at once.
    expect(f.doc.peers["p"]?.observed.harvestedAt).toBeUndefined();
    // The values themselves must still survive — the fix is about the claim,
    // not about dropping the environment.
    expect(f.doc.peers["p"]?.observed.spawnEnv?.["PATH"]).toBe("/nvm/bin");
    f.driver.reset();
  });

  it("a known sampling time survives a restart unchanged", async () => {
    homeHolder.current = `/tmp/cbd-hv2-${process.hrtime.bigint()}`;
    vi.resetModules();
    const sampled = "2026-08-05T19:10:55.000Z";
    const f = await fixture({
      team: "mic",
      name: "mic-tester",
      spawnEnv: { PATH: "/nvm/bin" },
      harvestedAt: sampled,
    });
    await f.run();
    expect(f.doc.peers["p"]?.observed.harvestedAt).toBe(sampled);
    f.driver.reset();
  });

  it("REVOCATION: stamps written by a daemon that could not tell a copy apart are cleared", async () => {
    homeHolder.current = `/tmp/cbd-rev-${process.hrtime.bigint()}`;
    vi.resetModules();
    const { state } = await importAll();
    const doc = state.emptyState("0.11.1-test");
    doc.peers["a"] = {
      handle: "a",
      desired: { team: "mic" },
      observed: {
        name: "mic-tester",
        hostDriver: "tmux",
        tmuxTarget: canonicalHostTarget("@1"),
        pid: 1,
        status: "live",
        model: null,
        spawnEnv: { PATH: "/nvm/bin" },
        // What the v0.11.0 roll wrote: the restart's own clock, over values
        // sampled at adoption the day before.
        harvestedAt: "2026-08-06T17:06:53.967Z",
        startedAt: "2026-08-06T17:06:53.967Z",
        lastUpdatedAt: "2026-08-06T17:06:53.967Z",
      },
    };
    const cleared = state.revokeUntrustedHarvestStamps(doc);
    expect(cleared).toBe(1);
    expect(doc.peers["a"]?.observed.harvestedAt).toBeUndefined();
    // The environment survives — only the false claim about it goes.
    expect(doc.peers["a"]?.observed.spawnEnv?.["PATH"]).toBe("/nvm/bin");
    expect(doc.harvestProvenanceRevokedAt).toBeDefined();
  });

  it("REVOCATION runs once, so honest stamps written afterwards survive", async () => {
    // Without the marker this would run on every boot and erase provenance a
    // v0.11.1 daemon had legitimately recorded — turning a one-time correction
    // into a permanent inability to know anything.
    homeHolder.current = `/tmp/cbd-rev2-${process.hrtime.bigint()}`;
    vi.resetModules();
    const { state } = await importAll();
    const doc = state.emptyState("0.11.1-test");
    doc.harvestProvenanceRevokedAt = "2026-08-06T18:00:00.000Z";
    doc.peers["a"] = {
      handle: "a",
      desired: {},
      observed: {
        name: "fresh",
        hostDriver: "tmux",
        tmuxTarget: canonicalHostTarget("@1"),
        pid: 1,
        status: "live",
        model: null,
        spawnEnv: { PATH: "/nvm/bin" },
        harvestedAt: "2026-08-06T18:30:00.000Z",
        startedAt: "2026-08-06T18:30:00.000Z",
        lastUpdatedAt: "2026-08-06T18:30:00.000Z",
      },
    };
    expect(state.revokeUntrustedHarvestStamps(doc)).toBe(0);
    expect(doc.peers["a"]?.observed.harvestedAt).toBe("2026-08-06T18:30:00.000Z");
  });

  it("REVOCATION: a label no operator chose is cleared so derivation can work", async () => {
    // Fixing the computation did NOT fix the fleet. v0.11.0 had already stored
    // the fully qualified name as the label, and v0.11.1 made an explicit label
    // outrank the derived one — correct in general, and it meant the stored
    // garbage kept winning. Measured on the etl canary at 17:24: windows still
    // `etl-dev`. Correcting the writer does nothing about what was written.
    homeHolder.current = `/tmp/cbd-lblrev-${process.hrtime.bigint()}`;
    vi.resetModules();
    const { state } = await importAll();
    const doc = state.emptyState("0.11.2-test");
    const obs = (name: string) => ({
      name,
      hostDriver: "tmux" as const,
      tmuxTarget: canonicalHostTarget("@1"),
      pid: 1,
      status: "live" as const,
      model: null,
      startedAt: "2026-08-06T17:00:00.000Z",
      lastUpdatedAt: "2026-08-06T17:00:00.000Z",
    });
    // The artifact: label === FQN on a peer that has a team prefix.
    doc.peers["a"] = {
      handle: "a",
      desired: { team: "etl", label: "etl-dev" },
      observed: obs("etl-dev"),
    };
    // A real choice — must survive.
    doc.peers["b"] = {
      handle: "b",
      desired: { team: "mic", label: "QA" },
      observed: obs("mic-tester"),
    };
    // No team: the short form does not exist, so the label is not an artifact.
    doc.peers["c"] = {
      handle: "c",
      desired: { label: "legacy-box" },
      observed: obs("legacy-box"),
    };

    expect(state.revokeDerivedLabels(doc)).toBe(1);
    expect(doc.peers["a"]?.desired.label).toBeUndefined();
    expect(doc.peers["b"]?.desired.label).toBe("QA");
    expect(doc.peers["c"]?.desired.label).toBe("legacy-box");
    // Second pass is a no-op — otherwise a later deliberate `label = FQN` would
    // be erased on the next boot.
    expect(state.revokeDerivedLabels(doc)).toBe(0);
  });

  it("it stays unknown across SEVERAL restarts, not just the first", async () => {
    // The failure mode is a stamp appearing later, so once is not enough.
    homeHolder.current = `/tmp/cbd-hv3-${process.hrtime.bigint()}`;
    vi.resetModules();
    const f = await fixture({
      team: "etl",
      name: "etl-dev",
      spawnEnv: { PATH: "/nvm/bin" },
    });
    await f.run();
    await f.run();
    await f.run();
    expect(f.doc.peers["p"]?.observed.harvestedAt).toBeUndefined();
    f.driver.reset();
  });
});

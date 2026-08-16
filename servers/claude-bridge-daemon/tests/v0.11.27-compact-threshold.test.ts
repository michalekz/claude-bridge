/**
 * A compact below the threshold is refused — by the side that can refuse.
 *
 * THE 2026-08-11 FINDING (plt-velitel). The fleet's PreCompact hook printed
 * "🛑 COMPACT ZABLOKOVÁN — kontext je na 63 %, práh je 85 %" and the compaction
 * ran regardless: `{"continue": false}` from a PreCompact hook has no effect.
 * The peer read the message, believed it, and told its velitel no compact had
 * happened. Its transcript said 634 166 → 10 840 tokens.
 *
 * A guard that announces an intervention it did not make is worse than no guard,
 * because everyone downstream reasons from the announcement. So the threshold
 * moved here, where `peer_compact` can actually decline — and the refusal is
 * measured from the peer's own statusline capture, the same source the answer
 * quotes back.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

async function importAll() {
  return {
    compact: await import("../src/handlers/peer-compact.ts"),
    verify: await import("../src/compact-verify.ts"),
    state: await import("../src/state.ts"),
    mock: await import("../src/hosts/mock-driver.ts"),
    shared: await import("@claude-bridge/shared"),
  };
}

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** The statusline capture the daemon reads — a real file, not a stubbed reader. */
async function writeContext(root: string, percent: number): Promise<void> {
  const dir = join(root, "live", "statusline");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${SESSION}.json`),
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      payload: {
        transcript_path: `/tmp/${SESSION}.jsonl`,
        context_window: { used_percentage: percent },
      },
    }),
  );
}

async function fixture() {
  const { compact, state, mock } = await importAll();
  const doc = state.emptyState("0.11.27");
  doc.peers[SESSION] = {
    handle: SESSION,
    desired: {
      team: "plt",
      label: "integration-dev",
      cwd: "/opt/hmh",
      command: "/bin/sleep",
      spawnArgs: [],
      homeSession: "plt",
      model: null,
      accountProfile: null,
    },
    observed: {
      name: "integration-dev",
      hostDriver: "tmux",
      tmuxTarget: "@1",
      pid: 4242,
      status: "live",
      spawnEnv: {},
      model: null,
      restartRequest: null,
      startedAt: "2026-08-11T18:00:00.000Z",
      lastUpdatedAt: "2026-08-11T18:00:00.000Z",
      sessionId: SESSION,
      identity: "measured",
      identityAt: "2026-08-11T18:00:00.000Z",
      adopted: true,
    },
  } as never;
  const sent: string[] = [];
  const driver = new mock.MockDriver();
  (driver as unknown as { sendKeys: (k: string, keys: string) => Promise<void> }).sendKeys = async (
    _k,
    keys,
  ) => {
    sent.push(keys);
  };
  return { compact, doc, driver, sent };
}

function compactRequest(args: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    id: "req-compact",
    ts: "2026-08-11T20:01:25.000Z",
    tool: "peer_compact",
    args,
    requestedBy: { sessionId: "d90a787e", name: "plt-velitel" },
  };
}

describe("compact below the threshold is declined, not announced", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-compact-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("refuses at the measured percentage and injects nothing", async () => {
    const { compact, doc, driver, sent } = await fixture();
    const { shared } = await importAll();
    await writeContext(shared.bridgeRoot(), 63); // int-dev's real number

    const res = await compact.handlePeerCompact(compactRequest({ peer: SESSION }), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.27",
    } as never);

    const data = res.data as Record<string, unknown>;
    expect(data["outcome"]).toBe("skipped_below_threshold");
    expect(data["contextPercentBefore"]).toBe(63);
    // Nothing was injected AND the peer was never asked for an anchor: the
    // check runs before the request, so a declined compact costs the peer no
    // turn at all.
    expect(sent).toEqual([]);
  });

  it("the override compacts anyway — early compaction has real uses", async () => {
    // Handing a role over, or bracing for a large input. The flag is the
    // difference between meaning it and drifting into it.
    const { compact, doc, driver } = await fixture();
    const { shared } = await importAll();
    await writeContext(shared.bridgeRoot(), 63);

    const res = await compact.handlePeerCompact(
      compactRequest({ peer: SESSION, belowThreshold: true, anchorTimeoutMs: 50, ackPollMs: 10 }),
      { state: doc, hostDriver: driver, daemonVersion: "0.11.27" } as never,
    );

    // It proceeds past the threshold and fails later, on the anchor it never
    // gets — which is the correct next obstacle, not this one.
    expect((res.data as Record<string, unknown> | undefined)?.["outcome"]).not.toBe(
      "skipped_below_threshold",
    );
  });

  it("above the threshold it proceeds without a flag", async () => {
    const { compact, doc, driver } = await fixture();
    const { shared } = await importAll();
    await writeContext(shared.bridgeRoot(), 91);

    const res = await compact.handlePeerCompact(
      compactRequest({ peer: SESSION, anchorTimeoutMs: 50, ackPollMs: 10 }),
      { state: doc, hostDriver: driver, daemonVersion: "0.11.27" } as never,
    );

    expect((res.data as Record<string, unknown> | undefined)?.["outcome"]).not.toBe(
      "skipped_below_threshold",
    );
  });

  it("an unmeasurable context does NOT count as below the threshold", async () => {
    // No capture, no claim. The same disposition as the busy probe and the
    // liveness guard in this release: only a positive reading decides. A gate
    // that fires on ignorance fires always, and then gets switched off.
    const { compact, doc, driver } = await fixture();

    const res = await compact.handlePeerCompact(
      compactRequest({ peer: SESSION, anchorTimeoutMs: 50, ackPollMs: 10 }),
      { state: doc, hostDriver: driver, daemonVersion: "0.11.27" } as never,
    );

    expect((res.data as Record<string, unknown> | undefined)?.["outcome"]).not.toBe(
      "skipped_below_threshold",
    );
  });

  it("the threshold is the one the fleet already agreed on", async () => {
    const { verify } = await importAll();
    expect(verify.COMPACT_MIN_PERCENT).toBe(85);
    expect(verify.COMPACT_MIN_PERCENT).toBe(verify.COMPACT_RACE_PERCENT);
  });
});

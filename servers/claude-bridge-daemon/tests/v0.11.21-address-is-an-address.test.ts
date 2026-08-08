import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalHostTarget,
  sanitizeSessionKey,
  trustCanonicalTarget,
} from "../src/hosts/driver.ts";
import { makePeer } from "./peer-fixture.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * R3 (v0.11.21) — an address is an address.
 *
 * The plan called for "canonicalisation everywhere an address is an address"
 * and measured 2 of 13 handler sites using it. That measurement was of the
 * wrong side of the boundary: the driver has canonicalised at every one of its
 * public entry points since v0.11.6, and a handler PASSES an address rather
 * than receiving one.
 *
 * The class that was genuinely unprotected is COMPARISON — six places matching
 * a stored `tmuxTarget` against host output as strings, with no driver in
 * between. Nothing on the fleet showed it (measured 2026-08-08: 0 of 26 records
 * hold a non-canonical target), so these are regression tests for a trap, not
 * for an outage. That is the point of writing them now: the trap needs an
 * unlucky NAME, and names are chosen by people.
 */

describe("two ways to get an address, and they are not interchangeable", () => {
  it("DERIVING sanitises: a chosen name becomes a legal target", () => {
    // Zdeněk's edge-case rule — `:` and `.` are tmux target syntax, and a
    // session created under `rc-test:alice` answered to `rc-test_alice` while
    // the daemon kept addressing the original (T1, v0.10.0-rc.2).
    expect(canonicalHostTarget("rc-test:alice")).toBe("rc-test_alice");
    expect(canonicalHostTarget("ai-bob.dev")).toBe("ai-bob_dev");
    expect(canonicalHostTarget("ai bob")).toBe("ai_bob");
  });

  it("a window id is already canonical and must survive untouched", () => {
    // `@` is in UNSAFE_TARGET_CHARS, so the bare sanitizer turns `@1011` into
    // `_1011` and tmux answers "can't find pane _1011" — which is how
    // `peer_compact` became unable to reach any of the twenty-three adopted
    // peers (plt-designer, 2026-08-05).
    expect(canonicalHostTarget("@1011")).toBe("@1011");
    expect(sanitizeSessionKey("@1011")).toBe("_1011");
  });

  it("THE CORRECTION: sanitising an address the HOST reported RENAMES it", () => {
    // This is what turned my own first version of the R3 migration around.
    // tmux rewrites `:` and `.` itself at creation, so those never come back
    // out of it — a SPACE does not. `tmux new-session -s "my session"` yields a
    // session that answers to `my session` and to nothing else.
    const fromHost = "my session";
    expect(trustCanonicalTarget(fromHost)).toBe("my session");
    expect(canonicalHostTarget(fromHost)).toBe("my_session");
    // Two different addresses. Running the sanitizer over host output does not
    // normalise it, it points it somewhere else — and every adopted peer's
    // address arrives exactly this way.
    expect(canonicalHostTarget(fromHost)).not.toBe(trustCanonicalTarget(fromHost));
  });
});

describe("peer_spawn writes a canonical address from the FIRST write", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-addr-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE LATENT TRAP: the record never holds the raw display name, not even mid-spawn", async () => {
    const { dispatch } = await import("../src/handlers/index.ts");
    const { emptyState } = await import("../src/state.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");

    const doc = emptyState("0.11.21-test");
    const driver = new MockDriver({});

    // The record used to be created with the raw name and corrected to the
    // driver's canonical form only AFTER the spawn returned. Read the registry
    // at the moment the driver is called and the old code shows the raw name;
    // a spawn that failed inside that window left it there for good.
    let targetDuringSpawn: string | null | undefined;
    const realSpawn = driver.spawn.bind(driver);
    driver.spawn = async (opts) => {
      targetDuringSpawn = doc.peers["ai:bob.1"]?.observed.tmuxTarget;
      return realSpawn(opts);
    };

    const res = await dispatch(
      {
        schemaVersion: 1 as const,
        id: "req-addr",
        ts: "2026-08-08T18:00:00.000Z",
        tool: "peer_spawn",
        args: {
          handle: "ai:bob.1",
          displayName: "ai:bob.1",
          cwd: "/tmp",
          command: "/bin/sh",
          args: ["-c", "sleep 5"],
          resume: false,
        },
        requestedBy: { sessionId: "operator", name: "operator" },
      },
      { state: doc, hostDriver: driver, daemonVersion: "0.11.21-test" },
    );

    expect(res.outcome).toBe("ok");
    // Canonical while the spawn was still in flight — the assertion the old
    // code fails. `ai:bob.1` is a name tmux cannot address at all.
    expect(targetDuringSpawn).toBe("ai_bob_1");
    expect(targetDuringSpawn).not.toBe("ai:bob.1");
    // And still canonical after, which was already true before R3.
    expect(doc.peers["ai:bob.1"]?.observed.tmuxTarget).toBe("ai_bob_1");
    // The HANDLE keeps the name it was given. Only the address is normalised —
    // they are different things and R3 is the release that stops mixing them.
    expect(Object.keys(doc.peers)).toContain("ai:bob.1");

    await driver.kill(canonicalHostTarget("ai:bob.1"));
  });
});

describe("team_reconcile compares addresses, and must not invent a mismatch", () => {
  let procRoot: string;

  beforeEach(async () => {
    homeHolder.current = `/tmp/cbd-addr-rec-${process.hrtime.bigint()}`;
    procRoot = await mkdtemp(join(tmpdir(), "cb-proc-addr-"));
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(procRoot, { recursive: true, force: true });
  });

  it("a peer addressed by a host session name with a space is NOT reported missing", async () => {
    const { dispatch } = await import("../src/handlers/index.ts");
    const { emptyState } = await import("../src/state.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");

    await mkdir(join(procRoot, "4242"), { recursive: true });

    const doc = emptyState("0.11.21-test");
    // An adopted peer: the address came out of tmux, spaces and all.
    doc.peers["adopted-1"] = makePeer(
      "adopted-1",
      { team: "hmh" },
      {
        name: "hmh-adopted",
        tmuxTarget: trustCanonicalTarget("my session"),
        pid: 4242,
        adopted: true,
        startedAt: "2026-08-08T10:00:00.000Z",
        lastUpdatedAt: "2026-08-08T10:00:00.000Z",
      },
    );

    const driver = new MockDriver();
    driver.listSessions = async () => [
      { sessionKey: trustCanonicalTarget("my session"), alive: true, pid: 4242 },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the optional driver method
    (driver as any).listWindows = async () => [];

    const res = await dispatch(
      {
        schemaVersion: 1 as const,
        id: "req-rec-addr",
        ts: "2026-08-08T18:00:00.000Z",
        tool: "team_reconcile",
        args: {},
        requestedBy: { sessionId: "operator", name: "operator" },
      },
      {
        state: doc,
        hostDriver: driver,
        daemonVersion: "0.11.21-test",
        processInspector: {
          listClaudePeers: async () => [] as never[],
          ancestorsOf: async () => [],
        },
        procRoot,
      },
    );

    expect(res.outcome).toBe("ok");
    const drift = (res.data as { drift: Array<{ kind: string; sessionId: string | null }> }).drift;
    // Sanitising the stored address would look it up as `my_session`, find
    // nothing, and accuse a running peer of having lost its pane — a drift
    // report that sends an operator to restart something that is fine.
    expect(drift.filter((d) => d.kind === "host_missing")).toHaveLength(0);
  });
});

/**
 * The rename found two live defects, and neither was on the plan.
 *
 * `sessionId` meant both "the record's key" and "the peer's identity", so code
 * that used the wrong one READ AS CORRECT under either meaning. Giving the two
 * things two words is what made them visible — the fix for N4 (v0.11.16) had
 * changed the behaviour and left the word, and this is the half that was left.
 */
describe("the bridge address, in the two places v0.11.18 did not reach", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-bridge-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  const HANDLE = "tst-r3";
  const IDENTITY = "e8197b26-f873-40fb-afec-4e370b5c0997";

  async function fleetWithHandleKeyedPeer() {
    const { emptyState } = await import("../src/state.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");
    const doc = emptyState("0.11.21-test");
    doc.peers[HANDLE] = makePeer(
      HANDLE,
      { team: "tst", cwd: "/tmp", command: "/bin/sh" },
      {
        name: HANDLE,
        tmuxTarget: canonicalHostTarget("tst-r3"),
        pid: 4242,
        status: "live",
        // The peer booted and told us who it is — so its inbox and its acks
        // live under THIS, not under the name we filed it by.
        sessionId: IDENTITY,
        identity: "measured",
        startedAt: "2026-08-08T10:00:00.000Z",
        lastUpdatedAt: "2026-08-08T10:00:00.000Z",
      },
    );
    const driver = new MockDriver();
    return { doc, driver };
  }

  it("🔴 peer_compact polls the ack where the PEER was told to write it", async () => {
    // v0.11.18's acceptance named compact as affected and fixed only stop and
    // restart. The anchor request tells the peer to write
    // `compact-ack/<its own session id>.json`; the daemon polled
    // `compact-ack/<handle>.json`. Both sides told the truth and never met, so
    // a handle-keyed peer could only ever end in `anchor_timeout` — and
    // `team_layout` is the tool that makes handle-keyed peers.
    const { dispatch } = await import("../src/handlers/index.ts");
    const shared = await import("@claude-bridge/shared");
    const { doc, driver } = await fleetWithHandleKeyedPeer();
    (driver as unknown as { sendKeys: (k: string, s: string) => Promise<void> }).sendKeys =
      async () => undefined;

    const ackDir = join(shared.controlDir(), "compact-ack");
    await mkdir(ackDir, { recursive: true });
    // Written under the IDENTITY, which is the only name the peer knows.
    await writeFile(join(ackDir, `${IDENTITY}.json`), JSON.stringify({ ready: true }));

    const res = await dispatch(
      {
        schemaVersion: 1 as const,
        id: "req-compact-r3",
        ts: "2026-08-08T18:00:00.000Z",
        tool: "peer_compact",
        args: {
          peer: HANDLE,
          anchorTimeoutMs: 2_000,
          ackPollMs: 50,
          skipAnchorRequest: true,
          reason: "r3-regression",
        },
        requestedBy: { sessionId: "operator", name: "operator" },
      },
      { state: doc, hostDriver: driver, daemonVersion: "0.11.21-test" },
    );

    expect(res.outcome).toBe("ok");
    // And the result still names the peer by its HANDLE — that is how a caller
    // addresses it. Only the ack moved.
    expect((res.data as { handle: string }).handle).toBe(HANDLE);
  });

  it("🔴 a wake goes to the inbox the peer actually drains", async () => {
    // Step g) of the restart protocol — the step that TELLS the peer what
    // happened, including that its anchor may be half-written after a forced
    // restart. It took the registry key, so for a handle-keyed peer the message
    // landed in `inbox/<handle>/pending/`, which nobody reads. No error, no
    // retry, no warning: the peer came back and was never told why.
    const { wakePeer } = await import("../src/handlers/wake.ts");
    const { bridgeIdOf } = await import("../src/handlers/peer-identity.ts");
    const shared = await import("@claude-bridge/shared");
    const { doc } = await fleetWithHandleKeyedPeer();
    const record = doc.peers[HANDLE];
    if (!record) throw new Error("fixture");

    await wakePeer(
      {
        schemaVersion: 1 as const,
        id: "req-wake-r3",
        ts: "2026-08-08T18:00:00.000Z",
        tool: "peer_restart",
        args: {},
        requestedBy: { sessionId: "operator", name: "operator" },
      },
      {
        state: doc,
        daemonVersion: "0.11.21-test",
        hostDriver: { name: "mock", sendKeys: async () => undefined },
        // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal context
      } as any,
      {
        bridgeId: bridgeIdOf(record),
        sessionKey: "tst-r3",
        reason: "r3-regression",
        stoppedCleanly: false,
        wakeDelayMs: 0,
      },
    );

    const inIdentity = await readdir(join(shared.bridgeRoot(), "inbox", IDENTITY, "pending")).catch(
      () => [] as string[],
    );
    const inHandle = await readdir(join(shared.bridgeRoot(), "inbox", HANDLE, "pending")).catch(
      () => [] as string[],
    );

    expect(inIdentity).toHaveLength(1);
    // The old address must be EMPTY, not merely also-written: a message in a
    // directory nobody drains is indistinguishable from one never sent.
    expect(inHandle).toHaveLength(0);
  });
});

/**
 * v0.11.33 — the busy gate asked once, and once was always too early.
 *
 * Writing the anchor ack IS a turn. v0.11.26 moved the probe to AFTER the ack
 * for exactly that reason, then asked a single time, 0.4 s later, while the
 * tail of that turn was still running. Measured 2026-08-26, three consecutive
 * attempts by one operator, all three `skipped_busy`:
 *
 *     22:13:38.9  peer writes the ack
 *     22:13:39.3  daemon probes → busy
 *     22:13:45    the acking turn ends
 *
 * The gate was not catching a busy peer. It was catching the peer obeying.
 *
 * These tests drive the WHOLE handler and let it run a real `claude agents
 * --json` — a script standing in for the client, which answers `busy` a chosen
 * number of times and then `idle`. Nothing about the probe is mocked, so what
 * they measure is the handler's behaviour, not a stub's.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHostTarget } from "../src/hosts/driver.ts";
import { makePeer } from "./peer-fixture.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

const HANDLE = "tst-idle";
const IDENTITY = "11111111-2222-3333-4444-555555555555";

let home = "";
let binDir = "";

/**
 * A stand-in for the client, driven by a counter on disk.
 *
 * `busyCalls` answers come first, then `idle` for ever. The counter is a file
 * because each probe is a fresh process — the state has to outlive it.
 */
async function fakeClaude(busyCalls: number): Promise<string> {
  const counter = join(binDir, "calls");
  await writeFile(counter, "0");
  const path = join(binDir, `claude-${busyCalls}`);
  await writeFile(
    path,
    [
      "#!/bin/sh",
      `n=$(cat "${counter}")`,
      `echo $((n + 1)) > "${counter}"`,
      `if [ "$n" -lt ${busyCalls} ]; then st=busy; else st=idle; fi`,
      `printf '[{"pid":1,"kind":"interactive","sessionId":"${IDENTITY}","name":"${HANDLE}","status":"%s"}]' "$st"`,
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

async function probeCount(): Promise<number> {
  return Number.parseInt(await readFile(join(binDir, "calls"), "utf-8"), 10);
}

async function fleet(command: string) {
  const { emptyState } = await import("../src/state.ts");
  const { MockDriver } = await import("../src/hosts/mock-driver.ts");
  const doc = emptyState("0.11.33-test");
  doc.peers[HANDLE] = makePeer(
    HANDLE,
    { team: "tst", cwd: "/tmp", command },
    {
      name: HANDLE,
      tmuxTarget: canonicalHostTarget(HANDLE),
      pid: 4242,
      status: "live",
      sessionId: IDENTITY,
      identity: "measured",
    },
  );
  const driver = new MockDriver();
  (driver as unknown as { sendKeys: (k: string, s: string) => Promise<void> }).sendKeys =
    async () => undefined;
  return { doc, driver };
}

/** An ack is already on disk — this suite is about what happens AFTER it. */
async function placeAck(): Promise<void> {
  const shared = await import("@claude-bridge/shared");
  const dir = join(shared.controlDir(), "compact-ack");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${IDENTITY}.json`), JSON.stringify({ ready: true }));
}

async function compact(command: string, extra: Record<string, unknown>) {
  const { dispatch } = await import("../src/handlers/index.ts");
  const { doc, driver } = await fleet(command);
  await placeAck();
  return dispatch(
    {
      schemaVersion: 1 as const,
      id: "req-idle",
      ts: "2026-08-27T09:00:00.000Z",
      tool: "peer_compact",
      args: {
        peer: HANDLE,
        anchorTimeoutMs: 2_000,
        ackPollMs: 50,
        skipAnchorRequest: true,
        reason: "v0.11.33",
        ...extra,
      },
      requestedBy: { sessionId: "operator", name: "operator" },
    },
    { state: doc, hostDriver: driver, daemonVersion: "0.11.33-test" },
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-idle-"));
  homeHolder.current = home;
  binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("the gate waits the acking turn out instead of refusing it", () => {
  it("🔴 THE REGRESSION: busy on the first probe is no longer a refusal", async () => {
    // Two busy answers — the tail of the turn that wrote the ack — then idle.
    // Before v0.11.33 the first answer ended the call with `skipped_busy` and
    // an operator typed `/compact` by hand into a peer that had been ready for
    // minutes.
    const bin = await fakeClaude(2);
    const res = await compact(bin, { idlePollMs: 50 });

    expect(res.outcome).toBe("ok");
    const data = res.data as { outcome: string; idleWaitedMs: number };
    expect(data.outcome).not.toBe("skipped_busy");
    // It asked more than once. That single fact is the whole fix.
    expect(await probeCount()).toBeGreaterThan(1);
    expect(data.idleWaitedMs).toBeGreaterThan(0);
  });

  it("a peer busy past the budget is still refused — and says how long it waited", async () => {
    // The gate did not go away. What changed is that a refusal now means "busy
    // for a minute and a half", not "busy 0.4 s after being asked".
    const bin = await fakeClaude(10_000);
    const res = await compact(bin, { idleTimeoutMs: 400, idlePollMs: 50 });

    const data = res.data as {
      outcome: string;
      agentBusy: string;
      idleWaitedMs: number;
      idleTimeoutMs: number;
      note: string;
    };
    expect(data.outcome).toBe("skipped_busy");
    expect(data.agentBusy).toBe("busy");
    // MEASURED, not the budget — `poll.ts`'s one invariant, asserted rather
    // than trusted. Three sites in this campaign reported a decision as an
    // observation.
    expect(data.idleWaitedMs).toBeGreaterThanOrEqual(300);
    expect(data.idleTimeoutMs).toBe(400);
    expect(data.note).toContain("still reported busy after");
  });

  it("`idleTimeoutMs: 0` restores the one-shot check, for a caller who wants it", async () => {
    const bin = await fakeClaude(10_000);
    const res = await compact(bin, { idleTimeoutMs: 0 });

    const data = res.data as { outcome: string; idleWaitedMs: number };
    expect(data.outcome).toBe("skipped_busy");
    // One probe, and the wait is the cost of that probe alone.
    expect(await probeCount()).toBe(1);
    expect(data.idleWaitedMs).toBeLessThan(1_000);
  });

  it("a probe that CANNOT run gets a few retries, not the full idle budget", async () => {
    // `busy` is a fact about the peer and waiting is right. `probe-failed` is a
    // fact about US, and waiting only hopes our own tooling starts working —
    // the 2026-08-10 P0 was `spawn claude ENOENT` on every call for a whole
    // deploy. Under the idle budget that would be 90 failed probes per compact.
    const started = Date.now();
    const res = await compact(join(binDir, "does-not-exist"), {
      idleTimeoutMs: 30_000,
      idlePollMs: 50,
    });
    const elapsed = Date.now() - started;

    const data = res.data as { outcome: string; agentBusy: string; probeFailures: number };
    expect(data.outcome).toBe("skipped_busy");
    expect(data.agentBusy).toBe("probe-failed");
    expect(data.probeFailures).toBe(3);
    // Nowhere near the 30 s budget it was given.
    expect(elapsed).toBeLessThan(10_000);
  });
});

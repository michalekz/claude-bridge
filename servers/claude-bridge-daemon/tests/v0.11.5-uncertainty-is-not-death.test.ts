import { describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * `peer_spawn` destroyed a session on the strength of an answer that could not
 * tell four different things apart.
 *
 * `readSessionPid` was `catch { return null }`. Absent target, five-second
 * timeout, tmux failing to run, unparseable output — all `null`, and `null`
 * meant "the command exited immediately". The handler responded by deleting the
 * record and killing the session.
 *
 * So a transient hiccup killed a peer that may have been running perfectly, and
 * took the pane with it. The pane is where the explanation lives: that is why
 * the failure reported at 2026-08-07 07:05:59 could not be reproduced by anyone
 * afterwards — seven attempts, seven successes. The tool tidies away exactly
 * what an investigator needs.
 *
 * The rule, and it is the same one the drift report already follows for
 * `windowIndex`: WHEN YOU ARE NOT SURE, MARK IT AND HAND IT TO THE LAYER THAT
 * CAN LOOK AGAIN. Uncertainty is not grounds for a destructive act.
 */

const importAll = async () => ({
  handlers: await import("../src/handlers/index.ts"),
  state: await import("../src/state.ts"),
  mock: await import("../src/hosts/mock-driver.ts"),
});

function spawnRequest(handle: string) {
  return {
    schemaVersion: 1 as const,
    id: `req-${handle}`,
    ts: "2026-08-07T07:30:00.000Z",
    tool: "peer_spawn",
    args: {
      handle,
      displayName: handle,
      cwd: "/tmp",
      command: "/bin/sh",
      args: ["-c", "sleep 5"],
    },
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

/** A driver whose spawn reports whatever probe the case is about. */
async function fixtureWithProbe(probe: unknown) {
  const { handlers, state, mock } = await importAll();
  const doc = state.emptyState("0.11.5-test");
  const driver = new mock.MockDriver();
  const killed: string[] = [];
  const originalSpawn = driver.spawn.bind(driver);
  driver.spawn = async (opts) => {
    const rec = await originalSpawn(opts);
    return {
      ...rec,
      alive: (probe as { kind: string }).kind === "pid",
      pid: (probe as { kind: string; pid?: number }).pid ?? null,
      probe,
      // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the probe field
    } as any;
  };
  driver.kill = async (k: string) => {
    killed.push(k);
  };
  return { handlers, doc, driver, killed };
}

describe("a spawn that cannot be verified is not a spawn that failed", () => {
  it("THE REGRESSION: an unavailable probe leaves the session STANDING", async () => {
    homeHolder.current = `/tmp/cbd-unv-${process.hrtime.bigint()}`;
    vi.resetModules();
    const { handlers, doc, driver, killed } = await fixtureWithProbe({
      kind: "unavailable",
      raw: "Command failed: tmux display-message … | stderr: (timed out)",
      attempts: 3,
    });

    const res = await handlers.dispatch(spawnRequest("probe-unavailable"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.5-test",
    });

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("spawn_unverified");
    // The two things that used to be destroyed on a guess.
    expect(killed).toHaveLength(0);
    expect(doc.peers["probe-unavailable"]).toBeDefined();
    // Kept, but not claimed to be running — `unknown` is the honest status.
    expect(doc.peers["probe-unavailable"]?.observed.status).toBe("unknown");
  });

  it("the error hands over the evidence instead of a theory", async () => {
    homeHolder.current = `/tmp/cbd-unv2-${process.hrtime.bigint()}`;
    vi.resetModules();
    const { handlers, doc, driver } = await fixtureWithProbe({
      kind: "unavailable",
      raw: "stderr: server exited unexpectedly",
      attempts: 3,
    });
    const res = await handlers.dispatch(spawnRequest("probe-msg"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.5-test",
    });
    const msg = res.error?.message ?? "";
    // What the host said, verbatim — a category tells you which box it fell
    // into, only the raw text tells you what happened.
    expect(msg).toContain("server exited unexpectedly");
    // How to look for yourself.
    expect(msg).toContain("capture-pane");
    // And no guessing. This message used to say "most likely exited
    // immediately" for a case where nobody had established anything.
    expect(msg).not.toMatch(/most likely|probably|presumably/i);
  });

  it("a target the host says is ABSENT is still torn down — that one is a fact", async () => {
    // The fix must not turn every failure into "keep it and hope". When tmux
    // states the target does not exist, the command really did exit, and
    // leaving a half-registered peer behind would be the phantom-live record
    // v0.10.2 removed.
    homeHolder.current = `/tmp/cbd-gone-${process.hrtime.bigint()}`;
    vi.resetModules();
    const { handlers, doc, driver, killed } = await fixtureWithProbe({
      kind: "no-such-target",
      raw: "can't find session: probe-gone",
    });
    const res = await handlers.dispatch(spawnRequest("probe-gone"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.5-test",
    });
    expect(res.error?.code).toBe("spawn_produced_no_process");
    expect(killed).toHaveLength(1);
    expect(doc.peers["probe-gone"]).toBeUndefined();
    expect(res.error?.message).toContain("can't find session");
  });

  it("a successful spawn is unaffected", async () => {
    homeHolder.current = `/tmp/cbd-ok-${process.hrtime.bigint()}`;
    vi.resetModules();
    const { handlers, doc, driver, killed } = await fixtureWithProbe({
      kind: "pid",
      pid: 4242,
      raw: "4242",
    });
    const res = await handlers.dispatch(spawnRequest("probe-ok"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.5-test",
    });
    expect(res.outcome).toBe("ok");
    expect(killed).toHaveLength(0);
    expect(doc.peers["probe-ok"]?.observed.status).toBe("live");
    expect(doc.peers["probe-ok"]?.observed.pid).toBe(4242);
  });

  it("a driver that reports no probe at all still fails closed", async () => {
    // The mock driver and any future host that cannot probe must not silently
    // gain the benefit of the doubt — absent evidence is not the same as
    // evidence of unavailability.
    homeHolder.current = `/tmp/cbd-noprobe-${process.hrtime.bigint()}`;
    vi.resetModules();
    const { handlers, state, mock } = await importAll();
    const doc = state.emptyState("0.11.5-test");
    const driver = new mock.MockDriver();
    const originalSpawn = driver.spawn.bind(driver);
    driver.spawn = async (opts) => ({ ...(await originalSpawn(opts)), alive: false, pid: null });
    const res = await handlers.dispatch(spawnRequest("probe-none"), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.5-test",
    });
    expect(res.error?.code).toBe("spawn_produced_no_process");
    expect(doc.peers["probe-none"]).toBeUndefined();
  });
});

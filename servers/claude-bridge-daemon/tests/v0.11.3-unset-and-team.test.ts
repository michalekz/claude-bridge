import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlConfigArgsSchema,
  handleControlConfig,
  viewOf,
} from "../src/handlers/control-config.ts";
import { emptyState } from "../src/state.ts";
import { makePeer } from "./peer-fixture.ts";

/**
 * ⚠ THIS BLOCK IS NOT BOILERPLATE. Without it this file destroys the operator's
 * live control plane.
 *
 * `handleControlConfig` persists through `applyStateChange` → `saveState` →
 * `stateFilePath()`, which resolves under `homedir()`. Unmocked, that is the
 * REAL `~/.claude-bridge/control/state.json`. This file shipped without the
 * mock on 2026-08-07 and five test runs overwrote the live 23-peer registry
 * with a fixture containing one imaginary peer. The fleet itself never
 * noticed — processes and tmux sessions are independent of the registry — but
 * the control plane lost every record it had.
 *
 * A structural guard now refuses writes outside a temp home (see
 * `tests/setup-isolate-home.ts`); this mock stays because the guard should
 * never be the thing that catches it.
 */
const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * Two decisions from the edge-test matrix, both filed as "behaviour undefined"
 * and both resolved by looking at what the behaviour would have COST.
 *
 * A6 — `team` is not settable. It looks like a field and behaves like an
 *      operation: declaring a new team leaves `homeSession` pointing at the old
 *      one, the tmux window where it was, and the derived label falling back to
 *      the fully qualified name — the exact regression v0.11.2 spent a release
 *      cleaning up. Moving a peer between teams is lifecycle work.
 *
 * #80 — `unset` withdraws a declaration, and it is NOT `set: {k: null}`.
 *      "Nobody has said" and "somebody said nothing" behave differently: an
 *      undeclared windowIndex reports no drift wherever the window sits, a
 *      declared one that disagrees does. Overloading null would fold those two
 *      together — the same conflation, one level up, that this whole release
 *      exists to undo.
 */

function ctxWith(...peers: ReturnType<typeof makePeer>[]) {
  const state = emptyState("0.11.3-test");
  for (const p of peers) state.peers[p.handle] = p;
  return { state, hostDriver: { name: "mock" }, daemonVersion: "0.11.3-test" } as never;
}

function request(args: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    id: `req-${Math.random().toString(36).slice(2)}`,
    ts: "2026-08-07T07:00:00.000Z",
    tool: "control_config",
    args,
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

function peersOf(ctx: unknown) {
  return (ctx as { state: { peers: Record<string, ReturnType<typeof makePeer>> } }).state.peers;
}

describe("A6 — team is not a declarable value", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-cfg2-${process.hrtime.bigint()}`;
  });

  it("setting `team` is refused by the schema", async () => {
    const ctx = ctxWith(makePeer("id-1", { team: "mic" }, { name: "mic-tester" }));
    const res = await handleControlConfig(
      request({ peer: "mic-tester", set: { team: "plt" } }),
      ctx,
    );
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("invalid_args");
  });

  it("`team` is not in the settable list the tool advertises", async () => {
    const ctx = ctxWith(makePeer("id-2", { team: "mic" }, { name: "mic-tester" }));
    const res = await handleControlConfig(request({ peer: "mic-tester" }), ctx);
    const data = res.data as { settableKeys: string[] };
    expect(data.settableKeys).not.toContain("team");
    // Still READABLE — the field exists, it just is not this tool's to write.
    const view = res.data as { peer: { desired: { team?: string } } };
    expect(view.peer.desired.team).toBe("mic");
  });
});

describe("#80 — unset withdraws a declaration, it does not empty one", () => {
  it("THE POINT: withdrawing removes the drift, emptying could not", async () => {
    // Declared 3, window actually at 8 → drift.
    const ctx = ctxWith(
      makePeer("id-3", { team: "mic", windowIndex: 3 }, { name: "mic-tester", windowIndex: 8 }),
    );
    expect(viewOf(peersOf(ctx)["id-3"] as never).drift).toHaveLength(1);

    const res = await handleControlConfig(
      request({ peer: "mic-tester", unset: ["windowIndex"] }),
      ctx,
    );
    expect(res.outcome).toBe("ok");
    const rec = peersOf(ctx)["id-3"];
    // Gone, not present-and-empty. `in` is the check that tells them apart, and
    // it is what the drift report keys off.
    expect("windowIndex" in (rec?.desired ?? {})).toBe(false);
    expect(viewOf(rec as never).drift).toHaveLength(0);
    // The measurement is untouched — we withdrew an opinion, not a fact.
    expect(rec?.observed.windowIndex).toBe(8);
  });

  it("the withdrawal is reported as a change, from the old value to null", async () => {
    const ctx = ctxWith(makePeer("id-4", { label: "QA" }, { name: "mic-tester" }));
    const res = await handleControlConfig(request({ peer: "mic-tester", unset: ["label"] }), ctx);
    const data = res.data as { changed: Array<{ key: string; from: unknown; to: unknown }> };
    expect(data.changed).toEqual([{ key: "label", from: "QA", to: null }]);
  });

  it("withdrawing something nobody declared is a no-op, not an error", async () => {
    const ctx = ctxWith(makePeer("id-5", {}, { name: "mic-tester" }));
    const res = await handleControlConfig(
      request({ peer: "mic-tester", unset: ["windowIndex"] }),
      ctx,
    );
    expect(res.outcome).toBe("ok");
    expect((res.data as { changed: unknown[] }).changed).toHaveLength(0);
  });

  it("dryRun withdraws nothing", async () => {
    const ctx = ctxWith(makePeer("id-6", { windowIndex: 3 }, { name: "mic-tester" }));
    await handleControlConfig(
      request({ peer: "mic-tester", unset: ["windowIndex"], dryRun: true }),
      ctx,
    );
    expect(peersOf(ctx)["id-6"]?.desired.windowIndex).toBe(3);
  });

  it("set and unset can be combined, but not on the same key", async () => {
    // Combining is useful — declare a label while dropping a stale windowIndex.
    // Doing both to one key is a caller who has not decided, and guessing an
    // order would make the result depend on an implementation detail.
    expect(
      ControlConfigArgsSchema.safeParse({
        peer: "p",
        set: { label: "x" },
        unset: ["windowIndex"],
      }).success,
    ).toBe(true);
    expect(
      ControlConfigArgsSchema.safeParse({ peer: "p", set: { label: "x" }, unset: ["label"] })
        .success,
    ).toBe(false);
  });

  it("unset needs a peer — no bulk withdrawal across a team", async () => {
    expect(ControlConfigArgsSchema.safeParse({ team: "mic", unset: ["label"] }).success).toBe(
      false,
    );
  });

  it("an unknown key cannot be withdrawn either", async () => {
    expect(ControlConfigArgsSchema.safeParse({ peer: "p", unset: ["spawnEnv"] }).success).toBe(
      false,
    );
  });

  it("a read is still a read — neither set nor unset present", async () => {
    const ctx = ctxWith(makePeer("id-7", { label: "tester" }, { name: "mic-tester" }));
    const res = await handleControlConfig(request({ peer: "mic-tester" }), ctx);
    expect(res.outcome).toBe("ok");
    expect(peersOf(ctx)["id-7"]?.desired.label).toBe("tester");
  });
});

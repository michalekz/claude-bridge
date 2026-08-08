import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfigArgs } from "../src/config-cli.ts";
import { handleControlConfig, viewOf } from "../src/handlers/control-config.ts";
import { emptyState } from "../src/state.ts";
import { makePeer } from "./peer-fixture.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * control_config is the ONE tool for declaring intent — Zdeněk's constraint of
 * 2026-08-05, "no breeding new MCP tools", turned into a design.
 *
 * The cases below guard the two properties that make it safe to hand to an
 * operator: it can only write the declared half, and when declaration and
 * reality disagree it presents both ways out rather than assuming the registry
 * is right.
 */

function ctxWith(...peers: ReturnType<typeof makePeer>[]) {
  const state = emptyState("0.11.0-test");
  for (const p of peers) state.peers[p.handle] = p;
  return {
    state,
    hostDriver: { name: "mock" },
    daemonVersion: "0.11.0-test",
  } as never;
}

function request(args: Record<string, unknown>, by = "operator") {
  return {
    schemaVersion: 1 as const,
    id: `req-${Math.random().toString(36).slice(2)}`,
    ts: "2026-08-06T17:00:00.000Z",
    tool: "control_config",
    args,
    requestedBy: { sessionId: by, name: by },
  };
}

describe("control_config declares intent and refuses to touch measurement", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-cfg-${process.hrtime.bigint()}`;
  });

  it("writes only the desired half", async () => {
    const peer = makePeer("id-1", { team: "mic" }, { name: "mic-tester", pid: 4242 });
    const ctx = ctxWith(peer);
    const res = await handleControlConfig(
      request({ peer: "mic-tester", set: { label: "tester" } }),
      ctx,
    );
    expect(res.outcome).toBe("ok");
    const rec = (ctx as unknown as { state: { peers: Record<string, typeof peer> } }).state.peers[
      "id-1"
    ];
    expect(rec?.desired.label).toBe("tester");
    // An operator must not be able to declare a peer alive. The measured half
    // belongs to whatever measured it.
    expect(rec?.observed.pid).toBe(4242);
  });

  it("THE POINT: a drift report offers BOTH ways out", async () => {
    // Designer's condition on the cut: naming only "make the world match the
    // registry" tells an operator who deliberately moved a window that they are
    // wrong. Often reality is the newer information, and `adopt` is how they
    // say so.
    const peer = makePeer("id-2", { windowIndex: 3 }, { name: "mic-web-dev", windowIndex: 7 });
    const view = viewOf(peer);
    expect(view.drift).toHaveLength(1);
    const d = view.drift[0];
    expect(d?.field).toBe("windowIndex");
    expect(d?.desired).toBe(3);
    expect(d?.observed).toBe(7);
    expect(d?.resolve.assert).toContain("3");
    expect(d?.resolve.adopt).toContain("windowIndex:7");
  });

  it("reports drift between the declared model and the running one", async () => {
    const peer = makePeer(
      "id-3",
      { model: "claude-opus-5" },
      { name: "ai-kb-dev", model: "claude-fable-5" },
    );
    const drift = viewOf(peer).drift.find((d) => d.field === "model");
    expect(drift?.desired).toBe("claude-opus-5");
    expect(drift?.observed).toBe("claude-fable-5");
  });

  it("no drift when a value was never declared", async () => {
    // Silence is not disagreement. A peer with no declared windowIndex has not
    // drifted from anything, and reporting it would drown the real cases.
    const peer = makePeer("id-4", {}, { name: "ai-kb-ops", windowIndex: 7 });
    expect(viewOf(peer).drift).toHaveLength(0);
  });

  it("dryRun reports the change and writes nothing", async () => {
    const peer = makePeer("id-5", { label: "old" }, { name: "mic-admin" });
    const ctx = ctxWith(peer);
    const res = await handleControlConfig(
      request({ peer: "mic-admin", set: { label: "new" }, dryRun: true }),
      ctx,
    );
    const data = res.data as { dryRun: boolean; changed: Array<{ from: unknown; to: unknown }> };
    expect(data.dryRun).toBe(true);
    expect(data.changed[0]).toMatchObject({ from: "old", to: "new" });
    const rec = (ctx as unknown as { state: { peers: Record<string, typeof peer> } }).state.peers[
      "id-5"
    ];
    expect(rec?.desired.label).toBe("old");
  });

  it("a write reports what it changed FROM, not just the new value", async () => {
    // Otherwise a no-op and a correction read identically in the audit trail.
    const peer = makePeer("id-6", { label: "velitel" }, { name: "mic-velitel" });
    const ctx = ctxWith(peer);
    const res = await handleControlConfig(
      request({ peer: "mic-velitel", set: { label: "velitel" } }),
      ctx,
    );
    const data = res.data as { changed: unknown[]; note: string };
    expect(data.changed).toHaveLength(0);
    expect(data.note).toContain("already matches");
  });

  it("a duplicated short name is refused, not guessed", async () => {
    // The naming convention holds here too — config is a write path, and
    // writing `label` onto the wrong team's velitel is silent.
    const ctx = ctxWith(
      makePeer("id-a", { team: "mic" }, { name: "mic-velitel" }),
      makePeer("id-b", { team: "etl" }, { name: "etl-velitel" }),
    );
    const res = await handleControlConfig(request({ peer: "velitel", set: { label: "v" } }), ctx);
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("ambiguous_peer");
  });

  it("an unknown key is rejected rather than silently stored", async () => {
    const ctx = ctxWith(makePeer("id-7", {}, { name: "mic-tester" }));
    const res = await handleControlConfig(
      request({ peer: "mic-tester", set: { spawnEnv: { PATH: "/evil" } } }),
      ctx,
    );
    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("invalid_args");
  });

  it("declaring intent for a whole team at once is refused", async () => {
    const ctx = ctxWith(makePeer("id-8", { team: "mic" }, { name: "mic-tester" }));
    const res = await handleControlConfig(request({ team: "mic", set: { label: "x" } }), ctx);
    expect(res.outcome).toBe("error");
  });
});

describe("the CLI parses the same intent a shell can express", () => {
  it("windowIndex arrives as a number, not the string a shell hands over", () => {
    // Schema validation would otherwise reject `windowIndex=3`, and the
    // operator would read "invalid arguments" as a broken tool.
    const a = parseConfigArgs(["mic-tester", "--set", "windowIndex=3"]);
    expect(a.set["windowIndex"]).toBe(3);
    expect(a.peer).toBe("mic-tester");
  });

  it("a non-integer windowIndex fails at the CLI, before the daemon sees it", () => {
    expect(() => parseConfigArgs(["p", "--set", "windowIndex=third"])).toThrow(/integer/);
  });

  it("the literal null clears a value", () => {
    expect(parseConfigArgs(["p", "--set", "model=null"]).set["model"]).toBeNull();
  });

  it("a value containing '=' survives intact", () => {
    // Splitting on every '=' would truncate anything with one in it.
    const a = parseConfigArgs(["p", "--set", "label=a=b"]);
    expect(a.set["label"]).toBe("a=b");
  });

  it("--dry-run and --reason are carried", () => {
    const a = parseConfigArgs(["p", "--set", "label=x", "--dry-run", "--reason", "post soak"]);
    expect(a.dryRun).toBe(true);
    expect(a.reason).toBe("post soak");
  });

  it("an unknown flag is an error, not an ignored argument", () => {
    expect(() => parseConfigArgs(["p", "--force"])).toThrow(/unknown flag/);
  });
});

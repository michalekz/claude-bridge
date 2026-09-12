/**
 * v0.11.54 — the record named one session; another one was doing the work.
 *
 * Reported from the mic fleet on 2026-09-12, and every layer behaved correctly
 * on the way to the wrong answer. `marketing` ran in TWO sessions there: the
 * daemon's record named the tmux one, idle since 10 September, while the live
 * one was a background spare outside the control plane. A rolling restart
 * restarted the session nobody was using, MISSED the one that was, and
 * reported the team complete. Nothing failed — the report was simply about a
 * different peer than the operator had in mind.
 *
 * `team_reconcile` has flagged this shape since v0.11.48 (the Ⓥ second
 * source). What was missing is that the restart path never asked: a drift
 * report nobody consults before acting arrives after the decision.
 */
import { describe, expect, it } from "vitest";
import { describeShadow, findShadowedRecords } from "../src/handlers/shadowed-records.ts";
import type { ProcessInspector } from "../src/hosts/process-inspector.ts";

const RECORDED = "aaaaaaaa-0000-0000-0000-000000000001";
const SHADOW = "bbbbbbbb-0000-0000-0000-000000000002";

function record(over: Record<string, unknown> = {}) {
  return {
    handle: "mic-marketing",
    desired: { team: "mic", cwd: "/tmp", command: "/usr/bin/claude" },
    observed: {
      name: "mic-marketing",
      hostDriver: "tmux",
      tmuxTarget: "mic:2",
      pid: 100,
      status: "live",
      model: null,
      sessionId: RECORDED,
      identity: "measured",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ...over,
    },
    // biome-ignore lint/suspicious/noExplicitAny: hand-built minimal record
  } as any;
}

function inspector(
  sessions: { pid: number; sessionId: string; name: string | null; kind: string | null }[] | Error,
): ProcessInspector {
  // Only the one member the detector uses — the rest of the inspector is
  // process-table machinery no fixture should have to imitate.
  return {
    listRegisteredSessions: async () => {
      if (sessions instanceof Error) throw sessions;
      return sessions;
    },
  } as unknown as ProcessInspector;
}

describe("a record is shadowed when another live session answers to its name", () => {
  it("🔴 THE MIC CASE: same name, different session id → shadowed", async () => {
    const found = await findShadowedRecords(
      [record()],
      inspector([
        { pid: 100, sessionId: RECORDED, name: "mic-marketing", kind: "interactive" },
        { pid: 777, sessionId: SHADOW, name: "mic-marketing", kind: "bg-spare" },
      ]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.shadowSessionId).toBe(SHADOW);
    expect(found[0]?.shadowPid).toBe(777);
    // The line an operator acts on must name BOTH sessions and the risk.
    const line = describeShadow(found[0] as never);
    expect(line).toContain(RECORDED);
    expect(line).toContain(SHADOW);
    expect(line).toMatch(/report success/);
  });

  it("kind is NOT filtered — 'only a subagent' is the assumption that hid it", async () => {
    const found = await findShadowedRecords(
      [record()],
      inspector([{ pid: 777, sessionId: SHADOW, name: "mic-marketing", kind: "bg-spare" }]),
    );
    expect(found).toHaveLength(1);
  });

  it("🟢 the peer's OWN session is not its own shadow", async () => {
    const found = await findShadowedRecords(
      [record()],
      inspector([{ pid: 100, sessionId: RECORDED, name: "mic-marketing", kind: "interactive" }]),
    );
    expect(found).toEqual([]);
  });

  it("a different name is a different peer, however alike the rest looks", async () => {
    const found = await findShadowedRecords(
      [record()],
      inspector([{ pid: 777, sessionId: SHADOW, name: "mic-obchod", kind: "interactive" }]),
    );
    expect(found).toEqual([]);
  });

  it("a record with no measured identity cannot be compared — and says nothing", async () => {
    const found = await findShadowedRecords(
      [record({ sessionId: null, identity: "unknown" })],
      inspector([{ pid: 777, sessionId: SHADOW, name: "mic-marketing", kind: "interactive" }]),
    );
    expect(found).toEqual([]);
  });

  it("an unreadable or absent registry says nothing — never 'shadowed'", async () => {
    expect(await findShadowedRecords([record()], inspector(new Error("no registry")))).toEqual([]);
    expect(await findShadowedRecords([record()], {} as unknown as ProcessInspector)).toEqual([]);
  });
});

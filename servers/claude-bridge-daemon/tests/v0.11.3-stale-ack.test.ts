import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * `peer_compact` accepted an ack that answered a different request.
 *
 * `pollForAck` tested one thing: does the file exist. Not when it was written,
 * not what it was for. Measured on the live fleet 2026-08-06 — a run at 06:39
 * timed out at 06:41, the peer finished its anchor at 06:41:39 and touched the
 * ack anyway, and the next run at 06:43 found that file and injected `/compact`
 * in the same second. It read as a success. Nobody had confirmed the anchor
 * belonged to that request.
 *
 * A tool whose entire purpose is to refuse a compact without a fresh anchor was
 * accepting a stale one, and it took writing the edge-test matrix to see it —
 * the case had been filed as "behaviour unknown" (B7) when it was a defect.
 *
 * Two mechanisms, because they close different holes:
 *
 *   the SWEEP  — clears the ground before waiting, so anything appearing after
 *                is fresh by construction. No clock reasoning required.
 *   the VERDICT — catches what the sweep cannot: an ack that is recent but
 *                answers another thread, which is what two concurrent compacts
 *                on one peer produce.
 */

const PEER = "70a00bc8-e68c-4ae2-9c8a-e1a87092454d";

const importCompact = () => import("../src/handlers/peer-compact.ts");

function ackDir(): string {
  return join(homeHolder.current, ".claude-bridge", "control", "compact-ack");
}

async function writeAck(body: unknown, ageMs = 0): Promise<string> {
  await mkdir(ackDir(), { recursive: true });
  const path = join(ackDir(), `${PEER}.json`);
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body), "utf-8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(path, when, when);
  }
  return path;
}

describe("an ack is only accepted as the answer to THIS request", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-ack-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  it("THE REGRESSION: an ack written before the request is refused", async () => {
    const { verifyAck } = await importCompact();
    // Two minutes old — the exact shape of the 06:41 leftover read at 06:43.
    const path = await writeAck({ threadId: "compact:x:old" }, 120_000);
    const v = await verifyAck(path, Date.now(), "compact:x:new");
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("too_old");
    // The verdict has to name WHEN, or an operator cannot tell a leftover from
    // a peer that never answered.
    expect(v.writtenAt).toBeTruthy();
  });

  it("an ack for a different thread is refused even when it is fresh", async () => {
    // Two compacts racing on one peer: the second must not consume the first's
    // anchor. Timestamps cannot separate these — only the thread can.
    const { verifyAck } = await importCompact();
    const path = await writeAck({ threadId: "compact:peer:aaa" });
    const v = await verifyAck(path, Date.now() - 5_000, "compact:peer:bbb");
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("wrong_thread");
    expect(v.ackThreadId).toBe("compact:peer:aaa");
  });

  it("a fresh ack with the right thread is accepted", async () => {
    const { verifyAck } = await importCompact();
    const path = await writeAck({ threadId: "compact:peer:aaa", anchor: "memory/x.md" });
    const v = await verifyAck(path, Date.now() - 5_000, "compact:peer:aaa");
    expect(v.accepted).toBe(true);
    expect(v.reason).toBe("fresh");
  });

  it("a bare `touch` still works — the playbook has always said to touch it", async () => {
    // Refusing an empty file would break the documented human path to close a
    // hole the sweep already closes. Freshness carries this case.
    const { verifyAck } = await importCompact();
    const path = await writeAck("");
    const v = await verifyAck(path, Date.now() - 5_000, "compact:peer:aaa");
    expect(v.accepted).toBe(true);
    expect(v.ackThreadId).toBeNull();
  });

  it("a missing ack is `none`, distinct from a rejected one", async () => {
    // The three outcomes lead to three different next steps and must stay
    // distinguishable all the way out to the caller.
    const { verifyAck } = await importCompact();
    const v = await verifyAck(join(ackDir(), `${PEER}.json`), Date.now(), "t");
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("none");
  });

  it("an ack written in the same second as the request is not called stale", async () => {
    // Filesystem timestamps are not a precision clock, and a fast peer answers
    // immediately. Losing those to an off-by-a-tick would be the fix causing
    // the failure it prevents.
    const { verifyAck } = await importCompact();
    const path = await writeAck({ threadId: "t" });
    const v = await verifyAck(path, Date.now() + 900, "t");
    expect(v.accepted).toBe(true);
  });

  it("startup sweeps every leftover ack out of the way", async () => {
    // A daemon that died mid-compact leaves an ack nobody will consume.
    const { sweepAllAcksAtStartup, verifyAck } = await importCompact();
    const path = await writeAck({ threadId: "orphan" }, 60_000);
    expect(await sweepAllAcksAtStartup()).toBe(1);
    const after = await verifyAck(path, Date.now() - 120_000, "orphan");
    expect(after.reason).toBe("none");
    // Swept, not destroyed — the audit trail keeps it.
    const { readdir } = await import("node:fs/promises");
    const done = await readdir(join(ackDir(), "done"));
    expect(done.some((f) => f.includes("startup"))).toBe(true);
  });

  it("sweeping an empty or missing directory is not an error", async () => {
    const { sweepAllAcksAtStartup } = await importCompact();
    expect(await sweepAllAcksAtStartup()).toBe(0);
  });
});

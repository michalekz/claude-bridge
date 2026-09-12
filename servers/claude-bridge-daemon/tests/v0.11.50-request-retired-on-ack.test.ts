/**
 * VLASTNÍK ŽÁDOSTI UKLÍZÍ SVOU OBÁLKU (0.11.50; oxy-obchod, reprodukováno
 * 2× na dvou bundlech): žádost čtená pushem a ackovaná SOUBOREM se nikdy
 * nedrénuje, přežije v pending/ a po restartu se naservíruje jako nová.
 * Idempotentní ack to skryje; neidempotentní žádost by běžela podruhé.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-retire-"));
  homeHolder.current = home;
  vi.resetModules();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("retireRequestEnvelope", () => {
  it("moves the pending request to done/ — mirroring what a drain would do", async () => {
    const { retireRequestEnvelope } = await import("../src/handlers/ack-protocol.ts");
    const sid = "aaaa0000-1111-2222-3333-444444444444";
    const pending = join(home, ".claude-bridge", "inbox", sid, "pending");
    await mkdir(pending, { recursive: true });
    await writeFile(join(pending, "msg-1.json"), "{}");
    await retireRequestEnvelope(sid, "msg-1");
    expect(await readdir(pending)).toHaveLength(0);
    expect(await readdir(join(home, ".claude-bridge", "inbox", sid, "done"))).toContain(
      "msg-1.json",
    );
  });

  it("an already-drained (or never-written) request is a fine state, not an error", async () => {
    const { retireRequestEnvelope } = await import("../src/handlers/ack-protocol.ts");
    await expect(
      retireRequestEnvelope("aaaa0000-1111-2222-3333-444444444444", "ghost"),
    ).resolves.toBeUndefined();
    await expect(
      retireRequestEnvelope("aaaa0000-1111-2222-3333-444444444444", null),
    ).resolves.toBeUndefined();
  });
});

describe("stop ack retires the stop request end-to-end", () => {
  it("after a graceful stop, the request envelope is in done/, not pending/", async () => {
    const { dispatch } = await import("../src/handlers/index.ts");
    const { emptyState } = await import("../src/state.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");
    const { stopAcks } = await import("../src/handlers/ack-protocol.ts");

    const doc = emptyState("t");
    const ctx = { state: doc, hostDriver: new MockDriver(), daemonVersion: "t" };
    const spawn = await dispatch(
      {
        schemaVersion: 1 as const,
        id: "s1",
        ts: "2026-09-12T08:00:00.000Z",
        tool: "peer_spawn",
        args: {
          handle: "ret-test",
          displayName: "ret-test",
          cwd: home,
          command: "/bin/sh",
          args: ["-c", "exec sleep 30"],
        },
        requestedBy: { sessionId: "op", name: "op" },
      },
      ctx,
    );
    expect(spawn.outcome).toBe("ok");

    // peer "acks" by file the moment the request lands (a well-behaved peer)
    const acker = (async () => {
      const pending = join(home, ".claude-bridge", "inbox", "ret-test", "pending");
      for (let i = 0; i < 100; i++) {
        const files = await readdir(pending).catch(() => [] as string[]);
        const req = files.find((f) => f.endsWith(".json"));
        if (req) {
          const threadId = JSON.parse(
            await (await import("node:fs/promises")).readFile(join(pending, req), "utf-8"),
          ).threadId as string;
          await mkdir(stopAcks.dir(), { recursive: true });
          await writeFile(
            join(stopAcks.dir(), "ret-test.json"),
            JSON.stringify({ threadId, anchor: "none" }),
          );
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    const stop = await dispatch(
      {
        schemaVersion: 1 as const,
        id: "st1",
        ts: "2026-09-12T08:00:05.000Z",
        tool: "peer_stop",
        args: { peer: "ret-test", ackTimeoutMs: 8000 },
        requestedBy: { sessionId: "op", name: "op" },
      },
      ctx,
    );
    await acker;
    expect(stop.outcome).toBe("ok");
    const base = join(home, ".claude-bridge", "inbox", "ret-test");
    const pendingLeft = (await readdir(join(base, "pending")).catch(() => [] as string[])).filter(
      (f) => f.endsWith(".json"),
    );
    expect(pendingLeft).toHaveLength(0);
    const done = await readdir(join(base, "done")).catch(() => [] as string[]);
    expect(done.length).toBeGreaterThan(0);
  });
});

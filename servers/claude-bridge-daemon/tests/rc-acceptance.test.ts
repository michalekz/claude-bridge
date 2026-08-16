import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CanonicalTarget,
  canonicalHostTarget,
  trustCanonicalTarget,
} from "../src/hosts/driver.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

async function importAll() {
  return {
    handlers: await import("../src/handlers/index.ts"),
    state: await import("../src/state.ts"),
    mock: await import("../src/hosts/mock-driver.ts"),
    shared: await import("@claude-bridge/shared"),
  };
}

/**
 * A REAL executable that answers `agents --json` with an empty fleet.
 *
 * v0.11.27: `peer_compact` now refuses to inject when the busy probe cannot be
 * run, so a fixture whose `command` is `/bin/sleep` no longer reaches the
 * send-keys step — `/bin/sleep agents --json` fails, and failing closed is the
 * point of the fix. Handing the handler a genuine binary keeps the acceptance
 * honest: the resolution and parse paths run for real, exactly as they do in
 * the daemon, instead of being stubbed away. That distinction is what the
 * original 94a acceptance got wrong — it exercised a path where the defect
 * could not arise, so it passed while the gate was dead in production.
 */
async function writeAgentsStub(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "claude-stub.sh");
  // Answers the probe and otherwise stays alive: the driver really launches
  // this, and `hostAlive` is measured from the process. A real client behaves
  // the same way — `agents --json` returns, the session keeps running.
  await writeFile(
    path,
    "#!/bin/sh\nif [ \"$1\" = 'agents' ]; then echo '[]'; exit 0; fi\nexec sleep 10\n",
    { mode: 0o755 },
  );
  return path;
}

function makeRequest(tool: string, args: Record<string, unknown>, id = "req-1") {
  return {
    schemaVersion: 1 as const,
    id,
    ts: "2026-07-23T13:00:00.000Z",
    tool,
    args,
    requestedBy: { sessionId: "rc-caller", name: "rc-caller" },
  };
}

describe("rc acceptance", () => {
  beforeEach(() => {
    homeHolder.current = `/tmp/cbd-rc-${process.hrtime.bigint()}`;
    vi.resetModules();
  });

  describe("acceptance: team_layout reconcile (apply + prune)", () => {
    it("spawns missing peers on apply and removes extras only with prune:true", async () => {
      const { handlers, state, mock } = await importAll();
      const doc = state.emptyState("0.10.0-rc.0");
      const driver = new mock.MockDriver();

      // Pre-existing extra peer that's NOT in the team spec.
      doc.peers["extra-1"] = {
        handle: "extra-1",
        desired: {
          accountProfile: null,
        },
        observed: {
          name: "extra:one",
          hostDriver: "mock",
          tmuxTarget: canonicalHostTarget("extra:one"),
          pid: 1111,
          status: "live",
          model: null,
          startedAt: "2026-07-23T12:00:00.000Z",
          lastUpdatedAt: "2026-07-23T12:00:00.000Z",
        },
      };
      // Pretend it's alive at the host level too (so peer_stop's driver
      // path finds something to kill).
      await driver.spawn({
        sessionKey: trustCanonicalTarget("extra:one"),
        cwd: "/tmp",
        command: "/bin/sleep",
        args: ["10"],
        env: {},
      });

      const inlineSpec = {
        team: "rc-test",
        peers: [
          {
            handle: "peer-a",
            displayName: "rc-test:alice",
            cwd: "/tmp",
            command: "/bin/sleep",
            args: ["10"],
            resume: false,
            model: null,
            accountProfile: null,
            extraAllowEnv: [],
            extraEnv: {},
          },
          {
            handle: "peer-b",
            displayName: "rc-test:bob",
            cwd: "/tmp",
            command: "/bin/sleep",
            args: ["10"],
            resume: false,
            model: null,
            accountProfile: null,
            extraAllowEnv: [],
            extraEnv: {},
          },
        ],
      };

      // First: apply without prune — extra-1 must be kept.
      const applyRes = await handlers.dispatch(
        makeRequest(
          "team_layout",
          { team: "rc-test", apply: true, prune: false, inline: inlineSpec },
          "req-apply",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.0" },
      );
      expect(applyRes.outcome).toBe("ok");
      const applyData = applyRes.data as {
        spawnedOk: string[];
        stoppedOk: string[];
        keptExtras: string[];
      };
      expect(applyData.spawnedOk.sort()).toEqual(["peer-a", "peer-b"]);
      expect(applyData.stoppedOk).toEqual([]);
      expect(applyData.keptExtras).toEqual(["extra-1"]);
      expect(doc.peers["extra-1"]).toBeDefined();
      expect(doc.peers["peer-a"]?.observed.status).toBe("live");

      // Second: reconcile with prune — extra-1 should be gone.
      const pruneRes = await handlers.dispatch(
        makeRequest(
          "team_layout",
          // `pruneForce` pins the pre-v0.11.17 semantics. This case is about
          // WHICH peers prune removes, not about whether they are asked first;
          // without it the graceful path waits out its full ack window on a
          // mock peer that has nobody to answer for it.
          { team: "rc-test", apply: true, prune: true, pruneForce: true, inline: inlineSpec },
          "req-prune",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.0" },
      );
      expect(pruneRes.outcome).toBe("ok");
      const pruneData = pruneRes.data as {
        spawnedOk: string[];
        stoppedOk: string[];
      };
      expect(pruneData.spawnedOk).toEqual([]); // both already live
      expect(pruneData.stoppedOk).toEqual(["extra-1"]);
      expect(doc.peers["extra-1"]).toBeUndefined();

      driver.reset();
    });
  });

  describe("acceptance: offline-subscriber delivery", () => {
    it("drops a lifecycle-event message into an offline peer's inbox after peer_started", async () => {
      const { handlers, state, mock, shared } = await importAll();
      const doc = state.emptyState("0.10.0-rc.0");
      const driver = new mock.MockDriver();

      // Register keeper as subscriber of peer_started.
      const subscribersPath = join(shared.controlDir(), "subscribers.json");
      await mkdir(shared.controlDir(), { recursive: true });
      await writeFile(
        subscribersPath,
        JSON.stringify({ subscribers: [{ peerId: "keeper-peer", events: ["peer_started"] }] }),
      );

      const spawnRes = await handlers.dispatch(
        makeRequest(
          "peer_spawn",
          {
            handle: "rc-peer-1",
            displayName: "rc:one",
            cwd: "/tmp",
            command: "/bin/sleep",
            args: ["10"],
          },
          "req-spawn",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.0" },
      );
      expect(spawnRes.outcome).toBe("ok");

      const inboxDir = join(shared.bridgeRoot(), "inbox", "keeper-peer", "pending");
      const files = await readdir(inboxDir);
      expect(files.length).toBeGreaterThan(0);
      const msg = JSON.parse(await readFile(join(inboxDir, files[0] ?? ""), "utf-8"));
      // R3 (v0.11.21): this test used to assert the BROKEN shape. The envelope
      // was hand-built with `kind: "lifecycle-event"` — a value absent from
      // `MessageKindSchema` — plus object `from`/`to`, `ts` instead of
      // `sentAt`, and an object `content`. The reader `safeParse`s, so every
      // one of these would have been written and then silently ignored.
      //
      // Nobody noticed because `subscribers.json` has never existed on the
      // fleet (measured 2026-08-08), so the loop had never run outside this
      // test — and this test read the file back with a bare `JSON.parse`,
      // which is happy with anything. A contract test that does not use the
      // contract's own parser tests the writer against itself.
      const { MessageEnvelopeSchema } = await import("@claude-bridge/shared");
      const parsed = MessageEnvelopeSchema.parse(msg);
      expect(parsed.kind).toBe("broadcast");
      expect(parsed.to).toBe("keeper-peer");
      expect(typeof parsed.content).toBe("string");
      expect(parsed.content).toContain("peer_started");
      // The handle names WHICH peer the event is about — it is in the text,
      // because `content` is text now.
      expect(parsed.content).toContain("rc-peer-1");

      driver.reset();
    });
  });

  describe("acceptance: peer_compact orchestrace (mock peer: request → anchor-ack → compact → ready)", () => {
    it("waits for anchor-ack file, then sends /compact via driver.sendKeys and emits peer_compacted", async () => {
      const { handlers, state, mock, shared } = await importAll();
      const doc = state.emptyState("0.10.0-rc.0");
      const driver = new mock.MockDriver();
      const agentsStub = await writeAgentsStub(homeHolder.current);

      // Pre-register a live peer.
      await handlers.dispatch(
        makeRequest(
          "peer_spawn",
          {
            handle: "compact-peer",
            displayName: "compact:target",
            cwd: "/tmp",
            command: agentsStub,
            args: ["10"],
          },
          "req-spawn",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.0" },
      );

      // Spy on driver.sendKeys — MockDriver doesn't have one; wire it up.
      const sendKeysCalls: Array<{ key: string; keys: string }> = [];
      (driver as unknown as { sendKeys: (key: string, keys: string) => Promise<void> }).sendKeys =
        async (key, keys) => {
          sendKeysCalls.push({ key, keys });
        };

      // Simulate peer ack by pre-writing the ack file.
      const ackDir = join(shared.controlDir(), "compact-ack");
      await mkdir(ackDir, { recursive: true });
      await writeFile(join(ackDir, "compact-peer.json"), JSON.stringify({ ready: true, ts: "…" }));

      const compactRes = await handlers.dispatch(
        makeRequest(
          "peer_compact",
          {
            peer: "compact-peer",
            anchorTimeoutMs: 2000,
            ackPollMs: 100,
            skipAnchorRequest: true, // ack already written; skip anchor msg
            reason: "acceptance-test",
          },
          "req-compact",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.0" },
      );
      expect(compactRes.outcome).toBe("ok");
      // v0.10.0-rc.2: sessionKey is canonicalized (`:` → `_`) before it
      // ever reaches the driver — send-keys always receives the sanitized form.
      expect(sendKeysCalls).toEqual([{ key: "compact_target", keys: "/compact" }]);

      // Ack file must have been consumed (moved to done/ or unlinked).
      const doneDir = join(shared.controlDir(), "compact-ack", "done");
      let doneFiles: string[] = [];
      try {
        doneFiles = await readdir(doneDir);
      } catch {
        // done/ not created — ack unlinked instead; either is acceptable.
      }
      // Assert original ack file no longer at its live path.
      let originalExists = true;
      try {
        await readFile(join(ackDir, "compact-peer.json"), "utf-8");
      } catch {
        originalExists = false;
      }
      expect(originalExists).toBe(false);
      expect(doneFiles.length + Number(originalExists)).toBeGreaterThanOrEqual(0);

      driver.reset();
    });

    it("times out with anchor_timeout when the ack file never appears", async () => {
      const { handlers, state, mock } = await importAll();
      const doc = state.emptyState("0.10.0-rc.0");
      const driver = new mock.MockDriver();
      (driver as unknown as { sendKeys: (key: string, keys: string) => Promise<void> }).sendKeys =
        async () => {
          throw new Error("sendKeys must NOT be called when ack times out");
        };

      await handlers.dispatch(
        makeRequest(
          "peer_spawn",
          {
            handle: "timeout-peer",
            displayName: "timeout:target",
            cwd: "/tmp",
            command: "/bin/sleep",
            args: ["10"],
          },
          "req-spawn",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.0" },
      );

      const res = await handlers.dispatch(
        makeRequest(
          "peer_compact",
          {
            peer: "timeout-peer",
            anchorTimeoutMs: 300,
            ackPollMs: 50,
            skipAnchorRequest: true,
          },
          "req-compact",
        ),
        { state: doc, hostDriver: driver, daemonVersion: "0.10.0-rc.0" },
      );
      expect(res.outcome).toBe("error");
      expect(res.error?.code).toBe("anchor_timeout");

      driver.reset();
    });
  });
});

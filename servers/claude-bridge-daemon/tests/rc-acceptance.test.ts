import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
        sessionId: "extra-1",
        name: "extra:one",
        hostDriver: "mock",
        tmuxTarget: "extra:one",
        pid: 1111,
        status: "live",
        model: null,
        accountProfile: null,
        startedAt: "2026-07-23T12:00:00.000Z",
        lastUpdatedAt: "2026-07-23T12:00:00.000Z",
      };
      // Pretend it's alive at the host level too (so peer_stop's driver
      // path finds something to kill).
      await driver.spawn({
        sessionKey: "extra:one",
        cwd: "/tmp",
        command: "/bin/sleep",
        args: ["10"],
        env: {},
      });

      const inlineSpec = {
        team: "rc-test",
        peers: [
          {
            sessionId: "peer-a",
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
            sessionId: "peer-b",
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
      expect(doc.peers["peer-a"]?.status).toBe("live");

      // Second: reconcile with prune — extra-1 should be gone.
      const pruneRes = await handlers.dispatch(
        makeRequest(
          "team_layout",
          { team: "rc-test", apply: true, prune: true, inline: inlineSpec },
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
            sessionId: "rc-peer-1",
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
      expect(msg.kind).toBe("lifecycle-event");
      expect(msg.content.event).toBe("peer_started");
      expect(msg.content.sessionId).toBe("rc-peer-1");

      driver.reset();
    });
  });

  describe("acceptance: peer_compact orchestrace (mock peer: request → anchor-ack → compact → ready)", () => {
    it("waits for anchor-ack file, then sends /compact via driver.sendKeys and emits peer_compacted", async () => {
      const { handlers, state, mock, shared } = await importAll();
      const doc = state.emptyState("0.10.0-rc.0");
      const driver = new mock.MockDriver();

      // Pre-register a live peer.
      await handlers.dispatch(
        makeRequest(
          "peer_spawn",
          {
            sessionId: "compact-peer",
            displayName: "compact:target",
            cwd: "/tmp",
            command: "/bin/sleep",
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
            sessionId: "timeout-peer",
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

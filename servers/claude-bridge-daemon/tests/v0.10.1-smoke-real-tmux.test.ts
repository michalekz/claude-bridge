import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TMUX = hasTmux();
const created: string[] = [];

function tmuxHas(key: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", key], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * SMOKE — the team lifecycle against a REAL tmux server (v0.10.1).
 *
 * Everything else in this suite drives MockDriver, which means the seam
 * between the handlers and the actual host has never been exercised: whether
 * `team_stop` really removes a tmux session, whether a resumed peer really
 * comes back with `--resume`, whether the wake injection really lands in the
 * new pane. Those are exactly the places where v0.10.0-rc.1 shipped two bugs
 * that unit tests could not see (session names silently rewritten by tmux; a
 * kill that was not idempotent).
 *
 * The control plane is isolated in a temp HOME so this never touches the
 * production `~/.claude-bridge/` or the running daemon. tmux itself is shared
 * with the machine, so every session name is unique to this process.
 */
describe.skipIf(!TMUX)("v0.10.1 smoke — team lifecycle on real tmux", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-smoke-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const key of created) {
      try {
        execFileSync("tmux", ["kill-session", "-t", key], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  });

  function makeRequest(tool: string, args: Record<string, unknown>, id: string) {
    return {
      schemaVersion: 1 as const,
      id,
      ts: "2026-08-03T21:00:00.000Z",
      tool,
      args,
      requestedBy: { sessionId: "smoke-caller", name: "smoke-caller" },
    };
  }

  it("spawn → stop with ack → resume with wake, all verified against tmux itself", async () => {
    const handlers = await import("../src/handlers/index.ts");
    const { emptyState } = await import("../src/state.ts");
    const { TmuxDriver } = await import("../src/hosts/tmux-driver.ts");
    const shared = await import("@claude-bridge/shared");

    const sessionId = `smoke-peer-${process.pid}`;
    // A colon in the display name on purpose: the rc.1 bug was tmux silently
    // rewriting it, so the canonical form must survive the whole round trip.
    const displayName = `smoke:${process.pid}`;
    const canonical = `smoke_${process.pid}`;
    created.push(canonical);

    const doc = emptyState("0.10.1-rc.1");
    const driver = new TmuxDriver({ sendVerifyDelayMs: 400 });
    const ctx = { state: doc, hostDriver: driver, daemonVersion: "0.10.1-rc.1" };

    // `cat` stands in for a peer: it stays alive and echoes injected text, so
    // the wake verification exercises the same path a real CC input box would.
    const spec = {
      team: "smoke",
      peers: [
        {
          sessionId,
          displayName,
          cwd: "/tmp",
          command: "/bin/sh",
          args: ["-c", "cat", "smoke"],
          resume: false,
          model: null,
          accountProfile: null,
          extraAllowEnv: [],
          extraEnv: {},
        },
      ],
    };

    // ---- 1. bring the team up on real tmux -------------------------------
    const up = await handlers.dispatch(
      makeRequest("team_layout", { team: "smoke", apply: true, inline: spec }, "smoke-up"),
      ctx,
    );
    expect(up.outcome).toBe("ok");
    expect(tmuxHas(canonical)).toBe(true);
    // The T1 contract: state holds the canonical key, not the raw one.
    expect(doc.peers[sessionId]?.observed.tmuxTarget).toBe(canonical);
    expect(doc.peers[sessionId]?.observed.status).toBe("live");

    // ---- 2. controlled stop, peer acks -----------------------------------
    // The peer acks AFTER the request, as a real one does. Pre-writing worked
    // until v0.11.15, when the stop channel gained the stale-ack sweep that
    // `peer_compact` has had since v0.11.3.
    const ackDir = join(shared.controlDir(), "stop-ack");
    const acker = (async () => {
      await new Promise((r) => setTimeout(r, 200));
      await mkdir(ackDir, { recursive: true });
      await writeFile(join(ackDir, `${sessionId}.json`), JSON.stringify({ ready: true }));
    })();

    const stop = await handlers.dispatch(
      makeRequest(
        "team_stop",
        {
          team: "smoke",
          inline: { team: "smoke", peers: [{ sessionId, displayName }] },
          anchorTimeoutMs: 8_000,
          ackPollMs: 100,
        },
        "smoke-stop",
      ),
      ctx,
    );
    await acker;
    expect(stop.outcome).toBe("ok");
    expect((stop.data as { stoppedCleanly: string[] }).stoppedCleanly).toEqual([sessionId]);
    // tmux is the judge, not our own bookkeeping.
    expect(tmuxHas(canonical)).toBe(false);
    expect(doc.peers[sessionId]?.observed.status).toBe("stopped");
    expect(doc.peers[sessionId]?.observed.stoppedCleanly).toBe(true);

    // ---- 3. resume the same session id, and wake it ----------------------
    const back = await handlers.dispatch(
      makeRequest(
        "team_layout",
        { team: "smoke", apply: true, inline: spec, wakeDelayMs: 300 },
        "smoke-back",
      ),
      ctx,
    );
    expect(back.outcome).toBe("ok");
    const data = back.data as { resumedOk: string[]; wokenOk: string[]; spawnedOk: string[] };
    expect(data.spawnedOk).toEqual([]); // resumed, not freshly spawned
    expect(data.resumedOk).toEqual([sessionId]);
    // The wake had to pass verified send-keys — if the text had not appeared
    // in the pane, sendKeys would have thrown and this list would be empty.
    expect(data.wokenOk).toEqual([sessionId]);
    expect(tmuxHas(canonical)).toBe(true);
    expect(doc.peers[sessionId]?.observed.status).toBe("live");

    // The wake text is really in the pane, read straight from tmux.
    const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", canonical], {
      encoding: "utf-8",
    });
    expect(pane).toContain("Wake");

    // ---- 4. adopt it back after wiping daemon state ----------------------
    // Models the motivating case: peers alive on the host, daemon knows none.
    const hostPid = doc.peers[sessionId]?.observed.pid ?? null;
    doc.peers = {};
    const adopt = await handlers.dispatch(
      makeRequest(
        "team_adopt",
        { team: "smoke", mode: "manual", mapping: { [canonical]: sessionId }, dryRun: false },
        "smoke-adopt",
      ),
      ctx,
    );
    expect(adopt.outcome).toBe("ok");
    expect((adopt.data as { adopted: string[] }).adopted).toEqual([sessionId]);
    expect(doc.peers[sessionId]?.observed.adopted).toBe(true);
    expect(doc.peers[sessionId]?.desired.team).toBe("smoke");
    expect(hostPid).not.toBeNull();

    // ---- cleanup ---------------------------------------------------------
    await driver.kill(canonical);
    expect(tmuxHas(canonical)).toBe(false);
  }, 40_000);
});

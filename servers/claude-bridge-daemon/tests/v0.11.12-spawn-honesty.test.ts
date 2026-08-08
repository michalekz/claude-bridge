import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.12 — `peer_spawn` stops reporting success it has not established.
 *
 * Both defects were reproduced on 2026-08-08 while building a trap for a
 * different bug, and both are the day's recurring shape: an answer given from a
 * source that knows nothing about the actual effect.
 *
 *   N9  Three peers were spawned with `resume`. All three returned `ok` with a
 *       pid. All three processes were dead within the second, and the registry
 *       held `status: "live"` for all three — because the driver probes for a
 *       pid the instant the host command returns, and a process about to exit
 *       is still a live pid at that instant.
 *
 *   N10 The reason they died was one line in the pane: "No conversation found
 *       with session ID: …". Nothing had checked whether there was a transcript
 *       to resume. The operator got "did not survive" — a shrug, where a
 *       diagnosis was available for the cost of one `existsSync`.
 */

const CLAUDE = "/home/x/.nvm/versions/node/v24/bin/claude";
const UUID = "df3167b4-7ed9-421b-aa67-11561eaf50fa";

function spawnReq(over: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    id: "req-spawn",
    ts: "2026-08-08T10:00:00.000Z",
    tool: "peer_spawn",
    args: {
      handle: UUID,
      displayName: "scr-a",
      cwd: "/opt/hmh",
      command: CLAUDE,
      args: [],
      resume: true,
      ...over,
    },
    requestedBy: { sessionId: "operator", name: "operator" },
  };
}

async function fixture() {
  const handlers = await import("../src/handlers/index.ts");
  const state = await import("../src/state.ts");
  const mock = await import("../src/hosts/mock-driver.ts");
  return { handlers, doc: state.emptyState("0.11.12-test"), driver: new mock.MockDriver() };
}

/** `~/.claude/projects/<encoded cwd>/<uuid>.jsonl` */
async function writeTranscript(cwd: string, uuid: string) {
  const encoded = cwd.replace(/\/+/g, "-").replace(/[^a-zA-Z0-9-]/g, "-");
  const dir = join(homeHolder.current, ".claude", "projects", encoded);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${uuid}.jsonl`), "{}\n");
  return join(dir, `${uuid}.jsonl`);
}

beforeEach(() => {
  homeHolder.current = `/tmp/cbd-spawn-honesty-${process.hrtime.bigint()}`;
  vi.resetModules();
});

describe("N10 — nothing to resume is said before anything is started", () => {
  it("THE REGRESSION: no transcript anywhere is refused, with both causes named", async () => {
    const { handlers, doc, driver } = await fixture();
    const res = await handlers.dispatch(spawnReq({}), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.12-test",
    });

    expect(res.error?.code).toBe("resume_transcript_missing");
    // A session file is written at boot; a transcript only once something is
    // said. Those are different things and the message has to separate them.
    expect(res.error?.message).toMatch(/session id is wrong|never held a conversation/);
    // And nothing was started to find that out.
    expect(doc.peers[UUID]).toBeUndefined();
  });

  it("a transcript under a DIFFERENT cwd is reported as such, with the path", async () => {
    // The other cause of "No conversation found", and the one that bit us on
    // 2026-08-04: Claude Code looks for transcripts under a directory derived
    // from cwd, so a peer relaunched elsewhere cannot see its own history.
    const { handlers, doc, driver } = await fixture();
    const elsewhere = await writeTranscript("/opt/oxy-kb", UUID);

    const res = await handlers.dispatch(spawnReq({ cwd: "/opt/hmh" }), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.12-test",
    });

    expect(res.error?.code).toBe("resume_transcript_missing");
    expect(res.error?.message).toContain(elsewhere);
    expect(res.error?.message).toMatch(/working director/i);
  });

  it("a transcript that IS there lets the spawn proceed", async () => {
    const { handlers, doc, driver } = await fixture();
    await writeTranscript("/opt/hmh", UUID);
    const res = await handlers.dispatch(spawnReq({}), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.12-test",
    });
    expect(res.error?.code).not.toBe("resume_transcript_missing");
  });

  it("a command that is not Claude is not asked about transcripts", async () => {
    // `resume` means something else to another program, and this handler has no
    // business inventing a rule for a command it knows nothing about.
    const { handlers, doc, driver } = await fixture();
    const res = await handlers.dispatch(spawnReq({ command: "/bin/sh" }), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.12-test",
    });
    expect(res.error?.code).not.toBe("resume_transcript_missing");
  });
});

describe("N9 — a spawn that did not last is not a spawn that succeeded", () => {
  it("THE REGRESSION: a peer dead a moment later is not reported as ok", async () => {
    const { handlers, doc, driver } = await fixture();
    await writeTranscript("/opt/hmh", UUID);

    // The driver sees a live pid at the instant the command returns...
    const originalSpawn = driver.spawn.bind(driver);
    driver.spawn = async (opts) => ({
      ...(await originalSpawn(opts)),
      alive: true,
      pid: 5150,
      // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the probe field
      probe: { kind: "pid", pid: 5150, raw: "5150" } as any,
    });
    // ...and a moment later the pane holds a corpse.
    // biome-ignore lint/suspicious/noExplicitAny: mock gains an optional method
    (driver as any).probePane = async () => ({
      kind: "dead",
      pid: 5150,
      exitStatus: 1,
      raw: "5150\t1\t1",
    });
    // biome-ignore lint/suspicious/noExplicitAny: mock gains an optional method
    (driver as any).archivePane = async () => "/tmp/archive/pane-scr-a.log";

    const res = await handlers.dispatch(spawnReq({}), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.12-test",
      spawnConfirmMs: 1,
    });

    expect(res.outcome).toBe("error");
    expect(res.error?.code).toBe("spawn_process_exited");
    // And the registry does not keep a live record over a dead process.
    expect(doc.peers[UUID]).toBeUndefined();
  });

  it("a peer that is still there is reported ok, as before", async () => {
    const { handlers, doc, driver } = await fixture();
    await writeTranscript("/opt/hmh", UUID);
    const originalSpawn = driver.spawn.bind(driver);
    driver.spawn = async (opts) => ({
      ...(await originalSpawn(opts)),
      alive: true,
      pid: 6060,
      // biome-ignore lint/suspicious/noExplicitAny: narrow shim for the probe field
      probe: { kind: "pid", pid: 6060, raw: "6060" } as any,
    });
    // biome-ignore lint/suspicious/noExplicitAny: mock gains an optional method
    (driver as any).probePane = async () => ({ kind: "pid", pid: 6060, raw: "6060" });

    const res = await handlers.dispatch(spawnReq({}), {
      state: doc,
      hostDriver: driver,
      daemonVersion: "0.11.12-test",
      spawnConfirmMs: 1,
    });

    expect(res.outcome).toBe("ok");
    expect(doc.peers[UUID]?.observed.status).toBe("live");
  });
});

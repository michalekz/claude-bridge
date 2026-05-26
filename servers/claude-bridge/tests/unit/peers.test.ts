import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  type Heartbeat,
  HeartbeatSchema,
  ONLINE_THRESHOLD_MS,
  createPeerRegistry,
} from "../../src/registry/peers.ts";

function uuid(label: string): string {
  return `${label.padEnd(8, "0")}-0000-0000-0000-000000000000`.slice(0, 36);
}

describe("HeartbeatSchema", () => {
  test("accepts valid heartbeat (id + name + pid + lastSeen)", () => {
    const hb: Heartbeat = {
      id: uuid("mantis"),
      name: "mantis",
      pid: 1234,
      lastSeen: "2026-05-25T10:00:00.000Z",
    };
    expect(HeartbeatSchema.safeParse(hb).success).toBe(true);
  });

  test("rejects missing id", () => {
    expect(
      HeartbeatSchema.safeParse({ name: "x", pid: 1, lastSeen: "2026-05-25T10:00:00.000Z" })
        .success,
    ).toBe(false);
  });

  test("rejects missing name", () => {
    expect(
      HeartbeatSchema.safeParse({
        id: uuid("x"),
        pid: 1,
        lastSeen: "2026-05-25T10:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("accepts optional cwd, source, version", () => {
    const hb = {
      id: uuid("mantis"),
      name: "mantis",
      pid: 1,
      cwd: "/opt/foo",
      lastSeen: "2026-05-25T10:00:00.000Z",
      source: "env",
      version: "0.0.1",
    };
    expect(HeartbeatSchema.safeParse(hb).success).toBe(true);
  });
});

describe("createPeerRegistry — startHeartbeat / listActivePeers", () => {
  let baseDir: string;
  let fakeNow = 1_700_000_000_000;
  const now = () => fakeNow;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "claude-bridge-peers-"));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(baseDir, "status"), { recursive: true, force: true });
    fakeNow = 1_700_000_000_000;
  });

  test("startHeartbeat writes <id>.json immediately with id + name + pid", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    const id = uuid("mantis");
    const handle = await reg.startHeartbeat({ id, name: "mantis", pid: 1234 });

    const path = join(baseDir, "status", `${id}.json`);
    const content = JSON.parse(await readFile(path, "utf-8"));
    expect(content.id).toBe(id);
    expect(content.name).toBe("mantis");
    expect(content.pid).toBe(1234);

    await handle.stop();
  });

  test("stop removes heartbeat file", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    const id = uuid("mantis");
    const handle = await reg.startHeartbeat({ id, name: "mantis", pid: 1 });

    const path = join(baseDir, "status", `${id}.json`);
    expect((await stat(path)).isFile()).toBe(true);

    await handle.stop();
    await expect(stat(path)).rejects.toThrow();
  });

  test("flush updates lastSeen without waiting for interval", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    const id = uuid("mantis");
    const handle = await reg.startHeartbeat({ id, name: "mantis", pid: 1 });

    const path = join(baseDir, "status", `${id}.json`);
    const initial = JSON.parse(await readFile(path, "utf-8"));

    fakeNow += 1000;
    await handle.flush();
    const refreshed = JSON.parse(await readFile(path, "utf-8"));

    expect(Date.parse(refreshed.lastSeen)).toBeGreaterThan(Date.parse(initial.lastSeen));
    await handle.stop();
  });

  test("update(patch) changes cached name/source for next write", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    const id = uuid("evolve");
    const handle = await reg.startHeartbeat({ id, name: "boot-name", pid: 1, source: "cwd-slug" });

    handle.update({ name: "ai-title-name", source: "jsonl-title" });
    await handle.flush();

    const content = JSON.parse(await readFile(join(baseDir, "status", `${id}.json`), "utf-8"));
    expect(content.name).toBe("ai-title-name");
    expect(content.source).toBe("jsonl-title");

    await handle.stop();
  });

  test("listActivePeers returns peers within ONLINE_THRESHOLD_MS (sorted by name)", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    const a = await reg.startHeartbeat({ id: uuid("alice"), name: "alice", pid: 1 });
    const b = await reg.startHeartbeat({ id: uuid("bob"), name: "bob", pid: 2 });

    const list = await reg.listActivePeers();
    expect(list.map((p) => p.name).sort()).toEqual(["alice", "bob"]);
    expect(list.every((p) => p.ageMs >= 0)).toBe(true);
    expect(list.every((p) => typeof p.id === "string" && p.id.length > 0)).toBe(true);

    await a.stop();
    await b.stop();
  });

  test("two peers with same name show up as distinct peers (different ids)", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    const a = await reg.startHeartbeat({ id: uuid("twin-a"), name: "twin", pid: 1 });
    const b = await reg.startHeartbeat({ id: uuid("twin-b"), name: "twin", pid: 2 });

    const list = await reg.listActivePeers();
    expect(list.length).toBe(2);
    expect(list[0]?.name).toBe("twin");
    expect(list[1]?.name).toBe("twin");
    expect(list[0]?.id).not.toBe(list[1]?.id);

    await a.stop();
    await b.stop();
  });

  test("listActivePeers excludes stale-but-not-purged peers", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    await reg.startHeartbeat({ id: uuid("alice"), name: "alice", pid: 1 });

    fakeNow += ONLINE_THRESHOLD_MS + 1000;

    const list = await reg.listActivePeers();
    expect(list.length).toBe(0);
  });

  test("listActivePeers returns empty when status dir does not exist", async () => {
    const reg = createPeerRegistry({ baseDir: "/non/existent/path", intervalMs: 60_000, now });
    expect(await reg.listActivePeers()).toEqual([]);
  });

  test("malformed heartbeat file is skipped silently", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    await reg.startHeartbeat({ id: uuid("valid"), name: "valid", pid: 1 });

    const dir = join(baseDir, "status");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "broken.json"), "{ not json");

    const list = await reg.listActivePeers();
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe("valid");
  });

  test("startHeartbeat for same id overwrites old file", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    const id = uuid("mantis");
    await reg.startHeartbeat({ id, name: "mantis", pid: 1 });

    fakeNow += 1000;
    const second = await reg.startHeartbeat({ id, name: "mantis", pid: 2 });

    const content = JSON.parse(await readFile(join(baseDir, "status", `${id}.json`), "utf-8"));
    expect(content.pid).toBe(2);

    await second.stop();
  });

  test("heartbeat filename = <id>.json (peerId, not name)", async () => {
    const reg = createPeerRegistry({ baseDir, intervalMs: 60_000, now });
    const id = uuid("with-dashes");
    const handle = await reg.startHeartbeat({ id, name: "with-dashes", pid: 1 });

    expect((await stat(join(baseDir, "status", `${id}.json`))).isFile()).toBe(true);

    await handle.stop();
  });
});

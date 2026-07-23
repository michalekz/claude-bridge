import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

async function importRpc() {
  return await import("../src/rpc.ts");
}

describe("daemon rpc", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "cbd-rpc-"));
    homeHolder.current = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it("ensureRpcDirs is idempotent", async () => {
    const { ensureRpcDirs } = await importRpc();
    await ensureRpcDirs();
    await expect(ensureRpcDirs()).resolves.toBeUndefined();
  });

  it("reads a well-formed request and rejects a malformed one", async () => {
    const { ensureRpcDirs, listPendingRequests, readRequest } = await importRpc();
    const { requestPath, atomicWriteJson } = await import("@claude-bridge/shared");
    await ensureRpcDirs();
    await atomicWriteJson(requestPath("req-good"), {
      schemaVersion: 1,
      id: "req-good",
      ts: "2026-07-23T11:00:00.000Z",
      tool: "peer_stop",
      args: { peer: "x" },
      requestedBy: { sessionId: "s", name: "n" },
    });
    await atomicWriteJson(requestPath("req-bad"), {
      // missing id + tool
      schemaVersion: 1,
      args: {},
    });
    const pending = await listPendingRequests();
    expect(pending).toContain("req-good.json");
    expect(pending).toContain("req-bad.json");
    const good = await readRequest("req-good.json");
    expect(good?.id).toBe("req-good");
    expect(good?.tool).toBe("peer_stop");
    const bad = await readRequest("req-bad.json");
    expect(bad).toBeNull();
  });

  it("markRequestDone moves the file into done/", async () => {
    const { ensureRpcDirs, listPendingRequests, markRequestDone } = await importRpc();
    const { requestPath, requestDonePath, atomicWriteJson } = await import("@claude-bridge/shared");
    await ensureRpcDirs();
    await atomicWriteJson(requestPath("req-mv"), {
      schemaVersion: 1,
      id: "req-mv",
      ts: "t",
      tool: "peer_stop",
      args: {},
      requestedBy: { sessionId: "s", name: "n" },
    });
    await markRequestDone("req-mv");
    const pending = await listPendingRequests();
    expect(pending).not.toContain("req-mv.json");
    const moved = await readFile(requestDonePath("req-mv"), "utf-8");
    expect(JSON.parse(moved)).toMatchObject({ id: "req-mv" });
  });

  it("writeResult stores a result envelope", async () => {
    const { ensureRpcDirs, writeResult, okResult, errResult } = await importRpc();
    const { resultPath } = await import("@claude-bridge/shared");
    await ensureRpcDirs();
    await writeResult(okResult("req-ok", "control_status", { peerCount: 0 }));
    await writeResult(errResult("req-err", "peer_stop", "peer_not_found", "no such peer"));
    const okRaw = JSON.parse(await readFile(resultPath("req-ok"), "utf-8"));
    expect(okRaw).toMatchObject({ id: "req-ok", outcome: "ok" });
    const errRaw = JSON.parse(await readFile(resultPath("req-err"), "utf-8"));
    expect(errRaw).toMatchObject({
      id: "req-err",
      outcome: "error",
      error: { code: "peer_not_found" },
    });
  });
});

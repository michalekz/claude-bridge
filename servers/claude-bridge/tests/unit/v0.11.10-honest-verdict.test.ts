import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.10 — the verdict a caller is given must be the verdict that happened.
 *
 * The control plane processes one request at a time, so a caller's wait can
 * expire while its request is still queued. The wire used to answer that with
 * `ok: true, timedOut: true`, and BOTH directions of the resulting lie were
 * measured on 2026-08-08:
 *
 *   - a request answered that way completed successfully 28 seconds later;
 *   - `peer_compact` returned `timedOut: true` while the daemon recorded
 *     `request_completed: ok` after 20.3 s — reported failure, actual success.
 *
 * In both cases the only way to learn what really happened was to read
 * `events.jsonl` by hand. ai-designer's acceptance criterion: the verdict
 * returned to the caller equals the verdict in events.jsonl, in both
 * directions — and when the queue is behind, the caller is told honestly that
 * the answer is not in yet.
 */

let tempHome: string;

async function controlDir(): Promise<string> {
  const dir = join(tempHome, ".claude-bridge", "control");
  await mkdir(join(dir, "requests"), { recursive: true });
  await mkdir(join(dir, "results"), { recursive: true });
  return dir;
}

/** A daemon that looks alive: a lock file and a fresh heartbeat. */
async function pretendDaemonRunning(): Promise<void> {
  const dir = await controlDir();
  await writeFile(
    join(dir, "daemon.lock"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), procStart: null }),
  );
  const hb = join(dir, "heartbeat");
  await writeFile(hb, "");
  const now = new Date();
  await utimes(hb, now, now);
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "cb-verdict-"));
  homeHolder.current = tempHome;
  vi.resetModules();
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]?.text ?? "{}");
}

describe("a wait that expires does not invent a verdict", () => {
  it("THE REGRESSION: no result yet means `pending`, not a reported outcome", async () => {
    await pretendDaemonRunning();
    const { controlConfigTool } = await import("../../src/mcp/control-plane.ts");
    const ctx = { self: { id: "caller-1", name: "caller" } };
    // Nothing will ever write a result: the daemon here is a lock file.
    // biome-ignore lint/suspicious/noExplicitAny: minimal ServerContext for this call
    const out = parse(await controlConfigTool(ctx as any, { wait: true, timeoutMs: 300 }));

    expect(out["outcome"]).toBe("pending");
    expect(out["requestId"]).toBeTruthy();
    // The two things a caller must be told, because getting either wrong is
    // how the operation gets run twice or reported as failed.
    expect(String(out["note"])).toMatch(/not cancelled/i);
    expect(String(out["note"])).toMatch(/control_result/);
    expect(String(out["note"])).toMatch(/do not re-submit/i);
  });

  it("a verdict that IS in is passed through unchanged and marked settled", async () => {
    await pretendDaemonRunning();
    const dir = await controlDir();
    const { controlConfigTool } = await import("../../src/mcp/control-plane.ts");
    const ctx = { self: { id: "caller-2", name: "caller" } };

    // Answer whatever request appears, the way the daemon would.
    const answer = setInterval(async () => {
      const { readdir, writeFile: wf } = await import("node:fs/promises");
      for (const f of await readdir(join(dir, "requests")).catch(() => [])) {
        const id = f.replace(/\.json$/, "");
        await wf(
          join(dir, "results", `${id}.json`),
          JSON.stringify({ schemaVersion: 1, id, tool: "control_config", outcome: "ok" }),
        ).catch(() => undefined);
      }
    }, 40);

    // biome-ignore lint/suspicious/noExplicitAny: minimal ServerContext for this call
    const out = parse(await controlConfigTool(ctx as any, { wait: true, timeoutMs: 3000 }));
    clearInterval(answer);

    expect(out["outcome"]).toBe("settled");
    // Verbatim, not summarised: the caller's verdict IS the daemon's verdict.
    expect((out["result"] as { outcome: string }).outcome).toBe("ok");
  });
});

describe("control_result — the missing half of the protocol", () => {
  it("returns the daemon's verdict exactly as recorded", async () => {
    const dir = await controlDir();
    await writeFile(
      join(dir, "results", "req-42.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "req-42",
        tool: "peer_compact",
        outcome: "ok",
        data: { compacted: true },
      }),
    );
    const { controlResultTool } = await import("../../src/mcp/control-plane.ts");
    const out = parse(await controlResultTool({ requestId: "req-42" }));
    expect(out["outcome"]).toBe("settled");
    expect((out["result"] as { data: { compacted: boolean } }).data.compacted).toBe(true);
  });

  it("a request still on the queue reads `pending`, and says not to re-submit", async () => {
    const dir = await controlDir();
    await writeFile(join(dir, "requests", "req-77.json"), JSON.stringify({ id: "req-77" }));
    const { controlResultTool } = await import("../../src/mcp/control-plane.ts");
    const out = parse(await controlResultTool({ requestId: "req-77" }));
    expect(out["outcome"]).toBe("pending");
    expect(String(out["note"])).toMatch(/do not re-submit/i);
  });

  it("a queued request with NO daemon running says so — that is the useful part", async () => {
    // Otherwise "pending" reads as "be patient" when in fact nothing at all is
    // going to process it.
    const dir = await controlDir();
    await writeFile(join(dir, "requests", "req-88.json"), JSON.stringify({ id: "req-88" }));
    const { controlResultTool } = await import("../../src/mcp/control-plane.ts");
    const out = parse(await controlResultTool({ requestId: "req-88" }));
    expect(out["daemonRunning"]).toBe(false);
    expect(String(out["note"])).toMatch(/not running/i);
  });

  it("no verdict and no request is `unknown` — not a failure of the operation", async () => {
    // Absence of evidence about an operation is not evidence it failed, and
    // this tool must not be the place that quietly decides otherwise.
    await controlDir();
    const { controlResultTool } = await import("../../src/mcp/control-plane.ts");
    const out = parse(await controlResultTool({ requestId: "never-existed" }));
    expect(out["outcome"]).toBe("unknown");
    expect(String(out["note"])).toMatch(/events\.jsonl/);
  });
});

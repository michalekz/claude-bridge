import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * `claude-bridge-daemon send` — the supported injection path for a process
 * that is not a peer (Teams relay, cron, anything outside the fleet).
 *
 * The alternative it replaces is writing `inbox/<peer>/pending/<id>.json`
 * directly. That works, which is the problem: the envelope schema is
 * `.passthrough()`, so a writer that drifts from the format does not fail —
 * it writes a subtly wrong file that the watcher happily delivers.
 */

const importSend = () => import("../src/send.ts");

async function heartbeat(
  home: string,
  peer: { id: string; name: string; displayName?: string },
  lastSeen = new Date().toISOString(),
) {
  const dir = join(home, ".claude-bridge", "status");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${peer.id}.json`),
    JSON.stringify({ ...peer, pid: 1234, lastSeen }),
    "utf-8",
  );
}

async function pendingFor(home: string, peerId: string) {
  const dir = join(home, ".claude-bridge", "inbox", peerId, "pending");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files.sort()) {
    out.push(JSON.parse(await readFile(join(dir, f), "utf-8")));
  }
  return out;
}

describe("send: delivering a message from outside the fleet", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cb-send-"));
    homeHolder.current = home;
    process.env["HOME"] = home;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("delivers to a peer addressed by id, and says so in JSON", async () => {
    const { runSend, EXIT_OK } = await importSend();
    await heartbeat(home, { id: "11111111-2222-3333-4444-555555555555", name: "plt-target" });

    const res = await runSend([
      "--to",
      "11111111-2222-3333-4444-555555555555",
      "--from-label",
      "teams:uzaverka",
      "--text",
      "closing time",
    ]);

    expect(res.code).toBe(EXIT_OK);
    const out = JSON.parse(res.stdout ?? "{}");
    expect(out.ok).toBe(true);
    // The caller needs the id back to keep a cursor and avoid double delivery.
    expect(out.msgId).toMatch(/^[0-9a-z]+-[0-9a-f]{8}$/);

    const [msg] = await pendingFor(home, "11111111-2222-3333-4444-555555555555");
    expect(msg.content).toBe("closing time");
    expect(msg.kind).toBe("ask");
    expect(msg.from).toBe("external:teams:uzaverka");
  });

  it("resolves a display name through the registry", async () => {
    const { runSend, EXIT_OK } = await importSend();
    await heartbeat(home, { id: "aaaa1111-2222-3333-4444-555555555555", name: "plt-named" });

    const res = await runSend(["--to", "plt-named", "--from-label", "teams:x", "--text", "hi"]);

    expect(res.code).toBe(EXIT_OK);
    // Addressed by name, delivered to the id — the inbox directory is keyed on
    // the id, so a name written into `to` would create a directory nobody drains.
    expect(JSON.parse(res.stdout ?? "{}").to.id).toBe("aaaa1111-2222-3333-4444-555555555555");
  });

  it("message ids sort chronologically, because inbox order is filename order", async () => {
    const { runSend } = await importSend();
    await heartbeat(home, { id: "bbbb1111-2222-3333-4444-555555555555", name: "plt-order" });

    const base = Date.parse("2026-08-04T12:00:00.000Z");
    for (const [i, text] of ["first", "second", "third"].entries()) {
      await runSend(
        ["--to", "plt-order", "--from-label", "teams:x", "--text", text],
        base + i * 1000,
      );
    }

    // Read back in filename order — what the recipient's inbox listing does.
    const msgs = await pendingFor(home, "bbbb1111-2222-3333-4444-555555555555");
    expect(msgs.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("EXIT 2: an unknown recipient", async () => {
    const { runSend, EXIT_PEER } = await importSend();
    await heartbeat(home, { id: "cccc1111-2222-3333-4444-555555555555", name: "plt-real" });

    const res = await runSend(["--to", "plt-ghost", "--from-label", "teams:x", "--text", "hi"]);

    expect(res.code).toBe(EXIT_PEER);
    expect(res.stdout).toBeUndefined();
  });

  it("EXIT 2: a name shared by two peers is refused, not guessed", async () => {
    const { runSend, EXIT_PEER } = await importSend();
    await heartbeat(home, { id: "dddd1111-2222-3333-4444-555555555555", name: "plt-twin" });
    await heartbeat(home, { id: "eeee1111-2222-3333-4444-555555555555", name: "plt-twin" });

    const res = await runSend(["--to", "plt-twin", "--from-label", "teams:x", "--text", "hi"]);

    // Picking one would deliver somebody's mail to the wrong peer, silently.
    expect(res.code).toBe(EXIT_PEER);
    expect(res.stderr).toContain("matches 2 peers");
  });

  it("EXIT 3: bad invocations, each distinct from a delivery failure", async () => {
    const { runSend, EXIT_USAGE } = await importSend();
    await heartbeat(home, { id: "ffff1111-2222-3333-4444-555555555555", name: "plt-usage" });

    const cases: Array<[string, string[]]> = [
      ["no --to", ["--from-label", "teams:x", "--text", "hi"]],
      ["no --from-label", ["--to", "plt-usage", "--text", "hi"]],
      ["empty body", ["--to", "plt-usage", "--from-label", "teams:x", "--text", "   "]],
      [
        "unknown kind",
        ["--to", "plt-usage", "--from-label", "teams:x", "--text", "hi", "--kind", "shout"],
      ],
      [
        "unknown flag",
        ["--to", "plt-usage", "--from-label", "teams:x", "--text", "hi", "--urgent"],
      ],
      // `--to --kind ask` must not address a peer literally called "--kind".
      ["flag as value", ["--to", "--kind", "ask", "--from-label", "teams:x"]],
    ];

    for (const [label, argv] of cases) {
      const res = await runSend(argv);
      expect(res.code, label).toBe(EXIT_USAGE);
    }
  });

  it("the injection is audited, and the body is not written to the log", async () => {
    const { runSend } = await importSend();
    await heartbeat(home, { id: "9999aaaa-2222-3333-4444-555555555555", name: "plt-audit" });
    const SECRET = "confidential thread contents";

    await runSend(["--to", "plt-audit", "--from-label", "teams:x", "--text", SECRET]);

    const raw = await readFile(join(home, ".claude-bridge", "control", "events.jsonl"), "utf-8");
    expect(raw).toContain("external_message_sent");
    // The relay carries whatever a Teams thread said; an audit trail is not the
    // place for it.
    expect(raw).not.toContain(SECRET);
  });
});

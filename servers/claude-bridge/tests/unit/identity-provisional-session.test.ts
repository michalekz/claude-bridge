import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePeerIdentity, resumedSessionIdFromParent } from "../../src/identity.ts";

/**
 * The phantom peer id (fix, 2026-08-04).
 *
 * On a resumed session Claude Code writes a provisional identity into
 * `~/.claude/sessions/<ppid>.json` — a fresh session id and an
 * auto-generated name — and swaps the id for the resumed one moments later.
 * A server booting inside that window took the provisional id as its own.
 *
 * The damage is not cosmetic. Everything keys off that id: the heartbeat in
 * `status/`, the inbox directory, the row other peers see in `peer_list`.
 * Mail sent to it is written to a directory nobody drains, and it looks
 * delivered on disk. Observed live: peer came up as `99e371a7` while Claude
 * Code held `fb749bc6`.
 *
 * `--resume` is fixed at launch and cannot drift, so it decides the id.
 */

const RESUMED = "fb749bc6-c2f6-404c-8af4-422dfc2eb42e";
const PROVISIONAL = "99e371a7-5ef5-47df-8697-35126329c370";
const PPID = 4242;

describe("provisional session.json must not become the peer id", () => {
  let home: string;
  let procRoot: string;

  /** Write the sessions/<ppid>.json Claude Code maintains. */
  async function sessionJson(sessionId: string, name: string, cwd = "/opt/claude-bridge") {
    await mkdir(join(home, ".claude", "sessions"), { recursive: true });
    await writeFile(
      join(home, ".claude", "sessions", `${PPID}.json`),
      JSON.stringify({ pid: PPID, sessionId, cwd, name }),
    );
  }

  /** Fake /proc/<ppid>/cmdline, NUL-separated exactly like the real thing. */
  async function parentCmdline(...args: string[]) {
    await mkdir(join(procRoot, String(PPID)), { recursive: true });
    await writeFile(join(procRoot, String(PPID), "cmdline"), `${args.join("\0")}\0`);
  }

  const resolve = () => resolvePeerIdentity({ home, ppid: PPID, procRoot, env: {} });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cb-ident-home-"));
    procRoot = await mkdtemp(join(tmpdir(), "cb-ident-proc-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(procRoot, { recursive: true, force: true });
  });

  it("THE REGRESSION: takes the resumed id, not the provisional one", async () => {
    await sessionJson(PROVISIONAL, "claude-bridge-8d");
    await parentCmdline(
      "claude",
      "--channels",
      "plugin:claude-bridge-dev@claude-bridge",
      "--resume",
      `/home/u/.claude/projects/-opt-claude-bridge/${RESUMED}.jsonl`,
    );

    const identity = await resolve();

    expect(identity.id).toBe(RESUMED);
    expect(identity.id).not.toBe(PROVISIONAL);
  });

  it("once session.json settles, both sources agree and nothing changes", async () => {
    // Steady state — verified true for all 21 peers on the live machine.
    await sessionJson(RESUMED, "plt-bridge-dev");
    await parentCmdline("claude", "--resume", `/p/${RESUMED}.jsonl`);

    const identity = await resolve();

    expect(identity.id).toBe(RESUMED);
    expect(identity.name).toBe("plt-bridge-dev");
  });

  it("a session that was NOT resumed still takes its id from session.json", async () => {
    // No --resume: a genuinely new session. session.json is the only source
    // and must keep working exactly as before.
    await sessionJson(PROVISIONAL, "fresh-session");
    await parentCmdline("claude", "--channels", "plugin:claude-bridge-dev@claude-bridge");

    const identity = await resolve();

    expect(identity.id).toBe(PROVISIONAL);
  });

  it("falls back to session.json when /proc is unavailable", async () => {
    // macOS, Windows, a container without /proc — the cross-check simply
    // isn't available and must not break identity resolution.
    await sessionJson(RESUMED, "plt-bridge-dev");
    // no cmdline file written at all

    const identity = await resolve();

    expect(identity.id).toBe(RESUMED);
  });

  it("reads the display name from the RESUMED transcript, not the phantom's", async () => {
    // The name cascade builds a JSONL path from the session id. Using the
    // provisional id there would look for a transcript that does not exist
    // and drop to the auto-generated name.
    await sessionJson(PROVISIONAL, "claude-bridge-8d");
    await parentCmdline("claude", "--resume", `/p/${RESUMED}.jsonl`);
    const projectDir = join(home, ".claude", "projects", "-opt-claude-bridge");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, `${RESUMED}.jsonl`),
      `${JSON.stringify({ type: "custom-title", customTitle: "plt-bridge-dev" })}\n`,
    );

    const identity = await resolve();

    expect(identity.id).toBe(RESUMED);
    expect(identity.name).toBe("plt-bridge-dev");
    expect(identity.source).toBe("jsonl-title");
  });

  describe("resumedSessionIdFromParent", () => {
    it("pulls the uuid out of the --resume path", async () => {
      await parentCmdline("claude", "--resume", `/a/b/${RESUMED}.jsonl`, "--model", "opus");
      expect(await resumedSessionIdFromParent(PPID, procRoot)).toBe(RESUMED);
    });

    it("returns null without --resume, and for a missing process", async () => {
      await parentCmdline("claude", "--channels", "plugin:x@y");
      expect(await resumedSessionIdFromParent(PPID, procRoot)).toBeNull();
      expect(await resumedSessionIdFromParent(999999, procRoot)).toBeNull();
    });

    it("ignores a --resume that carries no uuid", async () => {
      await parentCmdline("claude", "--resume", "/some/path/not-a-uuid.jsonl");
      expect(await resumedSessionIdFromParent(PPID, procRoot)).toBeNull();
    });
  });
});

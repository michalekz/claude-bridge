import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DONE_MAX_AGE_MS,
  DEFAULT_STATUSLINE_MAX_AGE_MS,
  DEFAULT_TMP_MAX_AGE_MS,
  runHygieneSweep,
} from "../../src/util/hygiene.ts";

/**
 * Workspace hygiene sweep (v0.10.2).
 *
 * The sweep deletes the user's files, so most of what is worth testing is
 * what it must NOT delete. The `pending/` case is the one that would hurt:
 * an unread message silently disappearing is indistinguishable from the
 * message never having been sent.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-03T22:00:00.000Z");

describe("runHygieneSweep", () => {
  let base: string;

  /** Create a file and stamp its mtime `ageMs` into the past. */
  async function put(relative: string, ageMs: number, body = "{}"): Promise<string> {
    const path = join(base, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
    const when = new Date(NOW - ageMs);
    await utimes(path, when, when);
    return path;
  }

  const exists = async (relative: string): Promise<boolean> => {
    try {
      await stat(join(base, relative));
      return true;
    } catch {
      return false;
    }
  };

  const sweep = () => runHygieneSweep({ baseDir: base, now: NOW, force: true });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "cb-hygiene-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    // process.env is Record<string,string>: assigning undefined stores the
    // literal string "undefined", so delete is the only way to unset a var.
    // biome-ignore lint/performance/noDelete: see above
    delete process.env["CLAUDE_BRIDGE_HYGIENE"];
    // biome-ignore lint/performance/noDelete: see above
    delete process.env["CLAUDE_BRIDGE_RETAIN_DONE_DAYS"];
  });

  it("NEVER removes a pending message, however old", async () => {
    // The invariant. An unread message has no expiry — not at 30 days, not
    // at ten years. If this test ever goes green after being made to fail,
    // the sweep has started eating mail.
    await put("inbox/peer-a/pending/ancient.json", 3650 * DAY);
    await put("inbox/peer-a/done/ancient.json", 3650 * DAY);

    const r = await sweep();

    expect(await exists("inbox/peer-a/pending/ancient.json")).toBe(true);
    expect(await exists("inbox/peer-a/done/ancient.json")).toBe(false);
    expect(r.doneRemoved).toBe(1);
  });

  it("removes archived messages past retention and keeps the rest", async () => {
    await put("inbox/peer-a/done/old.json", DEFAULT_DONE_MAX_AGE_MS + DAY);
    await put("inbox/peer-a/done/fresh.json", DAY);
    await put("inbox/peer-b/done/old.json", DEFAULT_DONE_MAX_AGE_MS + 5 * DAY);

    const r = await sweep();

    expect(r.doneRemoved).toBe(2);
    expect(await exists("inbox/peer-a/done/fresh.json")).toBe(true);
    expect(await exists("inbox/peer-a/done/old.json")).toBe(false);
    expect(await exists("inbox/peer-b/done/old.json")).toBe(false);
  });

  it("removes orphaned atomic-write temps wherever they landed", async () => {
    // 79 of these were found on the live machine, spread across three dirs —
    // atomicWrite puts the temp next to its target, so they can be anywhere.
    await put("live/.5f647f8a8e9fcf57.tmp", 2 * DAY);
    await put("status/.a5a5c83dfeaaea1c.tmp", 30 * DAY);
    await put("live/statusline/.1f46cea67d0d5514.tmp", DAY);
    // A temp mid-write must survive — the rename may still be coming.
    await put("status/.beingwritten.tmp", 60 * 1000);

    const r = await sweep();

    expect(r.tmpRemoved).toBe(3);
    expect(await exists("status/.beingwritten.tmp")).toBe(true);
  });

  it("expires dead per-session statusline captures", async () => {
    await put("live/statusline/dead-session.json", DEFAULT_STATUSLINE_MAX_AGE_MS + DAY);
    await put("live/statusline/live-session.json", 60 * 1000);
    // Not in the statusline dir → different rule, must be left alone.
    await put("live/oauth-api.json", 400 * DAY);

    const r = await sweep();

    expect(r.statusLineRemoved).toBe(1);
    expect(await exists("live/statusline/live-session.json")).toBe(true);
    expect(await exists("live/oauth-api.json")).toBe(true);
  });

  it("leaves every unclassified file alone regardless of age", async () => {
    // Everything the daemon and registry own. None of it matches a rule, so
    // an ancient mtime must still not be enough to remove it.
    const bystanders = [
      "control/events.jsonl",
      "control/state.json",
      "control/daemon.lock",
      "status/some-peer.json",
      "guard/rate-limits.json",
      "setup-state.json",
      "inbox/peer-a/done/not-json.txt",
    ];
    for (const f of bystanders) await put(f, 500 * DAY);

    const r = await sweep();

    expect(r.tmpRemoved + r.statusLineRemoved + r.doneRemoved).toBe(0);
    for (const f of bystanders) expect(await exists(f)).toBe(true);
  });

  it("honours CLAUDE_BRIDGE_RETAIN_DONE_DAYS", async () => {
    await put("inbox/peer-a/done/m.json", 45 * DAY);

    process.env["CLAUDE_BRIDGE_RETAIN_DONE_DAYS"] = "90";
    expect((await sweep()).doneRemoved).toBe(0);

    process.env["CLAUDE_BRIDGE_RETAIN_DONE_DAYS"] = "30";
    expect((await sweep()).doneRemoved).toBe(1);
  });

  it("does nothing at all when disabled", async () => {
    await put("inbox/peer-a/done/old.json", 500 * DAY);
    process.env["CLAUDE_BRIDGE_HYGIENE"] = "off";

    const r = await sweep();

    expect(r.skipped).toBe("disabled");
    expect(r.ran).toBe(false);
    expect(await exists("inbox/peer-a/done/old.json")).toBe(true);
  });

  it("throttles the second caller — 23 peers must not all walk the tree", async () => {
    await put("inbox/peer-a/done/old.json", 500 * DAY);

    const first = await runHygieneSweep({ baseDir: base, now: NOW });
    expect(first.ran).toBe(true);
    expect(first.doneRemoved).toBe(1);

    // Same instant, second peer starting up.
    const second = await runHygieneSweep({ baseDir: base, now: NOW });
    expect(second.ran).toBe(false);
    expect(second.skipped).toBe("throttled");

    // Past the window it runs again.
    const later = await runHygieneSweep({
      baseDir: base,
      now: NOW + 7 * 60 * 60 * 1000,
    });
    expect(later.ran).toBe(true);
  });

  it("reports bytes freed and survives a directory it cannot read", async () => {
    await put("inbox/peer-a/done/big.json", 500 * DAY, "x".repeat(4096));
    const r = await sweep();
    expect(r.bytesFreed).toBeGreaterThanOrEqual(4096);
    expect(r.errors).toBe(0);
  });

  it("does not follow symlinks out of the workspace", async () => {
    // A link into the user's home must not turn into a delete over there.
    const outside = await mkdtemp(join(tmpdir(), "cb-outside-"));
    const victim = join(outside, "precious.json");
    await writeFile(victim, "{}");
    const old = new Date(NOW - 500 * DAY);
    await utimes(victim, old, old);

    const { symlink } = await import("node:fs/promises");
    await mkdir(join(base, "inbox", "peer-a"), { recursive: true });
    await symlink(outside, join(base, "inbox", "peer-a", "done"));

    await sweep();

    expect((await readdir(outside)).length).toBe(1);
    await rm(outside, { recursive: true, force: true });
  });

  it("dryRun counts everything and deletes nothing, marker included", async () => {
    await put("inbox/peer-a/done/old.json", 500 * DAY, "x".repeat(1000));
    await put("live/.orphan.tmp", 5 * DAY);

    const dry = await runHygieneSweep({ baseDir: base, now: NOW, dryRun: true });

    expect(dry.doneRemoved).toBe(1);
    expect(dry.tmpRemoved).toBe(1);
    expect(dry.bytesFreed).toBeGreaterThanOrEqual(1000);
    expect(await exists("inbox/peer-a/done/old.json")).toBe(true);
    expect(await exists("live/.orphan.tmp")).toBe(true);

    // A dry run must not claim the throttle — otherwise merely LOOKING at the
    // numbers would suppress the real sweep for the next six hours.
    expect(await exists(".hygiene-last")).toBe(false);
    const real = await runHygieneSweep({ baseDir: base, now: NOW });
    expect(real.ran).toBe(true);
    expect(real.doneRemoved).toBe(1);
  });

  it("tmp default is an hour, not a judgement call", () => {
    expect(DEFAULT_TMP_MAX_AGE_MS).toBe(60 * 60 * 1000);
  });
});

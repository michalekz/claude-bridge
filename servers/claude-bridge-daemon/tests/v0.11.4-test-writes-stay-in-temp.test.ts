import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, atomicWriteJson } from "@claude-bridge/shared";
import { describe, expect, it } from "vitest";

/**
 * A test suite has no business writing outside a temp directory.
 *
 * 2026-08-07, 06:37–06:44: a new test file went in without the
 * `vi.mock("node:os")` homedir isolation that the other 34 files carry.
 * `handleControlConfig` persists through `applyStateChange` → `saveState` →
 * `stateFilePath()`, which resolves under `homedir()` — so five runs of the
 * suite overwrote the live control-plane registry, replacing 23 real peers with
 * a fixture holding one imaginary one. Nothing failed. Every test stayed green.
 * The fleet kept running, because processes and tmux sessions do not depend on
 * the registry, and the loss surfaced only because someone happened to read a
 * peer count afterwards.
 *
 * The per-file mock is the right thing to write, and it had been written
 * correctly 34 times. That is precisely why it could not be the safeguard: a
 * convention held in memory fails the first time somebody is quick, and this
 * failure was silent and landed on the operator's machine.
 *
 * So the rule moved into `atomicWrite`, where forgetting is not an option, and
 * these cases exist because a guard that has never been seen to fire is a guard
 * nobody should trust.
 */

describe("under a test runner, writes may not leave the temp root", () => {
  it("VITEST is actually set — the guard is not silently disabled", () => {
    // If this ever goes false the whole file passes vacuously, which is the one
    // way a safety test can be worse than none.
    expect(process.env["VITEST"]).toBeTruthy();
  });

  it("THE INCIDENT: a write into the real control plane is refused", async () => {
    // Verbatim the path the broken test file reached: ~/.claude-bridge/control/state.json
    const real = join(homedir(), ".claude-bridge", "control", "state.json");
    await expect(atomicWriteJson(real, { peers: {} })).rejects.toThrow(/refused/);
  });

  it("the refusal names the path and the likely cause", async () => {
    // An operator seeing this in CI has to know what to do without reading the
    // source — the fix is almost always a missing homedir mock.
    const real = join(homedir(), ".claude-bridge", "anything.json");
    await expect(atomicWriteJson(real, {})).rejects.toThrow(/homedir mock/);
  });

  it("a normal temp write still works — the guard is not a blanket ban", async () => {
    const path = join(tmpdir(), `cbd-guard-${process.hrtime.bigint()}.json`);
    await atomicWriteJson(path, { ok: true });
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({ ok: true });
  });

  it("it guards raw atomicWrite too, not only the JSON wrapper", async () => {
    // `saveState` goes through the JSON helper, but inbox envelopes and event
    // lines do not. Guarding one entry point would leave the others open.
    await expect(atomicWrite(join(homedir(), "cbd-should-not-exist"), "x")).rejects.toThrow(
      /refused/,
    );
  });

  it("a path that merely mentions the temp dir is not enough", async () => {
    // `/tmp-not-really/...` must not pass a naive prefix check.
    const sneaky = `${tmpdir()}-elsewhere/file.json`;
    await expect(atomicWriteJson(sneaky, {})).rejects.toThrow(/refused/);
  });
});

import { describe, expect, it } from "vitest";

/**
 * v0.11.14 — a list written in prose goes stale in silence.
 *
 * `config --help` advertised "label, windowIndex, model, accountProfile, team".
 * `team` was removed from the whitelist in v0.11.3 (moving a peer between teams
 * is lifecycle work, not a declaration) and `role` was added in v0.11.13. The
 * help said neither: it offered a key that would be rejected and hid one that
 * works.
 *
 * That is the fourth instance of the same defect in two days — after
 * `peer-compact.ts`'s "the only send-keys path", `team_reconcile`'s "four kinds
 * of drift" (twice: header comment and tool description). The fix is not to
 * correct the sentence. It is to stop writing the list twice.
 */
describe("the help text cannot disagree with the whitelist", () => {
  it("lists exactly the settable keys, in the whitelist's own order", async () => {
    const { CONFIG_HELP } = await import("../src/config-cli.ts");
    const { PEER_SETTABLE } = await import("../src/handlers/control-config.ts");
    const line = CONFIG_HELP.split("\n").find((l) => l.startsWith("Settable keys:"));
    expect(line).toBe(`Settable keys: ${PEER_SETTABLE.join(", ")}`);
  });

  it("does NOT offer `team`, which the tool refuses", async () => {
    // Offering a key that will be rejected is worse than not documenting it:
    // the operator writes the command, gets an error, and doubts the tool.
    const { PEER_SETTABLE } = await import("../src/handlers/control-config.ts");
    expect(PEER_SETTABLE as readonly string[]).not.toContain("team");
    const { CONFIG_HELP } = await import("../src/config-cli.ts");
    const line = CONFIG_HELP.split("\n").find((l) => l.startsWith("Settable keys:")) ?? "";
    expect(line).not.toContain("team");
  });
});

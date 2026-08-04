import { describe, expect, test } from "vitest";
import type { ZodObject, ZodRawShape } from "zod";
import * as cp from "../../src/mcp/control-plane.ts";
import { TOOLS } from "../../src/mcp/tools.ts";

/**
 * Every argument a tool ADVERTISES must be one its validator ACCEPTS.
 *
 * `team_adopt` shipped `hostSession` in its JSON schema while the Zod schema
 * behind it rejected the key as unrecognised — the tool documented an argument
 * it refused. I caused it by running a string replacement without checking
 * that the pattern matched: it silently changed nothing, and I reported the
 * feature as delivered (plt-designer, v0.10.7 re-pilot, finding F).
 *
 * The JSON schema and the Zod schema are written by hand in two files, so
 * drift is a question of when. This makes it loud. Scoped to the daemon-backed
 * tools because that is where both halves are exported and comparable; the
 * same failure elsewhere would need the same treatment.
 */

const PAIRS: Array<[string, ZodObject<ZodRawShape>]> = [
  ["control_status", cp.ControlStatusArgs],
  ["peer_stop", cp.PeerStopArgs],
  ["peer_spawn", cp.PeerSpawnArgs],
  ["peer_restart", cp.PeerRestartArgs],
  ["peer_compact", cp.PeerCompactArgs],
  ["team_layout", cp.TeamLayoutArgs],
  ["team_status", cp.TeamStatusArgs],
  ["team_stop", cp.TeamStopArgs],
  ["team_adopt", cp.TeamAdoptArgs],
  ["team_release", cp.TeamReleaseArgs],
  ["team_reconcile", cp.TeamReconcileArgs],
  ["team_restart", cp.TeamRestartArgs],
];

describe("advertised arguments are accepted arguments", () => {
  for (const [name, schema] of PAIRS) {
    test(`${name}`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool, `tool ${name} is missing from TOOLS`).toBeDefined();
      const advertised = Object.keys(
        (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      const accepted = new Set(Object.keys(schema.shape));
      // Printing the offending names, not a boolean — a membership assertion
      // that only reports true/false is how the last one survived review.
      const refused = advertised.filter((p) => !accepted.has(p));
      expect(refused).toEqual([]);
    });
  }

  test("THE REGRESSION: team_adopt accepts hostSession", () => {
    const res = cp.TeamAdoptArgs.safeParse({ team: "hmh", hostSession: "hmh" });
    expect(res.success).toBe(true);
  });

  test("and still refuses a key nobody documented", () => {
    const res = cp.TeamAdoptArgs.safeParse({ team: "hmh", nonsense: 1 });
    expect(res.success).toBe(false);
  });
});

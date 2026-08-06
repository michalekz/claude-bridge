import { describe, expect, it } from "vitest";
import { windowLabelFor } from "../src/handlers/peer-spawn.ts";

/**
 * The window carries the short name; the record carries the full one.
 *
 * `peer_spawn` passed `displayName` straight through as the tmux window label,
 * so a peer named `mic-tester` got a window called `mic-tester` — the team
 * prefix repeated on every tab, in a session already called `mic`. The owner
 * asked for the short form on 2026-08-05, the day the naming convention was
 * ratified.
 *
 * The first proposal was a blanket strip inside the tmux driver. That is wrong:
 * the driver cannot tell a prefix that came from the convention from a name a
 * caller chose deliberately, so it would shorten both. The team is known at the
 * call site and nowhere below it, which is where the decision belongs.
 */
describe("the window label is the short form of the name", () => {
  it("strips the team prefix", () => {
    expect(windowLabelFor("mic-tester", "mic")).toBe("tester");
    expect(windowLabelFor("plt-integration-dev", "plt")).toBe("integration-dev");
    expect(windowLabelFor("ai-bridge-dev", "ai")).toBe("bridge-dev");
  });

  it("leaves a name alone when it does not carry the prefix", () => {
    // A fleet that does not follow the convention keeps what it asked for.
    expect(windowLabelFor("legacy-box", "mic")).toBe("legacy-box");
    expect(windowLabelFor("tester", "mic")).toBe("tester");
  });

  it("leaves a name alone when there is no team", () => {
    // Direct peer_spawn with no team stated — nothing to strip against.
    expect(windowLabelFor("mic-tester")).toBe("mic-tester");
  });

  it("never strips a name down to nothing", () => {
    // `mic-` in team `mic` would leave an empty label, and tmux would fall back
    // to the command name — which is how twenty-one windows came to be called
    // `claude` during the 2026-08-04 outage.
    expect(windowLabelFor("mic-", "mic")).toBe("mic-");
  });

  it("strips only the first prefix, not every hyphen", () => {
    expect(windowLabelFor("mic-obchod-legal", "mic")).toBe("obchod-legal");
  });
});

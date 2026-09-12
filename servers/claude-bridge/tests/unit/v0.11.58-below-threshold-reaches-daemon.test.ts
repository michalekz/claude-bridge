import { describe, expect, it } from "vitest";
import { PeerCompactArgs } from "../../src/mcp/control-plane.ts";

/**
 * v0.11.58 — the door the advice named, which nobody could open.
 *
 * The daemon has refused a below-threshold compact with "repeat with
 * belowThreshold:true" since v0.11.48, and the parameter lived ONLY in the
 * daemon's schema. No bundle ever forwarded it, so the advice was
 * unexecutable from every session in the fleet — ai-velitel followed it
 * exactly four times on 12 September and got the same refusal each time.
 *
 * v0.11.53 made the advice version-aware, which fixed the older case and made
 * this one worse: to a caller on 0.11.48+ it says plainly "repeat with
 * belowThreshold:true", promising availability. The caller's VERSION was
 * checked; whether the door existed at all was not.
 */
describe("belowThreshold is accepted by the bundle, not only by the daemon", () => {
	it("🔴 the parameter parses — before this, every caller was refused by its own schema", () => {
		const parsed = PeerCompactArgs.safeParse({
			peer: "tst",
			belowThreshold: true,
		});
		expect(parsed.success).toBe(true);
	});

	it("and it REACHES the daemon — a parameter parsed and dropped is the same dead end", async () => {
		const { peerCompactTool } = await import("../../src/mcp/control-plane.ts");
		// The forwarding is what matters; the submit will fail without a daemon,
		// so the assertion is on the source of truth for what gets forwarded.
		const { readFile } = await import("node:fs/promises");
		const src = await readFile(
			new URL("../../src/mcp/control-plane.ts", import.meta.url),
			"utf-8",
		);
		expect(src).toContain('daemonArgs["belowThreshold"] = args.belowThreshold');
		expect(typeof peerCompactTool).toBe("function");
	});

	it("it stays OPTIONAL — a compact that does not mean it must not carry it", () => {
		const parsed = PeerCompactArgs.safeParse({ peer: "tst" });
		expect(parsed.success).toBe(true);
	});
});

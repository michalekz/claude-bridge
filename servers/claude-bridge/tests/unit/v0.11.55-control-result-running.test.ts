import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v0.11.55 — `control_result` could not say "it is running right now".
 *
 * The daemon CLAIMS a request by renaming it out of `requests/` into
 * `requests/done/` BEFORE dispatching, so that a crash between claim and
 * verdict cannot make the handler run twice. For the whole execution — minutes,
 * for a graceful restart that waits out a peer's ack and then its turn — the id
 * was therefore in neither the queue nor the results, and the tool answered
 * `unknown`: "either the id is wrong, or it settled long ago". Both halves
 * false, and the state it actually described (WORKING RIGHT NOW) is the one a
 * waiting caller most needs to tell apart from a typo.
 */

const homeHolder = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: () => homeHolder.current };
});

let home = "";
const ID = "mty00000-abcd";

async function controlDirs(): Promise<string> {
	const control = join(home, ".claude-bridge", "control");
	await mkdir(join(control, "requests", "done"), { recursive: true });
	await mkdir(join(control, "results"), { recursive: true });
	return control;
}

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "cb-055-"));
	homeHolder.current = home;
	vi.resetModules();
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

async function ask(): Promise<Record<string, unknown>> {
	const { controlResultTool } = await import("../../src/mcp/control-plane.ts");
	const res = await controlResultTool({ requestId: ID });
	return JSON.parse(res.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("the four states of a request", () => {
	it("🔴 CLAIMED, no verdict → running, not unknown", async () => {
		const control = await controlDirs();
		await writeFile(join(control, "requests", "done", `${ID}.json`), "{}");
		const out = await ask();
		expect(out["outcome"]).toBe("running");
		expect(out["claimedAt"]).toBeTypeOf("string");
		expect(out["elapsedMs"]).toBeTypeOf("number");
		expect(String(out["note"])).toMatch(
			/do NOT re-submit|no verdict will arrive/i,
		);
	});

	it("still ON the queue → pending", async () => {
		const control = await controlDirs();
		await writeFile(join(control, "requests", `${ID}.json`), "{}");
		const out = await ask();
		expect(out["outcome"]).toBe("pending");
	});

	it("a verdict exists → settled, and it wins over a lingering claim file", async () => {
		const control = await controlDirs();
		await writeFile(join(control, "requests", "done", `${ID}.json`), "{}");
		await writeFile(
			join(control, "results", `${ID}.json`),
			JSON.stringify({ id: ID, outcome: "ok" }),
		);
		const out = await ask();
		expect(out["outcome"]).toBe("settled");
	});

	it("nothing anywhere → unknown, and the note now says all THREE absences", async () => {
		await controlDirs();
		const out = await ask();
		expect(out["outcome"]).toBe("unknown");
		expect(String(out["note"])).toMatch(/no claim/);
	});
});

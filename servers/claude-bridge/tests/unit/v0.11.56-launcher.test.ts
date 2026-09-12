import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);

/**
 * v0.11.56 — the interpreter was a guess, and a failed start left no trace.
 *
 * Ⓞ-B (second occurrence in the fleet, 2026-09-09): `.mcp.json` templated the
 * BUNDLE path and hard-coded `"command": "node"`. The PATH belongs to whatever
 * launched Claude Code, not to the peer, and a launcher started outside nvm has
 * no `node` at all.
 *
 * Ⓞ-C, from the same report and the more expensive half: Claude Code reports a
 * missing token and a missing binary identically as ENOENT, and the bridge left
 * NOTHING behind when it failed to start — while `identity`, a Go binary that
 * needs no interpreter, started and logged. Three hypotheses were disproved
 * before anyone suspected the interpreter.
 *
 * These run the real script, so what they measure is the file that ships.
 */

const LAUNCHER = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"bin",
	"claude-bridge-mcp",
);

let home = "";
let bridgeDir = "";
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "cb-launch-"));
	bridgeDir = join(home, "bridge");
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

/** Run the launcher with a chosen environment; never inherits ours. */
async function run(
	env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await exec(LAUNCHER, [], {
			env: { HOME: home, CLAUDE_BRIDGE_DIR: bridgeDir, ...env },
			timeout: 20_000,
		});
		return { code: 0, stdout, stderr };
	} catch (e) {
		const err = e as { code?: number; stdout?: string; stderr?: string };
		return {
			code: err.code ?? -1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
		};
	}
}

async function launchLog(): Promise<string> {
	return readFile(join(bridgeDir, "logs", "mcp-launch.log"), "utf-8").catch(
		() => "",
	);
}

describe("Ⓞ-B — the interpreter is FOUND, not assumed", () => {
	it("uses a node that is nowhere near the PATH, from the fleet's nvm layout", async () => {
		// A launcher started outside nvm: this is the production failure, reproduced.
		const nvmBin = join(home, ".nvm", "versions", "node", "v24.14.0", "bin");
		await mkdir(nvmBin, { recursive: true });
		const fake = join(nvmBin, "node");
		// A stand-in that proves WHICH interpreter ran, without needing a real one.
		await writeFile(fake, "#!/bin/sh\nprintf 'RAN %s\\n' \"$1\" >&2\nexit 0\n");
		await chmod(fake, 0o755);

		const res = await run({ PATH: "/nonexistent" });
		expect(res.stderr).toMatch(/no node on PATH/);
		expect(res.stderr).toMatch(/RAN .*bundle\.cjs/);
		// And it says so in the log, not only on a stderr nobody keeps.
		expect(await launchLog()).toMatch(/no node on PATH/);
	});

	it("prefers the NEWEST nvm version — lexical order puts v9 above v10", async () => {
		for (const v of ["v9.0.0", "v24.14.0", "v10.0.0"]) {
			const bin = join(home, ".nvm", "versions", "node", v, "bin");
			await mkdir(bin, { recursive: true });
			const p = join(bin, "node");
			await writeFile(p, `#!/bin/sh\nprintf 'VERSION ${v}\\n' >&2\nexit 0\n`);
			await chmod(p, 0o755);
		}
		const res = await run({ PATH: "/nonexistent" });
		expect(res.stderr).toMatch(/VERSION v24\.14\.0/);
	});
});

describe("the launcher survives the environment it exists to diagnose", () => {
	it("🔴 a PATH without /usr/bin: it still reports, instead of dying on `dirname`", async () => {
		// Found by this test, not in production: the first draft called `dirname`
		// and `date` through the PATH, so a broken PATH killed the script before
		// it could say anything — in the exact case Ⓞ-C exists for.
		const res = await run({
			PATH: "/nonexistent",
			CLAUDE_BRIDGE_NODE_PATHS: "/nonexistent/a",
		});
		expect(res.code).toBe(127);
		expect(res.stderr).toMatch(/FAILED TO START/);
		expect(res.stderr).not.toMatch(/dirname: not found/);
		// It reached its own logging, which is the property at stake.
		expect(await launchLog()).toMatch(/FAILED TO START/);
	});
});

describe("Ⓞ-C — a bridge that never ran still leaves a mark", () => {
	it("🔴 no interpreter anywhere: exit 127, a log file, and CLEAN STDOUT", async () => {
		// Every machine these tests can run on HAS a node somewhere, so the search
		// list is pinned to reach the branch at all. That override is a real
		// feature (a host whose layout we did not guess), not test scaffolding.
		const res = await run({
			PATH: "/nonexistent",
			CLAUDE_BRIDGE_NODE_PATHS: "/nonexistent/a:/nonexistent/b",
		});
		expect(res.code).toBe(127);
		// stdout is the MCP protocol. One stray byte breaks the handshake — so the
		// diagnosis goes to stderr and to the log, never here.
		expect(res.stdout).toBe("");
		const log = await launchLog();
		expect(log).toMatch(/FAILED TO START/);
		// The message must name the trap it is unsticking: ENOENT reads the same
		// for a missing binary, a missing interpreter and a bad token.
		expect(log).toMatch(/looks identical to a missing binary or a bad token/);
	});
});

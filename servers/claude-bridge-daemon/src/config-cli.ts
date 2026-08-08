import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteJson, requestPath, resultPath } from "@claude-bridge/shared";
import { PEER_SETTABLE } from "./handlers/control-config.ts";
import { readLock } from "./lock.ts";

/**
 * `claude-bridge-daemon config …` — the same control_config, from a shell.
 *
 * It submits an RPC request rather than editing `state.json`, and that is the
 * whole design. The daemon is the single writer of that file; a CLI that opened
 * it directly would be a second one, racing the daemon's own read-modify-write
 * on every call. The cost of going through RPC is that the daemon has to be
 * running — which is the honest constraint, not a limitation to work around.
 *
 * Why a CLI at all when the MCP tool exists: cron, scripts, and a human at 3am
 * whose Claude Code will not start. A control plane reachable only from inside
 * the thing it controls is a control plane you cannot use when it matters.
 */

export const CONFIG_HELP = `claude-bridge-daemon config — read and declare peer intent

Usage:
  config                              Show declared intent + drift for every peer
  config <peer>                       Show one peer (id, full name, or short name)
  config --team <team>                Show every peer of a team
  config <peer> --set <k>=<v> [...]   Declare values
  config <peer> --unset <k> [...]     Withdraw a declaration (NOT the same as
                                      setting it empty — an undeclared value
                                      reports no drift at all)
  config <peer> --set <k>=<v> --dry-run
                                      Show what would change, write nothing

Settable keys: ${PEER_SETTABLE.join(", ")}
  windowIndex is RECORDED and drift is reported. It does not move any window
  in v0.11.0 — asserting it is v0.11.1, behind an explicit opt-in.

Examples:
  config mic-tester
  config velitel --set label=velitel --dry-run
  config ai-designer --set model=claude-opus-5 --reason "post-soak bump"
`;

interface ParsedArgs {
  peer?: string;
  team?: string;
  set: Record<string, unknown>;
  unset: string[];
  dryRun: boolean;
  reason?: string;
}

const NUMERIC_KEYS = new Set(["windowIndex"]);

export function parseConfigArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { set: {}, unset: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--team") {
      out.team = argv[++i];
    } else if (a === "--unset") {
      const key = argv[++i];
      if (!key || key.startsWith("--")) throw new Error("--unset expects a key name");
      out.unset.push(key);
    } else if (a === "--reason") {
      out.reason = argv[++i];
    } else if (a === "--set") {
      const pair = argv[++i];
      if (!pair || !pair.includes("=")) {
        throw new Error(`--set expects <key>=<value>, got ${pair ?? "nothing"}`);
      }
      const idx = pair.indexOf("=");
      const key = pair.slice(0, idx);
      const raw = pair.slice(idx + 1);
      // A shell hands everything over as a string. `windowIndex=3` has to reach
      // the schema as a number or it is rejected as an invalid argument, which
      // reads to the operator as "the tool is broken".
      if (NUMERIC_KEYS.has(key)) {
        const n = Number(raw);
        if (!Number.isInteger(n)) throw new Error(`${key} expects an integer, got '${raw}'`);
        out.set[key] = n;
      } else if (raw === "null") {
        out.set[key] = null;
      } else {
        out.set[key] = raw;
      }
    } else if (a?.startsWith("--")) {
      throw new Error(`unknown flag ${a}`);
    } else if (a !== undefined && out.peer === undefined) {
      out.peer = a;
    } else {
      throw new Error(`unexpected argument '${a}'`);
    }
  }
  return out;
}

function generateRequestId(): string {
  return `cli-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

async function pollForResult(requestId: string, timeoutMs: number): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(resultPath(requestId), "utf-8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export async function runConfig(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(CONFIG_HELP);
    return 0;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseConfigArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${CONFIG_HELP}`);
    return 2;
  }

  const lock = await readLock();
  if (!lock) {
    process.stderr.write(
      "daemon is not running — config goes through the daemon so that state.json keeps a single writer\n",
    );
    return 1;
  }

  const args: Record<string, unknown> = { dryRun: parsed.dryRun };
  if (parsed.peer !== undefined) args["peer"] = parsed.peer;
  if (parsed.team !== undefined) args["team"] = parsed.team;
  if (parsed.reason !== undefined) args["reason"] = parsed.reason;
  if (Object.keys(parsed.set).length > 0) args["set"] = parsed.set;
  if (parsed.unset.length > 0) args["unset"] = parsed.unset;

  const id = generateRequestId();
  await atomicWriteJson(requestPath(id), {
    schemaVersion: 1,
    id,
    ts: new Date().toISOString(),
    tool: "control_config",
    args,
    // The CLI is not a peer. Saying so keeps short-name resolution honest —
    // there is no caller team to search, so a bare `velitel` is ambiguous here
    // and the error will say which ones it matched.
    requestedBy: { sessionId: `cli:${process.pid}`, name: "cli" },
  });

  const result = await pollForResult(id, 10_000);
  if (result === null) {
    process.stderr.write(`no result within 10s (request ${id}); daemon may be busy\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const outcome = (result as { outcome?: string }).outcome;
  return outcome === "error" ? 1 : 0;
}

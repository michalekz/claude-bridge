/**
 * `claude agents --json` — the third source, and the one v0.11.25 said did not
 * exist.
 *
 * v0.11.25 stated that an idle gate "cannot be built" and backed it with three
 * measurements: the pane cannot say (during streaming it is indistinguishable
 * from idle), `turnInProgress` cannot say (the last JSONL event at inject time
 * was `assistant`), and the anchor ack cannot say. All three still hold. The
 * conclusion did not, because the survey stopped at three.
 *
 * This call answers without a TTY in about 600 ms and reports, per session,
 * what the pane refuses to: `busy` or `idle`.
 *
 * WHAT IT DOES NOT DO. Between reading `idle` and the keys landing, a turn is
 * free to start — in the P0 incident that window was 0.4 s, and the read itself
 * costs 600 ms. So this narrows the race; it does not close it. The verdict
 * still comes from the recipient's transcript afterwards. A gate that can see
 * the state it gates still only reports the state at the moment it looked.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeLogger } from "@claude-bridge/shared";

const execFileAsync = promisify(execFile);
const log = makeLogger("daemon.host.agents");

/** Measured at ~600 ms on a 25-session fleet; a gate that hangs is not a gate. */
const AGENTS_TIMEOUT_MS = 5_000;

/**
 * What the array actually contains — TWO SHAPES, discriminated by `kind`.
 *
 * MEASURED 2026-08-09 on a 25-entry fleet, and it is not a uniform list:
 *
 *   interactive   pid, cwd, kind, startedAt, sessionId, name, status
 *   background    id,  cwd, kind, startedAt, sessionId, name, state
 *
 * The background entry carries no `status` at all and says `state: "blocked"`
 * instead. A parser that reads `status` off every record gets `undefined` for
 * it, and any code that treats a missing status as idle would call a blocked
 * agent ready. Hence `unknown` is a value here, not an absence.
 */
export type AgentBusy = "idle" | "busy" | "unknown";

export interface AgentRecord {
  sessionId: string;
  name?: string;
  cwd?: string;
  kind?: string;
  pid?: number;
  startedAt?: number;
  /** Normalised. `unknown` whenever the record did not say in words we know. */
  busy: AgentBusy;
  /** Exactly what the two shapes reported, kept for the audit log. */
  reported: { status?: string; state?: string };
}

/**
 * Normalise the two shapes into one answer.
 *
 * UNKNOWN IS TREATED AS BUSY BY CALLERS, never as idle. The asymmetry is the
 * whole point: mistaking a busy peer for an idle one is how the P0 incident
 * happened — the command was queued and executed at a time nobody chose.
 * Mistaking an idle peer for a busy one costs a retry.
 *
 * That rule is worth crediting: it is the one thing worth taking from
 * `primeline-ai/claude-tmux-orchestration`, whose own idle check greps the
 * pane for `Running|thinking|Searching` and therefore shares the blind spot we
 * measured. The disposition is right even where their detector is not.
 */
export function normaliseBusy(record: { status?: unknown; state?: unknown }): AgentBusy {
  if (record.status === "idle") return "idle";
  if (record.status === "busy") return "busy";
  return "unknown";
}

/** Parse the payload. Never throws — an unreadable answer is no answer. */
export function parseAgentsJson(stdout: string): AgentRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AgentRecord[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const sessionId = typeof r["sessionId"] === "string" ? r["sessionId"] : null;
    // Without a session id the record cannot be matched to a peer, and an
    // unmatchable record in a lookup table is a way to answer the wrong
    // question confidently.
    if (!sessionId) continue;
    out.push({
      sessionId,
      ...(typeof r["name"] === "string" ? { name: r["name"] } : {}),
      ...(typeof r["cwd"] === "string" ? { cwd: r["cwd"] } : {}),
      ...(typeof r["kind"] === "string" ? { kind: r["kind"] } : {}),
      ...(typeof r["pid"] === "number" ? { pid: r["pid"] } : {}),
      ...(typeof r["startedAt"] === "number" ? { startedAt: r["startedAt"] } : {}),
      busy: normaliseBusy(r),
      reported: {
        ...(typeof r["status"] === "string" ? { status: r["status"] } : {}),
        ...(typeof r["state"] === "string" ? { state: r["state"] } : {}),
      },
    });
  }
  return out;
}

/**
 * Ask the client what it knows about its own sessions.
 *
 * Returns an empty list on any failure — a missing binary, a timeout, a
 * version that does not have the subcommand. Callers must not read that as
 * "no sessions"; `busyOf` returns `unknown` for anything absent, which is the
 * safe direction.
 */
export async function readAgents(claudeBin = "claude"): Promise<AgentRecord[]> {
  try {
    const { stdout } = await execFileAsync(claudeBin, ["agents", "--json"], {
      timeout: AGENTS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseAgentsJson(stdout);
  } catch (e) {
    log.warn("agents_json_unavailable", { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/**
 * What this source says about one session.
 *
 * A session the source has never heard of is `unknown`, not `idle`. The list is
 * per-client and a peer started by another launcher may simply not be in it —
 * absence is ignorance.
 */
export function busyOf(records: readonly AgentRecord[], sessionId: string | undefined): AgentBusy {
  if (!sessionId) return "unknown";
  const hit = records.find((r) => r.sessionId === sessionId);
  return hit ? hit.busy : "unknown";
}

/** Would injecting now risk landing in a queue? Unknown counts as yes. */
export function mayBeMidTurn(busy: AgentBusy): boolean {
  return busy !== "idle";
}

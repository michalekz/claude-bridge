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
 *
 * WHAT IT CANNOT SEE. The registry is scoped to `CLAUDE_CONFIG_DIR`. Measured
 * 2026-08-09: a session running flat out under a different config directory was
 * absent from the list entirely — not idle, not busy, absent. Every peer in
 * this fleet shares the default directory, so the gate covers them; a peer
 * started with its own config directory is invisible to it and comes back
 * `unknown`, which is the honest answer and the reason `unknown` is not folded
 * into `idle`.
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
/**
 * FOUR ANSWERS, NOT THREE — and the split is the 2026-08-10 P0.
 *
 * Until then this was `idle | busy | unknown`, and `unknown` meant four
 * different things at once: no session id to look up, a valid list without this
 * peer in it, a record whose wording we do not know, and — the one that
 * mattered — *the probe never ran*. The gate in `peer_compact` let `unknown`
 * through, which was reasoned for "peer not in the list" and became a blanket
 * bypass once "the call failed" landed in the same value.
 *
 * MEASURED: the daemon's systemd unit carries no `Environment=PATH`, so
 * `execFile("claude", …)` raised `spawn claude ENOENT` on every call. From the
 * v0.11.26 deploy to the moment it was found: 9 failed probes, 0 `skipped_busy`.
 * The safety added in response to the 2026-08-09 double-compact incident had
 * never once run.
 *
 * So the failure now has its own name and its own disposition. `probe-failed`
 * means we know nothing and must not inject; `absent` means the list was good
 * and this peer simply is not in it, which is the case the deliberate deviation
 * was written for and still passes.
 */
export type AgentBusy = "idle" | "busy" | "absent" | "probe-failed" | "unknown";

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
  // `state` belongs to the background shape, which carries no `status` at all.
  // Both values we have measured are positive statements that the agent is NOT
  // free, and folding them into `unknown` was the worst of the four cases:
  // "one value for a claim and its denial" (etl-velitel, 2026-08-10). Every
  // other `unknown` means we do not know; this one meant we did.
  if (record.state === "blocked" || record.state === "working") return "busy";
  return "unknown";
}

/**
 * Did we get the SHAPE we asked for, whatever it contains?
 *
 * Separate from parsing on purpose: `[]` is a legitimate answer (a fleet with
 * no sessions) and must be distinguishable from `not JSON at all`, which is a
 * failed probe wearing a zero exit code.
 */
export function looksLikeAgentsPayload(stdout: string): boolean {
  try {
    return Array.isArray(JSON.parse(stdout));
  } catch {
    return false;
  }
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
 * The outcome of asking, kept separate from what the answer said.
 *
 * A probe that never ran and a probe that ran and listed nothing are different
 * facts, and the old signature — a bare array — could not tell them apart.
 */
export interface AgentsProbe {
  /** Did we get an answer at all? `false` means the list below is meaningless. */
  ok: boolean;
  records: AgentRecord[];
  /** Why it failed, for the audit trail and for the caller's own result. */
  err?: string;
}

/**
 * Ask the client what it knows about its own sessions.
 *
 * ⚠ `claudeBin` IS NOT OPTIONAL IN PRACTICE. The default exists for tests and
 * for callers that genuinely have nothing better; in the daemon the right value
 * is the very path the daemon already uses to spawn peers
 * (`record.desired.command`). Relying on the ambient `PATH` is what broke this:
 * the systemd unit sets an absolute path for what it launches directly and
 * leaves everything indirect to a `PATH` that has no nvm in it. `tmux`,
 * `systemctl` and `node` survive that only because someone once symlinked them
 * into a system directory — a property of this machine, not of the design.
 * `claude` never got such a symlink, and this call was dead from the day it
 * shipped. It was the SECOND instance in three days: 2026-08-08 was the same
 * PATH, a different call, and v0.11.13 patched that one call rather than the
 * cause.
 */
export async function probeAgents(claudeBin = "claude"): Promise<AgentsProbe> {
  try {
    const { stdout } = await execFileAsync(claudeBin, ["agents", "--json"], {
      timeout: AGENTS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    // An answer we cannot read is not an empty fleet. A binary that exists but
    // does not have this subcommand — an older client, a wrapper, the wrong
    // `claude` on the PATH — exits zero and prints something else, and calling
    // that "no sessions" would recreate the very bug this split exists to fix,
    // just one layer up.
    if (!looksLikeAgentsPayload(stdout)) {
      const err = "agents --json did not return a JSON array";
      log.warn("agents_json_unreadable", { err, claudeBin });
      return { ok: false, records: [], err };
    }
    return { ok: true, records: parseAgentsJson(stdout) };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.warn("agents_json_unavailable", { err, claudeBin });
    return { ok: false, records: [], err };
  }
}

/**
 * Records only, for callers that treat absence and failure alike.
 *
 * `peer_identity` is one: it uses the list to CONFIRM an identity it already
 * suspects, so an empty list costs it a fallback, never a wrong answer.
 */
export async function readAgents(claudeBin = "claude"): Promise<AgentRecord[]> {
  return (await probeAgents(claudeBin)).records;
}

/**
 * What this source says about one session — and how sure it is that it said it.
 *
 * The order of the checks is the whole point: a failed probe outranks every
 * other verdict, because a list we never received cannot be evidence that a
 * peer is missing from it.
 */
export function busyOf(probe: AgentsProbe, sessionId: string | undefined): AgentBusy {
  if (!probe.ok) return "probe-failed";
  if (!sessionId) return "unknown";
  const hit = probe.records.find((r) => r.sessionId === sessionId);
  return hit ? hit.busy : "absent";
}

/** Would injecting now risk landing in a queue? Anything but a measured idle counts as yes. */
export function mayBeMidTurn(busy: AgentBusy): boolean {
  return busy !== "idle";
}

/**
 * Does this verdict stop an inject?
 *
 * Deliberately NOT `mayBeMidTurn`. Refusing on everything that is not a
 * measured `idle` would make every peer the source cannot see — anything
 * adopted without a measured session id — permanently uncompactable, and the
 * after-the-fact verification already covers what this gate misses.
 *
 * `probe-failed` is the one that changed. It used to pass as `unknown`, which
 * is how a reasoned exception for "peer not in the list" turned into a bypass
 * for "we never looked". Cost of getting it wrong is asymmetric and was
 * measured on 2026-08-09: a needless `skipped_busy` costs one inject, because
 * the anchor is already written; a false `idle` costs a peer its context twice.
 */
export function blocksInject(busy: AgentBusy): boolean {
  return busy === "busy" || busy === "probe-failed";
}

import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { sessionFile } from "@claude-bridge/shared";
import { readPeerContext } from "../compact-verify.ts";
import { type AgentBusy, busyOf, probeAgents } from "../hosts/agents-json.ts";
import { pollUntil } from "../poll.ts";

/**
 * The turn-end gate (v0.11.51): after a peer ACKS a stop or restart, wait for
 * its turn to end before anything is killed.
 *
 * Why the ack alone is not enough — the 2026-09-12 "mystery ack". An ack is
 * written by a tool call, which means INSIDE a turn. `peer_restart` accepted
 * oxy-marketing's ack at 07:39:55.952 and killed the session at ~07:39:56 —
 * mid-turn, before Claude Code persisted the assistant message carrying the
 * very tool_use that wrote the ack. The transcript was left with a synthetic
 * "No response requested." closure and no tool call, and the peer concluded,
 * honestly and wrongly, that it had never acked. The kill the ack authorized
 * destroyed the record of the ack. It took a byte-level fingerprint of the ack
 * file (the peer's own printf idiom: 69 bytes, no trailing newline) to
 * establish who wrote it.
 *
 * Measured on the fix, on this handler's own author: ack at 09:05:58, a 1877-byte
 * closing report persisted 23 s LATER, `turnEndWaitedMs: 24067`. Under v0.11.50
 * that report would have vanished.
 *
 * `peer_compact` has carried this lesson since v0.11.26/33 for its INJECT
 * ("writing the ack is itself a turn"). This module is the same wait applied
 * to the KILL, shared by `peer_restart` and `peer_stop`.
 *
 * POLICY — deliberately weaker than compact's `blocksInject`:
 *
 *   busy   → wait, up to `timeoutMs`, unless the TRANSCRIPT says the turn is
 *            over (see below). Still busy after that: the caller must NOT kill.
 *   idle   → proceed.
 *   absent / probe-failed → proceed. Refusing here would make a peer the probe
 *            cannot see (adopted without a measured session id, or the
 *            broken-PATH probe of the 2026-08-10 P0) permanently un-stoppable
 *            — and a kill on an unknown state is exactly what every kill was
 *            before this gate existed. The gate is an added courtesy on top of
 *            the ack, not the primary safety: the ack already says the peer's
 *            WORK is durable; this protects the TURN that said so.
 */

/**
 * 🔴 THE SECOND SOURCE — `busy` DOES NOT MEAN `mid-turn` (v0.11.52).
 *
 * Measured within hours of shipping the gate: of 14 fleet restarts, 2 could
 * never pass it. `ai-kb-ops` sat at an empty prompt with an 11-minute-old
 * transcript; `ai-velitel` likewise for 4 minutes. Both reported `busy` by
 * `claude agents --json` — because a peer with a persistent Monitor or
 * background agents is busy by that source's definition FOR AS LONG AS THEY
 * RUN. A graceful restart of such a peer could never complete: the gate would
 * refuse for ever, and the only way through was a deliberate `force`.
 *
 * So the probe gets a second opinion, from the peer's own transcript, and the
 * question is narrowed from "is this session busy" to "is a TURN in flight":
 *
 *   - The last content row is an ASSISTANT message with no `tool_use` block.
 *     A turn ends on such a row; an interim one is followed within seconds by
 *     the tool call it announced. (A row of type `user` means the model has
 *     work in hand — a tool result to read, or a prompt to answer — so that
 *     case stays busy no matter how long it has been quiet.)
 *   - …and it has been quiet for `QUIET_MS`.
 *
 * Checked against both real cases and the incident it must NOT loosen:
 * kb-ops and ai-velitel pass (last row = their closing text, minutes old);
 * oxy-marketing at kill time does NOT (its last row was the incoming request,
 * with the assistant message still unwritten — exactly the shape this gate
 * exists to protect).
 */
const QUIET_MS = 30_000;

export const DEFAULT_TURN_END_TIMEOUT_MS = 90_000;
/** `claude agents --json` costs ~600 ms; a shorter gap only queues probes. */
export const DEFAULT_TURN_END_POLL_MS = 1_000;
/** Give up on OUR broken tooling, not on a slow peer — see peer-compact.ts. */
const PROBE_RETRY_ATTEMPTS = 3;
/** Enough of the tail to hold several rows; transcripts run to tens of MB. */
const TAIL_BYTES = 256 * 1024;

export interface TurnEndOutcome {
  /** Last observed probe state. `busy` here means the budget ran out. */
  state: AgentBusy;
  /** True when the FIRST probe said busy — i.e. the gate actually waited. */
  waited: boolean;
  /** MEASURED, never the budget — poll.ts's one invariant. */
  waitedMs: number;
  probeFailures: number;
  /**
   * The probe said busy and the transcript said the turn was over. Recorded
   * because it is the one path where the two sources disagree and we act on
   * the second one.
   */
  concludedByTranscript: boolean;
  /** How long the transcript had been quiet when it decided. */
  transcriptQuietMs: number | null;
}

/** May this peer be stopped — from the probe alone? */
function probePasses(state: AgentBusy): boolean {
  return state !== "busy";
}

type Row = {
  type?: string;
  timestamp?: string;
  message?: { content?: unknown };
};

/** Does this assistant row announce more work (a tool call) in this turn? */
function hasToolUse(row: Row): boolean {
  const content = row.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use",
  );
}

/**
 * Read the transcript's tail and ask whether a TURN is in flight.
 *
 * Returns the quiet duration when the last content row concludes a turn, and
 * `null` when it does not — or when the transcript cannot be read, which is
 * "cannot say", never "the turn is over".
 */
export async function turnConcludedFor(transcriptPath: string): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const size = (await stat(transcriptPath)).size;
    const start = Math.max(0, size - TAIL_BYTES);
    handle = await open(transcriptPath, "r");
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line?.trim()) continue;
      let row: Row;
      try {
        row = JSON.parse(line) as Row;
      } catch {
        // A partial first line (we started mid-file) or a half-written last
        // one. Neither is a content row; keep looking.
        continue;
      }
      // Bookkeeping rows say nothing about whose turn it is.
      if (row.type !== "assistant" && row.type !== "user") continue;
      if (row.type === "user") return null;
      if (hasToolUse(row)) return null;
      if (!row.timestamp) return null;
      const quietMs = Date.now() - Date.parse(row.timestamp);
      return Number.isFinite(quietMs) && quietMs >= QUIET_MS ? quietMs : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Where the peer's transcript is.
 *
 * The statusline capture is authoritative — Claude Code writes the path itself
 * — and the cwd-derived location is the fallback for a peer whose live data is
 * not set up. Returns `null` when neither exists, which the gate reads as
 * "no second source", not as "no turn".
 */
export async function transcriptPathOf(
  sessionId: string | undefined,
  cwd: string | undefined,
): Promise<string | null> {
  if (!sessionId) return null;
  const fromStatusline = (await readPeerContext(sessionId)).transcriptPath;
  if (fromStatusline && existsSync(fromStatusline)) return fromStatusline;
  if (!cwd) return null;
  const derived = sessionFile(cwd, sessionId);
  return existsSync(derived) ? derived : null;
}

export async function waitForTurnEnd(
  // Optional like `PeerRecord.desired.command` — `probeAgents` defaults to the
  // ambient `claude`, and a failed probe proceeds (see POLICY above).
  claudeBin: string | undefined,
  sessionId: string | undefined,
  timeoutMs: number = DEFAULT_TURN_END_TIMEOUT_MS,
  pollMs: number = DEFAULT_TURN_END_POLL_MS,
  cwd?: string,
): Promise<TurnEndOutcome> {
  const startedAt = Date.now();
  const transcriptPath = await transcriptPathOf(sessionId, cwd);
  let quietMs: number | null = null;
  /** The two sources, asked in cost order: the file first, the process second. */
  const concluded = async (): Promise<boolean> => {
    if (transcriptPath === null) return false;
    quietMs = await turnConcludedFor(transcriptPath);
    return quietMs !== null;
  };

  let probe = await probeAgents(claudeBin);
  let state = busyOf(probe, sessionId);
  let probeFailures = probe.ok ? 0 : 1;
  const waited = !probePasses(state);
  let concludedByTranscript = false;

  if (waited && timeoutMs > 0) {
    concludedByTranscript = await concluded();
    if (!concludedByTranscript) {
      await pollUntil<AgentBusy>(
        async () => {
          probe = await probeAgents(claudeBin);
          state = busyOf(probe, sessionId);
          probeFailures = probe.ok ? 0 : probeFailures + 1;
          if (probePasses(state)) return state;
          concludedByTranscript = await concluded();
          return concludedByTranscript ? state : null;
        },
        {
          timeoutMs,
          pollMs,
          abort: () =>
            probeFailures >= PROBE_RETRY_ATTEMPTS
              ? { aborted: true, reason: "probe_failed_repeatedly" }
              : { aborted: false },
        },
      );
    }
  }
  return {
    state,
    waited,
    waitedMs: Date.now() - startedAt,
    probeFailures,
    concludedByTranscript,
    transcriptQuietMs: quietMs,
  };
}

/** The gate's verdict: may the caller stop this peer? */
export function mayStop(outcome: TurnEndOutcome): boolean {
  return probePasses(outcome.state) || outcome.concludedByTranscript;
}

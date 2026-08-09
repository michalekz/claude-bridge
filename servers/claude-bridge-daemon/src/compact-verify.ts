/**
 * Did the compact actually happen? — v0.11.25.
 *
 * WHY THIS FILE EXISTS
 *
 * On 2026-08-09 the control plane injected `/compact` into a peer, `sendKeys`
 * returned, and the daemon wrote `peer_compacted`. The peer compacted five
 * minutes and fifty-two seconds later, on a context that had been emptied in
 * the meantime by Claude Code's own autocompact — the second compression landed
 * at 9 % and threw away a freshly restored state.
 *
 * Nothing malfunctioned. The pane was busy, so Claude Code did what it does
 * with input during a running turn: it QUEUED it. Measured, from the peer's own
 * transcript:
 *
 *     07:31:44.942  enqueue  /compact          <- our inject, merely queued
 *     07:35:27      compactMetadata trigger=auto,   1 001 614 -> 13 944
 *     07:37:37.153  dequeue  -> /compact runs, 5m52s after the inject
 *     07:39:58      compactMetadata trigger=manual,    87 556 -> 10 822
 *
 * So the rule this file encodes: A DELIVERED COMMAND IS NOT AN EXECUTED
 * COMMAND. Delivery is a fact about a terminal; execution is a fact about the
 * recipient, and only the recipient's transcript can report it.
 *
 * WHY NOT AN IDLE GATE INSTEAD
 *
 * The obvious fix is to refuse to inject unless the pane is idle. It cannot be
 * built, and that is measured too, not assumed:
 *
 *   - THE PANE CANNOT SAY. While a peer streams its answer the pane is
 *     indistinguishable from an idle one: no spinner, empty input box, same
 *     status row. `✽ Computing…` shows during thinking and tool calls and
 *     disappears exactly when text starts arriving.
 *   - `turnInProgress` CANNOT SAY EITHER. It asks whether the last transcript
 *     row is a `user` row postdating the last assistant row; at inject time in
 *     the reproduction the last row was an `assistant` thinking block, so it
 *     read "idle" in the middle of a running turn.
 *   - THE ACK CANNOT SAY. `peer_compact` used to argue that the anchor ack IS
 *     the proof of idleness, because a peer only reaches its inbox between
 *     turns. True — and irrelevant. It proves the peer was idle when it acked,
 *     not when we injected. In the incident a new turn started in between.
 *
 * A gate that cannot see the state it gates is worse than no gate: it reports
 * safety it does not have. So the question is asked AFTERWARDS, where the
 * transcript answers it exactly.
 */
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { bridgeRoot, makeLogger } from "@claude-bridge/shared";

const log = makeLogger("daemon.compact-verify");

/**
 * Where the statusLine wrapper drops its per-session capture.
 *
 * Built here rather than imported because `@claude-bridge/shared` has no helper
 * for it — the MCP server keeps its own copy of this path. That is the third
 * such duplicate and it is already on the backlog; adding a fourth reader is
 * not the moment to fix it, but it is the moment to say so out loud.
 */
function statuslineFile(sessionId: string): string {
  return join(bridgeRoot(), "live", "statusline", `${sessionId}.json`);
}

/** How long to watch for the compact by default. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 180_000;
export const DEFAULT_VERIFY_POLL_MS = 2_000;

/**
 * Above this, a compact is racing Claude Code's own autocompact.
 *
 * Not a blocking threshold — a named one. On 2026-08-09 two peers hit it in one
 * morning: the designer's at 1 001 614 tokens (autocompact won) and the keeper
 * at 85 %, which began autocompacting mid-orchestration. The operator can still
 * proceed; what they must not do is proceed without being told.
 */
export const COMPACT_RACE_PERCENT = 85;

export type CompactWatchOutcome =
  /** Ours ran. The only outcome that licenses `peer_compacted`. */
  | {
      kind: "executed";
      at: string;
      preTokens: number | null;
      postTokens: number | null;
      queuedAt: string | null;
      preemptedByAuto: AutoCompact | null;
    }
  /** Claude Code compacted on its own and ours is still pending. */
  | { kind: "preempted-unresolved"; auto: AutoCompact; queuedAt: string | null; waitedMs: number }
  /** Queued and still queued when the window closed — it WILL run, unattended. */
  | { kind: "queued-unresolved"; queuedAt: string; waitedMs: number }
  /** Nothing at all appeared. Neither queued nor executed nor auto. */
  | { kind: "silent"; waitedMs: number };

export type AutoCompact = { at: string; preTokens: number | null; postTokens: number | null };

/** What the statusline capture can tell us before we inject. */
export type PeerContextSnapshot = {
  usedPercentage: number | null;
  transcriptPath: string | null;
  capturedAt: string | null;
};

/**
 * Read the peer's own statusline capture.
 *
 * Chosen over a JSONL token scan because it needs no model table: Claude Code
 * writes `context_window.used_percentage` itself, against the window IT knows
 * it has. `transcript_path` comes free in the same file, which saves
 * reconstructing the project-directory encoding.
 *
 * Returns nulls rather than throwing — a peer without live data is a peer we
 * compact without a race warning, not one we refuse to compact.
 */
export async function readPeerContext(sessionId: string): Promise<PeerContextSnapshot> {
  const empty: PeerContextSnapshot = {
    usedPercentage: null,
    transcriptPath: null,
    capturedAt: null,
  };
  try {
    const raw = await readFile(statuslineFile(sessionId), "utf-8");
    const doc = JSON.parse(raw) as {
      capturedAt?: string;
      payload?: {
        transcript_path?: string;
        context_window?: { used_percentage?: number };
      };
    };
    return {
      usedPercentage: doc.payload?.context_window?.used_percentage ?? null,
      transcriptPath: doc.payload?.transcript_path ?? null,
      capturedAt: doc.capturedAt ?? null,
    };
  } catch {
    return empty;
  }
}

/** Byte offset to start reading the transcript from. Taken BEFORE the inject. */
export async function markTranscript(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

type Row = {
  type?: string;
  operation?: string;
  content?: unknown;
  timestamp?: string;
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
};

/**
 * Read whole lines appended since `offset`, and report the new offset.
 *
 * Reading by offset rather than by timestamp is not an optimisation — these
 * transcripts reach tens of megabytes, and a 55 MB re-read every two seconds
 * would be its own outage. It is also more exact: "everything written after we
 * injected" needs no clock comparison and no assumption that rows arrive in
 * timestamp order. (They do not always: the reproduction shows an `assistant`
 * row timestamped before a `queue-operation` written earlier in the file.)
 */
async function readSince(path: string, offset: number): Promise<{ rows: Row[]; offset: number }> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const size = (await stat(path)).size;
    // A transcript that SHRANK was rotated or replaced; start over from where
    // it now ends rather than reading a different file's bytes as ours.
    if (size < offset) return { rows: [], offset: size };
    if (size === offset) return { rows: [], offset };
    handle = await open(path, "r");
    const buf = Buffer.alloc(size - offset);
    await handle.read(buf, 0, buf.length, offset);
    const text = buf.toString("utf-8");
    // Keep the trailing partial line for the next pass — a half-written row
    // parsed now is a row missed forever.
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { rows: [], offset };
    const rows: Row[] = [];
    for (const line of text.slice(0, lastNl).split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as Row);
      } catch {
        // A row we cannot parse is not a row we can act on. Skipping it is
        // right; failing the whole watch over it is not.
      }
    }
    return { rows, offset: offset + Buffer.byteLength(text.slice(0, lastNl + 1)) };
  } catch {
    return { rows: [], offset };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function compactOf(
  row: Row,
): { trigger: string; at: string; pre: number | null; post: number | null } | null {
  const meta = row.compactMetadata;
  if (!meta?.trigger) return null;
  return {
    trigger: meta.trigger,
    at: row.timestamp ?? new Date().toISOString(),
    pre: typeof meta.preTokens === "number" ? meta.preTokens : null,
    post: typeof meta.postTokens === "number" ? meta.postTokens : null,
  };
}

/** Was this row Claude Code putting our payload into its queue? */
function isEnqueueOf(row: Row, payload: string): boolean {
  if (row.type !== "queue-operation" || row.operation !== "enqueue") return false;
  const c = row.content;
  const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
  return text.includes(payload);
}

export type WatchOptions = {
  transcriptPath: string;
  /** Offset taken before the inject. */
  fromOffset: number;
  payload: string;
  timeoutMs: number;
  pollMs?: number;
  /** Injected so tests do not spend three minutes proving a timeout. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Watch until the compact resolves, or the window closes.
 *
 * `queued` is deliberately NOT a terminal state. The item cannot be taken back
 * out — measured: forty `C-u` strokes against a busy pane left a queued message
 * untouched — so a tool that answered "queued, good luck" would be handing the
 * operator the same silent unbounded delay that caused the incident. The watch
 * keeps running; only the window closing ends it, and then it says so.
 */
export async function watchForCompact(opts: WatchOptions): Promise<CompactWatchOutcome> {
  const pollMs = opts.pollMs ?? DEFAULT_VERIFY_POLL_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedMs = now();
  const deadline = startedMs + opts.timeoutMs;

  let offset = opts.fromOffset;
  let queuedAt: string | null = null;
  let auto: AutoCompact | null = null;

  for (;;) {
    const { rows, offset: next } = await readSince(opts.transcriptPath, offset);
    offset = next;
    for (const row of rows) {
      if (queuedAt === null && isEnqueueOf(row, opts.payload)) {
        queuedAt = row.timestamp ?? new Date().toISOString();
        log.warn("compact_queued", { queuedAt, payload: opts.payload });
        continue;
      }
      const c = compactOf(row);
      if (!c) continue;
      if (c.trigger === "manual") {
        return {
          kind: "executed",
          at: c.at,
          preTokens: c.pre,
          postTokens: c.post,
          queuedAt,
          preemptedByAuto: auto,
        };
      }
      if (c.trigger === "auto" && auto === null) {
        // Claude Code compacted first. Ours is still coming, and it will land
        // on the context this one just emptied. Record it and keep watching —
        // this is the incident, and reporting it needs the second half too.
        auto = { at: c.at, preTokens: c.pre, postTokens: c.post };
        log.error("compact_preempted_by_auto", auto);
      }
    }

    if (now() >= deadline) {
      const waitedMs = now() - startedMs;
      if (auto) return { kind: "preempted-unresolved", auto, queuedAt, waitedMs };
      if (queuedAt) return { kind: "queued-unresolved", queuedAt, waitedMs };
      return { kind: "silent", waitedMs };
    }
    await sleep(pollMs);
  }
}

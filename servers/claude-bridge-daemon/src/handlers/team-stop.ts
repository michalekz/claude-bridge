import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, bridgeRoot, controlDir, teamsDir } from "@claude-bridge/shared";
import { z } from "zod";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { handlePeerStop } from "./peer-stop.ts";

/**
 * team_stop — controlled sleep of an entire team (§9 zadání, v0.10.1).
 *
 * Not a mass-kill: per-peer STOP REQUEST protocol.
 *   1. bridge inbox `kind: "stop-request"` — peer flushes anchor + memory,
 *      then touches ~/.claude-bridge/control/stop-ack/<sessionId>.json
 *   2. daemon polls the ack file with `anchorTimeoutMs`
 *      (default 120 s = 4× compact-ack; peer has more to do)
 *   3. ack → peer_stop(keepInState:true, stoppedCleanly:true)
 *      timeout && force:false → SKIP (peer keeps running, event stop_ack_timeout)
 *      timeout && force:true  → peer_stop(keepInState:true, stoppedCleanly:false, force:true)
 *      dead peer (no host)    → peer_stop(keepInState:true, stoppedCleanly:null)
 *
 * Ordering: `role: "velitel"` wins over position; otherwise array order,
 * velitel LAST by convention.
 *
 * State post-stop: PeerRecord kept with status:"stopped" so team_layout apply
 * can resume via the same sessionId later.
 */

const DEFAULT_ANCHOR_TIMEOUT_MS = 120_000;
const DEFAULT_ACK_POLL_MS = 500;
const STOP_ACK_FILENAME_EXTENSION = ".json";

const PeerOrderableSchema = z.object({
  sessionId: z.string().min(1),
  displayName: z.string().min(1),
  role: z.string().optional(),
});

const TeamStopFileSchema = z.object({
  team: z.string().min(1),
  peers: z.array(PeerOrderableSchema).min(1),
});

export const TeamStopArgsSchema = z
  .object({
    team: z.string().min(1),
    force: z.boolean().default(false),
    anchorTimeoutMs: z.number().int().positive().max(600_000).optional(),
    ackPollMs: z.number().int().positive().max(10_000).optional(),
    dryRun: z.boolean().default(false),
    inline: TeamStopFileSchema.optional(),
  })
  .strict();

export type TeamStopArgs = z.infer<typeof TeamStopArgsSchema>;

function teamFilePath(team: string): string {
  return join(teamsDir(), `${team}.json`);
}

async function loadTeamOrder(team: string): Promise<z.infer<typeof TeamStopFileSchema> | null> {
  try {
    const raw = await readFile(teamFilePath(team), "utf-8");
    const json = JSON.parse(raw);
    const parsed = TeamStopFileSchema.safeParse(json);
    if (!parsed.success) throw new Error(`Team spec parse failed: ${parsed.error.message}`);
    return parsed.data;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw e;
  }
}

function stopAckDir(): string {
  return join(controlDir(), "stop-ack");
}

function stopAckPath(sessionId: string): string {
  return join(stopAckDir(), `${sessionId}${STOP_ACK_FILENAME_EXTENSION}`);
}

function inboxPendingDir(peerId: string): string {
  return join(bridgeRoot(), "inbox", peerId, "pending");
}

function generateMsgId(): string {
  const ms = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ms}-${rand}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pollForAck(sessionId: string, deadline: number, pollMs: number): Promise<boolean> {
  const path = stopAckPath(sessionId);
  while (Date.now() < deadline) {
    if (await fileExists(path)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return fileExists(path);
}

async function consumeAckFile(sessionId: string): Promise<void> {
  const src = stopAckPath(sessionId);
  const done = join(stopAckDir(), "done");
  try {
    await mkdir(done, { recursive: true });
    await rename(src, join(done, `${sessionId}-${Date.now()}.json`));
  } catch {
    await unlink(src).catch(() => undefined);
  }
}

async function writeStopRequestMsg(
  peerId: string,
  threadId: string,
  reason: string | null,
): Promise<string> {
  const msgId = generateMsgId();
  const envelope = {
    id: msgId,
    ts: new Date().toISOString(),
    from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
    to: { sessionId: peerId, name: peerId },
    kind: "stop-request",
    threadId,
    content: {
      instruction:
        "Finish or park current work, flush anchor + memory, then touch ~/.claude-bridge/control/stop-ack/<sessionId>.json — the daemon will kill your session once the ack file is present.",
      reason,
    },
  };
  const path = join(inboxPendingDir(peerId), `${msgId}.json`);
  await atomicWriteJson(path, envelope);
  return msgId;
}

interface StopOutcome {
  sessionId: string;
  displayName: string;
  outcome: "cleanly" | "forced" | "dead" | "skipped" | "failed";
  err?: string;
}

async function stopSinglePeer(
  req: RequestEnvelope,
  ctx: HandlerContext,
  peer: { sessionId: string; displayName: string; role?: string | undefined },
  args: TeamStopArgs,
  threadId: string,
  anchorTimeoutMs: number,
  ackPollMs: number,
): Promise<StopOutcome> {
  const record = ctx.state.peers[peer.sessionId];
  if (!record) {
    return { sessionId: peer.sessionId, displayName: peer.displayName, outcome: "dead" };
  }
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;
  const alive = record.observed.tmuxTarget ? await ctx.hostDriver.hasSession(sessionKey) : false;
  if (!alive) {
    const stopReq = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:stop:${peer.sessionId}`,
      ts: req.ts,
      tool: "peer_stop",
      args: {
        peer: peer.sessionId,
        reason: `team_stop:${args.team}:dead`,
        force: false,
        keepInState: true,
        stoppedCleanly: null,
      },
      requestedBy: req.requestedBy,
    };
    const res = await handlePeerStop(stopReq, ctx);
    if (res.outcome === "error") {
      return {
        sessionId: peer.sessionId,
        displayName: peer.displayName,
        outcome: "failed",
        err: res.error?.message,
      };
    }
    await writeEvent({
      event: "peer_stopped_dead",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: peer.sessionId, sessionKey, team: args.team, threadId },
    });
    return { sessionId: peer.sessionId, displayName: peer.displayName, outcome: "dead" };
  }
  await mkdir(stopAckDir(), { recursive: true });
  let stopReqMsgId: string;
  try {
    stopReqMsgId = await writeStopRequestMsg(
      peer.sessionId,
      threadId,
      args.force ? "force:true" : null,
    );
  } catch (e) {
    return {
      sessionId: peer.sessionId,
      displayName: peer.displayName,
      outcome: "failed",
      err: e instanceof Error ? e.message : String(e),
    };
  }
  await writeEvent({
    event: "peer_stop_requested",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      sessionId: peer.sessionId,
      sessionKey,
      team: args.team,
      threadId,
      stopReqMsgId,
      timeoutMs: anchorTimeoutMs,
    },
  });
  const deadline = Date.now() + anchorTimeoutMs;
  const acked = await pollForAck(peer.sessionId, deadline, ackPollMs);
  if (!acked && !args.force) {
    await writeEvent({
      event: "stop_ack_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: peer.sessionId,
        sessionKey,
        team: args.team,
        threadId,
        timeoutMs: anchorTimeoutMs,
      },
    });
    return { sessionId: peer.sessionId, displayName: peer.displayName, outcome: "skipped" };
  }
  if (acked) {
    await consumeAckFile(peer.sessionId);
  }
  const stopReq = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:stop:${peer.sessionId}`,
    ts: req.ts,
    tool: "peer_stop",
    args: {
      peer: peer.sessionId,
      reason: `team_stop:${args.team}:${acked ? "cleanly" : "forced"}`,
      force: !acked,
      keepInState: true,
      stoppedCleanly: acked,
    },
    requestedBy: req.requestedBy,
  };
  const res = await handlePeerStop(stopReq, ctx);
  if (res.outcome === "error") {
    return {
      sessionId: peer.sessionId,
      displayName: peer.displayName,
      outcome: "failed",
      err: res.error?.message,
    };
  }
  await writeEvent({
    event: acked ? "peer_stopped_cleanly" : "peer_stopped_forced",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId: peer.sessionId, sessionKey, team: args.team, threadId },
  });
  await publishLifecycleEvent({
    event: acked ? "peer_stopped_cleanly" : "peer_stopped_forced",
    sessionId: peer.sessionId,
    sessionKey,
    details: { team: args.team, threadId },
  });
  return {
    sessionId: peer.sessionId,
    displayName: peer.displayName,
    outcome: acked ? "cleanly" : "forced",
  };
}

function orderPeersForStop<T extends { role?: string | undefined }>(peers: T[]): T[] {
  const veliteli = peers.filter((p) => p.role === "velitel");
  const rest = peers.filter((p) => p.role !== "velitel");
  return veliteli.length > 0 ? [...rest, ...veliteli] : peers.slice();
}

export async function handleTeamStop(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = TeamStopArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  let spec: z.infer<typeof TeamStopFileSchema> | null;
  try {
    spec = args.inline ?? (await loadTeamOrder(args.team));
  } catch (e) {
    return errResult(
      req.id,
      req.tool,
      "team_spec_read_failed",
      e instanceof Error ? e.message : String(e),
      { team: args.team },
    );
  }
  if (!spec) {
    return errResult(
      req.id,
      req.tool,
      "team_spec_missing",
      `No team file at ${teamFilePath(args.team)}`,
      { team: args.team },
    );
  }

  const ordered = orderPeersForStop(spec.peers);
  const anchorTimeoutMs = args.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
  const ackPollMs = args.ackPollMs ?? DEFAULT_ACK_POLL_MS;
  const threadId = `team-stop:${spec.team}:${Date.now().toString(36)}`;

  if (args.dryRun) {
    return okResult(req.id, req.tool, {
      mode: "dryRun",
      team: spec.team,
      order: ordered.map((p) => ({
        sessionId: p.sessionId,
        displayName: p.displayName,
        role: p.role ?? null,
      })),
      anchorTimeoutMs,
      force: args.force,
    });
  }

  await writeEvent({
    event: "team_stop_started",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      team: spec.team,
      threadId,
      order: ordered.map((p) => p.sessionId),
      anchorTimeoutMs,
      force: args.force,
    },
  });

  const outcomes: StopOutcome[] = [];
  for (const peer of ordered) {
    const outcome = await stopSinglePeer(
      req,
      ctx,
      peer,
      args,
      threadId,
      anchorTimeoutMs,
      ackPollMs,
    );
    outcomes.push(outcome);
  }

  const summary = {
    team: spec.team,
    threadId,
    stoppedCleanly: outcomes.filter((o) => o.outcome === "cleanly").map((o) => o.sessionId),
    stoppedForced: outcomes.filter((o) => o.outcome === "forced").map((o) => o.sessionId),
    stoppedDead: outcomes.filter((o) => o.outcome === "dead").map((o) => o.sessionId),
    skipped: outcomes.filter((o) => o.outcome === "skipped").map((o) => o.sessionId),
    failedKill: outcomes
      .filter((o) => o.outcome === "failed")
      .map((o) => ({ sessionId: o.sessionId, err: o.err ?? "unknown" })),
  };

  await writeEvent({
    event: "team_stop_completed",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: summary,
  });

  return okResult(req.id, req.tool, summary);
}

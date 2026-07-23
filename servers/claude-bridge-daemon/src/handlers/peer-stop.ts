import { z } from "zod";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { applyStateChange } from "./state-writer.ts";

/**
 * peer_stop — full lifecycle (§5.2 zadání + designer msg mrxe9t7d
 * post-mortem addition on bg-pty-host respawn).
 *
 * Sequence:
 *   1. Resolve peer (id or displayName) in state.peers
 *   2. Mark status=stopping (state saved so a concurrent restart sees it)
 *   3. Dispatch to host driver.kill() — the driver is responsible for
 *      terminating the ENTIRE supervised tree (bg-pty lesson) and for
 *      polling post-kill to detect respawn class of failures
 *   4. Remove the peer from state, emit `peer_stopped`
 *
 * `force:true` propagates to the driver — a shorter verify budget so
 * the operator gets feedback fast when the host is not responding.
 */

export const PeerStopArgsSchema = z
  .object({
    peer: z.string().min(1),
    reason: z.string().optional(),
    force: z.boolean().default(false),
  })
  .strict();

export type PeerStopArgs = z.infer<typeof PeerStopArgsSchema>;

function findPeer(state: HandlerContext["state"], key: string): { sessionId: string } | null {
  if (state.peers[key]) return { sessionId: key };
  for (const [id, rec] of Object.entries(state.peers)) {
    if (rec.name === key) return { sessionId: id };
  }
  return null;
}

export async function handlePeerStop(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = PeerStopArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  const found = findPeer(ctx.state, args.peer);
  if (!found) {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "info",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { peer: args.peer, reason: "peer_not_found" },
    });
    return errResult(
      req.id,
      req.tool,
      "peer_not_found",
      `No peer with id/name '${args.peer}' in daemon state`,
      { peer: args.peer },
    );
  }
  const sessionId = found.sessionId;
  const record = ctx.state.peers[sessionId];
  if (!record) {
    // Race: peer disappeared between findPeer and now. Treat as success.
    return okResult(req.id, req.tool, { sessionId, alreadyGone: true });
  }
  const sessionKey = record.tmuxTarget ?? record.name;

  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[sessionId];
    if (rec) {
      rec.status = "stopping";
      rec.lastUpdatedAt = new Date().toISOString();
    }
  });

  const forceFlag = args.force === true;
  try {
    await ctx.hostDriver.kill(sessionKey, { force: forceFlag });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Special case: driver's verify caught a respawn (bg-pty-host class).
    // Leave state.peers as `stopping` — an operator has to intervene
    // manually. Emit the loudest event we have.
    if (msg.includes("respawn")) {
      await writeEvent({
        event: "peer_stop_respawn_detected",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { sessionId, sessionKey, err: msg },
      });
      return errResult(req.id, req.tool, "supervisor_respawn", msg, { sessionId, sessionKey });
    }
    await writeEvent({
      event: "peer_stop_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, err: msg },
    });
    return errResult(req.id, req.tool, "host_kill_failed", msg, { sessionId, sessionKey });
  }

  await applyStateChange(ctx.state, (draft) => {
    delete draft.peers[sessionId];
  });
  await writeEvent({
    event: "peer_stopped",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      sessionId,
      sessionKey,
      reason: args.reason ?? null,
      force: forceFlag,
    },
  });
  return okResult(req.id, req.tool, { sessionId, sessionKey, force: forceFlag });
}

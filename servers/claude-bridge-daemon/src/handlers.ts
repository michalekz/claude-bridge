import { writeEvent } from "./events.ts";
import type { RequestEnvelope, ResultEnvelope } from "./rpc.ts";
import { errResult, okResult } from "./rpc.ts";
import type { StateDoc } from "./state.ts";

/**
 * Alpha-scope tool handlers.
 *
 * Full peer_spawn/stop/restart/compact live in v0.10.0-beta/rc.
 * Alpha ships a `peer_stop` stub sufficient to prove the request →
 * result → event pipeline end-to-end (designer acceptance criterion:
 * „peer_stop na neexistujícího peera → graceful error v results/").
 */

export interface HandlerContext {
  state: StateDoc;
  daemonVersion: string;
}

export type Handler = (req: RequestEnvelope, ctx: HandlerContext) => Promise<ResultEnvelope>;

async function handlePeerStop(req: RequestEnvelope, ctx: HandlerContext): Promise<ResultEnvelope> {
  const peer = String(req.args["peer"] ?? "");
  if (!peer) {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { reason: "missing_peer_arg" },
    });
    return errResult(req.id, req.tool, "missing_arg", "`peer` argument is required");
  }
  const record = ctx.state.peers[peer];
  if (!record) {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "info",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { peer, reason: "peer_not_found" },
    });
    return errResult(
      req.id,
      req.tool,
      "peer_not_found",
      `No peer with id/name '${peer}' in daemon state`,
      {
        peer,
      },
    );
  }
  // Alpha: full stop is intentionally deferred to beta. Emit a `stub` event
  // so the operator sees this happened but no process was actually killed.
  await writeEvent({
    event: "peer_stop_stub",
    level: "warn",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { peer, hostDriver: record.hostDriver, note: "full stop wired in v0.10.0-beta" },
  });
  return errResult(
    req.id,
    req.tool,
    "not_implemented_in_alpha",
    "peer_stop is a stub in v0.10.0-alpha; full lifecycle implementation lands in v0.10.0-beta",
    { peer },
  );
}

async function handleControlStatus(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  return okResult(req.id, req.tool, {
    daemonVersion: ctx.daemonVersion,
    daemonStartedAt: ctx.state.daemonStartedAt,
    stateVersion: ctx.state.stateVersion,
    peerCount: Object.keys(ctx.state.peers).length,
  });
}

const HANDLERS: Record<string, Handler> = {
  peer_stop: handlePeerStop,
  control_status: handleControlStatus,
};

export async function dispatch(req: RequestEnvelope, ctx: HandlerContext): Promise<ResultEnvelope> {
  const handler = HANDLERS[req.tool];
  if (!handler) {
    await writeEvent({
      event: "request_unknown_tool",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { tool: req.tool },
    });
    return errResult(req.id, req.tool, "unknown_tool", `No handler for tool '${req.tool}'`, {
      supported: Object.keys(HANDLERS),
    });
  }
  return handler(req, ctx);
}

export function supportedTools(): string[] {
  return Object.keys(HANDLERS);
}

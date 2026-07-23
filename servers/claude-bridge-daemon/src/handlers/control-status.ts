import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";

export async function handleControlStatus(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  return okResult(req.id, req.tool, {
    daemonVersion: ctx.daemonVersion,
    daemonStartedAt: ctx.state.daemonStartedAt,
    stateVersion: ctx.state.stateVersion,
    peerCount: Object.keys(ctx.state.peers).length,
    hostDriver: ctx.hostDriver.name,
  });
}

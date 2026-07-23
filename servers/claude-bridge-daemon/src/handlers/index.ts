import { writeEvent } from "../events.ts";
import { errResult } from "../rpc.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { handleControlStatus } from "./control-status.ts";
import { handlePeerCompact } from "./peer-compact.ts";
import { handlePeerRestart } from "./peer-restart.ts";
import { handlePeerSpawn } from "./peer-spawn.ts";
import { handlePeerStop } from "./peer-stop.ts";
import { handleTeamLayout } from "./team-layout.ts";
import { handleTeamStatus } from "./team-status.ts";

export type { HandlerContext } from "./context.ts";
export { applyStateChange } from "./state-writer.ts";

export type Handler = (req: RequestEnvelope, ctx: HandlerContext) => Promise<ResultEnvelope>;

const HANDLERS: Record<string, Handler> = {
  peer_spawn: handlePeerSpawn,
  peer_stop: handlePeerStop,
  peer_restart: handlePeerRestart,
  peer_compact: handlePeerCompact,
  team_status: handleTeamStatus,
  team_layout: handleTeamLayout,
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

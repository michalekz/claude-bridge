import { z } from "zod";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";

/**
 * team_status — read-only view over `state.peers` and the host driver.
 *
 * Beta scope: peer inventory + host-driver liveness check. Telemetry
 * (context %, rate limits, last activity) is F2 — that's where the
 * daemon starts writing `control/telemetry/<sessionId>.json` and the
 * plugin's `peer_context_status` starts reading it as the top-priority
 * source.
 */

export const TeamStatusArgsSchema = z
  .object({
    team: z.string().optional(),
    verbose: z.boolean().default(false),
  })
  .strict();

export type TeamStatusArgs = z.infer<typeof TeamStatusArgsSchema>;

export async function handleTeamStatus(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = TeamStatusArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;

  let hostSessions: Awaited<ReturnType<HandlerContext["hostDriver"]["listSessions"]>>;
  try {
    hostSessions = await ctx.hostDriver.listSessions();
  } catch (e) {
    hostSessions = [];
    void e;
  }
  const hostByKey = new Map(hostSessions.map((s) => [s.sessionKey, s]));

  const peers = Object.values(ctx.state.peers).map((record) => {
    const key = record.tmuxTarget ?? record.name;
    const host = hostByKey.get(key);
    return {
      sessionId: record.sessionId,
      name: record.name,
      hostDriver: record.hostDriver,
      tmuxTarget: record.tmuxTarget,
      status: record.status,
      model: record.model,
      accountProfile: record.accountProfile,
      pid: record.pid,
      startedAt: record.startedAt,
      lastUpdatedAt: record.lastUpdatedAt,
      hostAlive: host !== undefined,
      hostPid: host?.pid ?? null,
    };
  });

  return okResult(req.id, req.tool, {
    daemonVersion: ctx.daemonVersion,
    hostDriver: ctx.hostDriver.name,
    team: args.team ?? null,
    peerCount: peers.length,
    peers: args.verbose
      ? peers
      : peers.map(({ sessionId, name, status, hostAlive }) => ({
          sessionId,
          name,
          status,
          hostAlive,
        })),
  });
}

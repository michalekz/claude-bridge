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
    /**
     * NOT IMPLEMENTED, and REFUSED rather than ignored (R3, v0.11.21).
     *
     * The schema accepted it, the response echoed it back, and `peers` held the
     * whole fleet. A caller asking for team `ai` got `team: "ai"` next to all
     * twenty-six peers — an answer that LOOKS filtered. The description
     * admitted it, which does not help: a reader trusts the shape of the reply,
     * not the paragraph about it.
     *
     * An argument that is accepted, echoed and ignored is worse than one that
     * is refused. Kept in the schema (rather than dropped, or typed `never`)
     * only so the refusal can say something an operator can act on — `Expected
     * never, received string` is not that sentence.
     */
    team: z.string().min(1).optional(),
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
  if (args.team !== undefined) {
    return errResult(
      req.id,
      req.tool,
      "not_implemented",
      "filtering by team is not implemented; omit `team` and read `peers[].team` instead. " +
        "Until v0.11.21 this argument was accepted and silently ignored, so a filtered-looking " +
        "answer contained the whole fleet.",
      { requested: args.team },
    );
  }

  let hostSessions: Awaited<ReturnType<HandlerContext["hostDriver"]["listSessions"]>>;
  try {
    hostSessions = await ctx.hostDriver.listSessions();
  } catch (e) {
    hostSessions = [];
    void e;
  }
  // Window-keyed records (`@42`) are invisible to `listSessions`, which only
  // reports tmux SESSIONS. Every adopted peer therefore read `hostAlive: false`
  // while its process and its window were both plainly there (plt-designer,
  // v0.10.7 re-pilot, finding I). Fold the windows in.
  let hostWindows: Array<{ target: string; pid: number | null }> = [];
  try {
    hostWindows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
  } catch {
    hostWindows = [];
  }
  const hostByKey = new Map<string, { sessionKey: string; pid: number | null }>(
    hostSessions.map((s) => [s.sessionKey, { sessionKey: s.sessionKey, pid: s.pid }]),
  );
  for (const w of hostWindows) {
    if (!hostByKey.has(w.target)) hostByKey.set(w.target, { sessionKey: w.target, pid: w.pid });
  }

  const peers = Object.values(ctx.state.peers).map((record) => {
    const key = record.observed.tmuxTarget ?? record.observed.name;
    const host = hostByKey.get(key);
    return {
      // The HANDLE, not the peer's session identity (v0.11.16, defect N4). It
      // is how you address this peer and it is the registry key; whether it
      // also happens to BE the session id is answered by `identity` below.
      sessionId: record.handle,
      name: record.observed.name,
      hostDriver: record.observed.hostDriver,
      tmuxTarget: record.observed.tmuxTarget,
      status: record.observed.status,
      // The measured Claude session id, and how much of a claim it is.
      // `unknown` means the process is RUNNING and we cannot yet say who it is
      // — a live peer, not a dead one, and never to be shown as the latter.
      measuredSessionId: record.observed.sessionId ?? null,
      identity: record.observed.identity ?? null,
      model: record.observed.model,
      accountProfile: record.desired.accountProfile,
      pid: record.observed.pid,
      startedAt: record.observed.startedAt,
      lastUpdatedAt: record.observed.lastUpdatedAt,
      hostAlive: host !== undefined,
      hostPid: host?.pid ?? null,
    };
  });

  return okResult(req.id, req.tool, {
    daemonVersion: ctx.daemonVersion,
    hostDriver: ctx.hostDriver.name,
    // Always null now that the argument is refused. Kept so the response shape
    // does not change under a caller that never passed it.
    team: null,
    peerCount: peers.length,
    peers: args.verbose
      ? peers
      : peers.map(({ sessionId, name, status, hostAlive, identity }) => ({
          sessionId,
          name,
          status,
          // Surfaced even in the compact listing: a peer whose identity is
          // unknown cannot be cross-referenced with peer_list, and finding that
          // out from a `verbose` flag is finding it out too late.
          ...(identity === "unknown" ? { identity } : {}),
          hostAlive,
        })),
  });
}

import { z } from "zod";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { PeerRecord } from "../state.ts";
import type { HandlerContext } from "./context.ts";
import { type PeerRefCandidate, ambiguousPeerMessage, resolvePeerRef } from "./peer-ref.ts";
import { applyStateChange } from "./state-writer.ts";

/**
 * team_release — drop a peer from daemon state WITHOUT touching the process.
 *
 * The undo for adoption. `team_adopt` takes over peers the daemon did not
 * start; when it takes over the wrong one — a mismapped session id, a window
 * that turned out to belong to someone else — there has so far been no way
 * back that does not kill a running peer. `peer_stop` removes the record by
 * stopping the work, which is the wrong price for a bookkeeping mistake.
 *
 * So this is deliberately a STATE-ONLY operation: the record goes, the process
 * stays, and the peer carries on exactly as it did before the daemon ever
 * noticed it. Anything that kills belongs in `peer_stop` or the future
 * `team_remove`, never here — the whole value of this tool is that it cannot.
 *
 * `dryRun` defaults to TRUE, like `team_adopt`. Releasing is cheap to redo but
 * the plan is worth reading first: the count and the names are how an operator
 * catches "I meant the other team" before it happens.
 */

export const TeamReleaseArgsSchema = z
  .object({
    /** Release these peers by sessionId or name. Mutually exclusive with `team`. */
    peers: z.array(z.string().min(1)).optional(),
    /** Release every peer recorded under this team. Mutually exclusive with `peers`. */
    team: z.string().min(1).optional(),
    reason: z.string().optional(),
    dryRun: z.boolean().default(true),
  })
  .strict()
  .refine((a) => (a.peers === undefined) !== (a.team === undefined), {
    message: "pass exactly one of `peers` or `team`",
  });

export type TeamReleaseArgs = z.infer<typeof TeamReleaseArgsSchema>;

interface ReleasePlanEntry {
  sessionId: string;
  name: string;
  status: PeerRecord["observed"]["status"];
  team: string | null;
  pid: number | null;
  tmuxTarget: string | null;
  adopted: boolean;
}

function describe(rec: PeerRecord): ReleasePlanEntry {
  return {
    sessionId: rec.sessionId,
    name: rec.observed.name,
    status: rec.observed.status,
    team: rec.desired.team ?? null,
    pid: rec.observed.pid,
    tmuxTarget: rec.observed.tmuxTarget,
    adopted: rec.observed.adopted ?? false,
  };
}

/** The team of whoever sent this request — the search domain for short names. */
function callerTeamOf(req: RequestEnvelope, ctx: HandlerContext): string | null {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}

export async function handleTeamRelease(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = TeamReleaseArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;

  const found: PeerRecord[] = [];
  const notFound: string[] = [];
  const ambiguous: Array<{ ref: string; candidates: PeerRefCandidate[] }> = [];

  if (args.team !== undefined) {
    for (const rec of Object.values(ctx.state.peers)) {
      if (rec.desired.team === args.team) found.push(rec);
    }
    if (ambiguous.length > 0) {
      // Refuse the whole call. Releasing the wrong `velitel` hands a peer that
      // is still running back to nobody's control, which is silent and hard to
      // notice — exactly the outcome guessing produces.
      return errResult(
        req.id,
        req.tool,
        "ambiguous_peer",
        ambiguous.map((a) => ambiguousPeerMessage(a.ref, a.candidates)).join(" | "),
        { ambiguous },
      );
    }
    if (found.length === 0) {
      return errResult(
        req.id,
        req.tool,
        "team_not_found",
        `No peers recorded under team '${args.team}'`,
        {
          team: args.team,
          knownTeams: [
            ...new Set(Object.values(ctx.state.peers).map((p) => p.desired.team ?? "(none)")),
          ],
        },
      );
    }
  } else {
    for (const key of args.peers ?? []) {
      const resolved = resolvePeerRef(ctx.state.peers, key, callerTeamOf(req, ctx));
      if (resolved.kind === "ambiguous") {
        ambiguous.push({ ref: key, candidates: resolved.candidates });
        continue;
      }
      const rec = resolved.kind === "found" ? resolved.record : null;
      if (!rec) {
        notFound.push(key);
        continue;
      }
      // Releasing the same peer twice in one call is harmless, but reporting it
      // twice would overstate what happened.
      if (!found.some((f) => f.sessionId === rec.sessionId)) found.push(rec);
    }
    if (found.length === 0) {
      return errResult(
        req.id,
        req.tool,
        "peer_not_found",
        `None of the requested peers are in daemon state: ${notFound.join(", ")}`,
        { notFound, known: Object.keys(ctx.state.peers) },
      );
    }
  }

  const plan = {
    dryRun: args.dryRun,
    reason: args.reason ?? null,
    releasing: found.map(describe),
    notFound,
    // Said explicitly, because the entire point of this tool is what it does
    // NOT do, and an operator reading a plan should not have to infer it.
    processesAffected: 0,
    note: "State-only. No process is signalled, no host session or window is touched.",
  };

  if (args.dryRun) {
    await writeEvent({
      event: "team_release_preview",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: plan,
    });
    return okResult(req.id, req.tool, plan);
  }

  await applyStateChange(ctx.state, (draft) => {
    for (const rec of found) delete draft.peers[rec.sessionId];
  });

  for (const rec of found) {
    await writeEvent({
      event: "peer_released",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: rec.sessionId,
        name: rec.observed.name,
        team: rec.desired.team ?? null,
        pid: rec.observed.pid,
        tmuxTarget: rec.observed.tmuxTarget,
        adopted: rec.observed.adopted ?? false,
        statusAtRelease: rec.observed.status,
        reason: args.reason ?? null,
        // The audit trail has to record that the process outlived the record,
        // or a later reader will assume a release was a stop.
        processLeftRunning: true,
      },
    });
  }

  return okResult(req.id, req.tool, {
    ...plan,
    dryRun: false,
    released: found.map((r) => r.sessionId),
  });
}

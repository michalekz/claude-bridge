import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, controlDir, teamsDir } from "@claude-bridge/shared";
import { z } from "zod";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";
import { handlePeerSpawn } from "./peer-spawn.ts";
import { handlePeerStop } from "./peer-stop.ts";

/**
 * team_layout — declarative team spec reconciled against `state.peers`.
 *
 * Team file: `~/.claude-bridge/control/teams/<team>.json`
 *   {
 *     "team": "hmh",
 *     "peers": [
 *       { "sessionId": "…", "displayName": "hmh-memory-keeper",
 *         "cwd": "/opt/hmh", "command": "claude", "args": [],
 *         "model": null, "resume": true }
 *     ]
 *   }
 *
 * Modes:
 *   - `apply` (default) — spawn every peer in the spec that isn't
 *     currently live. Extras (in state.peers, not in spec) are left
 *     alone.
 *   - `prune: true` — also stop the extras. Default safe = keep them.
 *
 * Every reconcile emits `team_layout_applied` with the full diff for
 * the audit trail.
 */

const PeerSpecSchema = z.object({
  sessionId: z.string().min(1),
  displayName: z.string().min(1),
  cwd: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  resume: z.boolean().default(false),
  model: z.string().nullable().optional(),
  accountProfile: z.string().nullable().optional(),
  extraAllowEnv: z.array(z.string()).default([]),
  extraEnv: z.record(z.string()).default({}),
});

const TeamFileSchema = z.object({
  team: z.string().min(1),
  peers: z.array(PeerSpecSchema),
});

export type PeerSpec = z.infer<typeof PeerSpecSchema>;
export type TeamFile = z.infer<typeof TeamFileSchema>;

export const TeamLayoutArgsSchema = z
  .object({
    team: z.string().min(1),
    apply: z.boolean().default(true),
    prune: z.boolean().default(false),
    /**
     * Explicit team spec — bypasses the on-disk file. Used by tests
     * and by future callers who want to preview a spec before writing
     * it to teams/.
     */
    inline: TeamFileSchema.optional(),
  })
  .strict();

export type TeamLayoutArgs = z.infer<typeof TeamLayoutArgsSchema>;

function teamFilePath(team: string): string {
  return join(teamsDir(), `${team}.json`);
}

async function loadTeamSpec(team: string): Promise<TeamFile | null> {
  try {
    const raw = await readFile(teamFilePath(team), "utf-8");
    const parsed = TeamFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`Team spec parse failed: ${parsed.error.message}`);
    return parsed.data;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw e;
  }
}

export async function handleTeamLayout(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = TeamLayoutArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  let spec: TeamFile | null;
  try {
    spec = args.inline ?? (await loadTeamSpec(args.team));
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
      {
        team: args.team,
      },
    );
  }

  const specIds = new Set(spec.peers.map((p) => p.sessionId));
  const stateIds = new Set(Object.keys(ctx.state.peers));
  const toSpawn = spec.peers.filter((p) => !stateIds.has(p.sessionId));
  const toStop = [...stateIds].filter((id) => !specIds.has(id));

  const diff = {
    team: spec.team,
    plannedSpawn: toSpawn.map((p) => p.sessionId),
    plannedStop: args.prune ? toStop : [],
    keptExtras: args.prune ? [] : toStop,
  };
  await writeEvent({
    event: "team_layout_reconciling",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { ...diff, apply: args.apply, prune: args.prune },
  });

  if (!args.apply) {
    return okResult(req.id, req.tool, { mode: "plan", diff });
  }

  const spawnedOk: string[] = [];
  const spawnedFailed: Array<{ sessionId: string; err: string }> = [];
  for (const p of toSpawn) {
    const spawnReq = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:spawn:${p.sessionId}`,
      ts: req.ts,
      tool: "peer_spawn",
      args: {
        sessionId: p.sessionId,
        displayName: p.displayName,
        cwd: p.cwd,
        command: p.command,
        args: p.args,
        resume: p.resume,
        model: p.model ?? null,
        accountProfile: p.accountProfile ?? null,
        extraAllowEnv: p.extraAllowEnv,
        extraEnv: p.extraEnv,
      },
      requestedBy: req.requestedBy,
    };
    const res = await handlePeerSpawn(spawnReq, ctx);
    if (res.outcome === "ok") {
      spawnedOk.push(p.sessionId);
    } else {
      spawnedFailed.push({
        sessionId: p.sessionId,
        err: res.error?.message ?? "unknown",
      });
    }
  }

  const stoppedOk: string[] = [];
  const stoppedFailed: Array<{ sessionId: string; err: string }> = [];
  if (args.prune) {
    for (const id of toStop) {
      const stopReq = {
        schemaVersion: req.schemaVersion,
        id: `${req.id}:stop:${id}`,
        ts: req.ts,
        tool: "peer_stop",
        args: { peer: id, reason: `team_layout_prune:${spec.team}` },
        requestedBy: req.requestedBy,
      };
      const res = await handlePeerStop(stopReq, ctx);
      if (res.outcome === "ok") stoppedOk.push(id);
      else stoppedFailed.push({ sessionId: id, err: res.error?.message ?? "unknown" });
    }
  }

  await writeEvent({
    event: "team_layout_applied",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      team: spec.team,
      spawnedOk,
      spawnedFailed,
      stoppedOk,
      stoppedFailed,
      keptExtras: diff.keptExtras,
    },
  });

  const failed = spawnedFailed.length > 0 || stoppedFailed.length > 0;
  const result = {
    team: spec.team,
    spawnedOk,
    spawnedFailed,
    stoppedOk,
    stoppedFailed,
    keptExtras: diff.keptExtras,
  };
  if (failed) {
    return errResult(
      req.id,
      req.tool,
      "team_layout_partial_failure",
      "Some peers could not be reconciled — see failed lists",
      result,
    );
  }
  return okResult(req.id, req.tool, result);
}

/** For tests + a future `team_layout write` MCP tool. */
export async function persistTeamSpec(team: string, spec: TeamFile): Promise<void> {
  const dir = teamsDir();
  await atomicWriteJson(join(dir, `${team}.json`), spec);
}

/** Ensure controlDir is used for typechecking (silence bundler). */
void controlDir;

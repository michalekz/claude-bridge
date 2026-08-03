import { z } from "zod";
import { writeEvent } from "../events.ts";
import { sanitizeSessionKey } from "../hosts/driver.ts";
import { type ProcessRecord, defaultProcessInspector } from "../hosts/process-inspector.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { PeerHostDriver, PeerRecord } from "../state.ts";
import type { HandlerContext } from "./context.ts";
import { applyStateChange } from "./state-writer.ts";

/**
 * team_adopt — take ownership of peers the daemon did not spawn (§5.2, v0.10.1).
 *
 * Motivating case, from the velitel's report of 2026-07-25 16:54: the HMH team
 * is launched by `start_peer.sh` (tmux + `claude --resume`), so `state.peers`
 * was empty while the bridge registry listed eleven live peers. `peer_compact`
 * on one of them returned `peer_not_found`, and the only fallback was an
 * unaudited manual `tmux send-keys`. Adoption puts existing peers under daemon
 * control without restarting them.
 *
 * Two modes:
 *   - `auto`   — walk the host's sessions, find the Claude process inside each
 *                and read its session id.
 *   - `manual` — caller supplies `{ sessionKey: sessionId }` explicitly, for
 *                when discovery cannot see the process (non-Linux host) or got
 *                it wrong.
 *
 * **`dryRun` defaults to TRUE.** Adoption writes foreign processes into daemon
 * state, so the safe call is the default and taking real ownership requires
 * `dryRun: false` spelled out. (A GO-registry gate per §11 lands in F2; until
 * then the explicit opt-out plus the `requestedBy` recorded on every event is
 * the control.)
 */

export const TeamAdoptArgsSchema = z
  .object({
    team: z.string().min(1),
    mode: z.enum(["auto", "manual"]).default("auto"),
    /** manual mode: host session key -> Claude session id. */
    mapping: z.record(z.string().min(1)).optional(),
    /** Safe by default — see the note above. */
    dryRun: z.boolean().default(true),
  })
  .strict();

export type TeamAdoptArgs = z.infer<typeof TeamAdoptArgsSchema>;

interface AdoptionCandidate {
  sessionKey: string;
  sessionId: string;
  pid: number | null;
  sessionIdSource: ProcessRecord["sessionIdSource"] | "manual";
}

interface AdoptionSkip {
  sessionKey: string;
  reason: "already_adopted" | "no_claude_process" | "no_session_id" | "not_on_host";
  details?: string;
}

interface AdoptionAmbiguity {
  sessionKey: string;
  candidates: Array<{ pid: number; sessionId: string | null }>;
}

/**
 * Pair host sessions with the Claude process running inside them.
 *
 * A tmux pane's own pid is usually the shell, with `claude` as its child, so
 * matching is done by walking each process's ancestry until it hits a known
 * pane pid — one hop in practice, but nesting (direnv, a wrapper script) is
 * cheap to tolerate and expensive to debug if we assume it away.
 */
async function discoverCandidates(
  ctx: HandlerContext,
  hostSessions: Array<{ sessionKey: string; pid: number | null }>,
): Promise<{
  candidates: AdoptionCandidate[];
  ambiguous: AdoptionAmbiguity[];
  skips: AdoptionSkip[];
}> {
  const inspector = ctx.processInspector ?? defaultProcessInspector();
  const peers = await inspector.listClaudePeers();

  // pid -> the host session whose pane owns it.
  const ownerBySessionKey = new Map<string, ProcessRecord[]>();
  for (const proc of peers) {
    const chain = [proc.pid, proc.ppid, ...(await inspector.ancestorsOf(proc.pid))];
    const owner = hostSessions.find((s) => s.pid !== null && chain.includes(s.pid));
    if (!owner) continue;
    const list = ownerBySessionKey.get(owner.sessionKey) ?? [];
    list.push(proc);
    ownerBySessionKey.set(owner.sessionKey, list);
  }

  const candidates: AdoptionCandidate[] = [];
  const ambiguous: AdoptionAmbiguity[] = [];
  const skips: AdoptionSkip[] = [];

  for (const session of hostSessions) {
    const procs = ownerBySessionKey.get(session.sessionKey) ?? [];
    if (procs.length === 0) {
      skips.push({ sessionKey: session.sessionKey, reason: "no_claude_process" });
      continue;
    }
    // More than one Claude process under a single pane is the duplicate-identity
    // failure mode from §6/11 — never guess which one is canonical.
    if (procs.length > 1) {
      ambiguous.push({
        sessionKey: session.sessionKey,
        candidates: procs.map((p) => ({ pid: p.pid, sessionId: p.sessionId })),
      });
      continue;
    }
    const proc = procs[0] as ProcessRecord;
    if (!proc.sessionId) {
      skips.push({
        sessionKey: session.sessionKey,
        reason: "no_session_id",
        details: `pid ${proc.pid} — neither ~/.claude/sessions/<pid>.json nor --resume yielded a UUID`,
      });
      continue;
    }
    candidates.push({
      sessionKey: session.sessionKey,
      sessionId: proc.sessionId,
      pid: proc.pid,
      sessionIdSource: proc.sessionIdSource,
    });
  }
  return { candidates, ambiguous, skips };
}

export async function handleTeamAdopt(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = TeamAdoptArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;

  if (args.mode === "manual" && !args.mapping) {
    return errResult(req.id, req.tool, "mapping_required", "mode:'manual' requires `mapping`", {
      team: args.team,
    });
  }

  const hostSessions = await ctx.hostDriver.listSessions();

  let candidates: AdoptionCandidate[] = [];
  let ambiguous: AdoptionAmbiguity[] = [];
  let skips: AdoptionSkip[] = [];

  if (args.mode === "manual") {
    for (const [rawKey, sessionId] of Object.entries(args.mapping ?? {})) {
      const sessionKey = sanitizeSessionKey(rawKey);
      const host = hostSessions.find((s) => s.sessionKey === sessionKey);
      if (!host) {
        skips.push({ sessionKey, reason: "not_on_host" });
        continue;
      }
      candidates.push({ sessionKey, sessionId, pid: host.pid, sessionIdSource: "manual" });
    }
  } else {
    const found = await discoverCandidates(ctx, hostSessions);
    candidates = found.candidates;
    ambiguous = found.ambiguous;
    skips = found.skips;
  }

  // Never re-adopt something the daemon already runs — that would overwrite a
  // live record (and its spawn provenance) with a guess.
  const fresh: AdoptionCandidate[] = [];
  for (const c of candidates) {
    const existing = ctx.state.peers[c.sessionId];
    if (existing && existing.status !== "stopped") {
      skips.push({
        sessionKey: c.sessionKey,
        reason: "already_adopted",
        details: `sessionId ${c.sessionId} already in state as '${existing.status}'`,
      });
      continue;
    }
    fresh.push(c);
  }

  for (const a of ambiguous) {
    await writeEvent({
      event: "adoption_ambiguous",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { team: args.team, sessionKey: a.sessionKey, candidates: a.candidates },
    });
  }

  const plan = {
    team: args.team,
    mode: args.mode,
    planned: fresh.map((c) => ({
      sessionKey: c.sessionKey,
      sessionId: c.sessionId,
      pid: c.pid,
      sessionIdSource: c.sessionIdSource,
    })),
    ambiguous,
    skipped: skips,
  };

  if (args.dryRun) {
    await writeEvent({
      event: "team_adopt_preview",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: plan,
    });
    // `mode` already means auto|manual, so the preview marker gets its own
    // field rather than shadowing it.
    return okResult(req.id, req.tool, { dryRun: true, ...plan });
  }

  const hostDriverName = ctx.hostDriver.name as PeerHostDriver;
  const adopted: string[] = [];
  for (const c of fresh) {
    const now = new Date().toISOString();
    await applyStateChange(ctx.state, (draft) => {
      draft.peers[c.sessionId] = {
        sessionId: c.sessionId,
        name: c.sessionKey,
        hostDriver: hostDriverName,
        tmuxTarget: c.sessionKey,
        pid: c.pid,
        status: "live",
        team: args.team,
        // Flags that the daemon did not start this process: `startedAt` is
        // when we adopted it, not when it actually booted.
        adopted: true,
        model: null,
        accountProfile: null,
        startedAt: now,
        lastUpdatedAt: now,
      } satisfies PeerRecord;
    });
    await writeEvent({
      event: "peer_adopted",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        team: args.team,
        sessionId: c.sessionId,
        sessionKey: c.sessionKey,
        pid: c.pid,
        sessionIdSource: c.sessionIdSource,
        hostDriver: hostDriverName,
      },
    });
    adopted.push(c.sessionId);
  }

  const summary = {
    dryRun: false,
    team: args.team,
    mode: args.mode,
    adopted,
    ambiguous,
    skipped: skips,
  };
  await writeEvent({
    event: "team_adopt_completed",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: summary,
  });
  return okResult(req.id, req.tool, summary);
}

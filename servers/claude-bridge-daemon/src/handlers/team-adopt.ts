import { z } from "zod";
import { writeEvent } from "../events.ts";
import { formatHostTarget, parseHostTarget, sanitizeSessionKey } from "../hosts/driver.ts";
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
  /** Human-readable name — window name or `session:index`. Never the address. */
  label?: string;
  /** Read from /proc so the adopted record can be restarted (2026-08-04). */
  command?: string;
  spawnArgs?: string[];
  cwd?: string;
}

interface AdoptionSkip {
  sessionKey: string;
  reason: "already_adopted" | "no_claude_process" | "no_session_id" | "not_on_host";
  details?: string;
}

/**
 * Drop the flags `peer_spawn` adds back on its own.
 *
 * A running peer's argv already contains `--resume <uuid>` and possibly
 * `--model <m>`, because that is how it was started. Storing them and then
 * letting peer_spawn append its own would hand tmux two of each.
 */
export function stripReappendedArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resume" || a === "--model") {
      i++; // skip its value too
      continue;
    }
    if (a !== undefined) out.push(a);
  }
  return out;
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
  hostSessions: Array<{ sessionKey: string; label: string; pid: number | null }>,
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
    // Launch parameters come from /proc, the way a replay script reads them.
    // Without them an adopted record has no `command`/`spawnArgs`/`cwd`, and
    // the first daemon-issued peer_restart falls back to a bare `claude` —
    // which resolves to nothing under nvm. Adoption would look complete while
    // the control layer was unusable at the exact moment it was first needed
    // (raised by plt-designer, 2026-08-04).
    const [command, ...rest] = proc.argv;
    candidates.push({
      sessionKey: session.sessionKey,
      label: session.label,
      sessionId: proc.sessionId,
      pid: proc.pid,
      sessionIdSource: proc.sessionIdSource,
      ...(command ? { command } : {}),
      // `--resume <id>` and `--model <m>` are re-appended by peer_spawn, so
      // strip them here or the next restart would carry them twice.
      spawnArgs: stripReappendedArgs(rest),
      ...(proc.cwd ? { cwd: proc.cwd } : {}),
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

  // Enumerate WINDOWS, not sessions (fix, 2026-08-04).
  //
  // `listSessions()` reports `#{pane_pid}` per tmux SESSION — the active pane
  // of the active window, one pid however many windows the session holds. The
  // fleet runs one peer per window: four sessions, twenty-three windows. So
  // adoption saw four candidates, reported `ambiguous: []` because each session
  // had produced exactly one process, and never mentioned the nineteen windows
  // it had not looked at. The plan was not incomplete on purpose; it did not
  // know there was anything else to find.
  const windows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
  // `sessionKey` is the ADDRESS (a `@id` for a window, a name for a session);
  // `label` is what a human reads in the plan and what the peer gets named.
  const hostSessions: Array<{ sessionKey: string; label: string; pid: number | null }> =
    windows.length > 0
      ? windows.map((w) => ({
          sessionKey: w.target,
          label: w.windowName || w.label,
          pid: w.pid,
        }))
      : (await ctx.hostDriver.listSessions()).map((s) => ({
          sessionKey: s.sessionKey,
          label: s.sessionKey,
          pid: s.pid,
        }));

  let candidates: AdoptionCandidate[] = [];
  let ambiguous: AdoptionAmbiguity[] = [];
  let skips: AdoptionSkip[] = [];

  if (args.mode === "manual") {
    for (const [rawKey, sessionId] of Object.entries(args.mapping ?? {})) {
      // A mapping key may name a whole session or one window. Since discovery
      // now enumerates windows, a bare session name has to be resolved — and a
      // session holding several windows is ambiguous, not a free choice. On
      // this fleet `hmh` means seven peers; picking one would adopt an
      // arbitrary peer under the operator's chosen identity.
      // A mapping key may be a window id (`@42`), a `session:index` label, or a
      // bare session name. A session holding several windows is ambiguous, not
      // a free choice: on this fleet `hmh` means seven peers, and picking one
      // would adopt an arbitrary peer under the operator's chosen identity.
      const target = parseHostTarget(rawKey);
      const sessionKey = formatHostTarget(target);
      // Address first, then the human-facing forms: `session:index` label or
      // window name.
      const byLabel = windows.find((w) => w.label === rawKey || w.windowName === rawKey);
      let host =
        hostSessions.find((s) => s.sessionKey === sessionKey) ??
        (byLabel
          ? {
              sessionKey: byLabel.target,
              label: byLabel.windowName || byLabel.label,
              pid: byLabel.pid,
            }
          : undefined);
      if (!host && target.kind === "session") {
        const inSession = windows.filter((w) => w.session === sessionKey);
        if (inSession.length > 1) {
          ambiguous.push({
            sessionKey,
            candidates: inSession.map((w) => ({ pid: w.pid ?? -1, sessionId: null })),
          });
          continue;
        }
        const only = inSession[0];
        host = only
          ? { sessionKey: only.target, label: only.windowName || only.label, pid: only.pid }
          : hostSessions.find((s) => s.sessionKey === sessionKey);
      }
      if (!host) {
        skips.push({ sessionKey, reason: "not_on_host" });
        continue;
      }
      const procs = await ctx.processInspector?.listClaudePeers();
      const owning = procs?.find((pr) => pr.pid === host.pid);
      const [manualCommand, ...manualRest] = owning?.argv ?? [];
      candidates.push({
        sessionKey: host.sessionKey,
        label: host.label,
        sessionId,
        pid: host.pid,
        sessionIdSource: "manual",
        ...(manualCommand ? { command: manualCommand } : {}),
        spawnArgs: stripReappendedArgs(manualRest),
        ...(owning?.cwd ? { cwd: owning.cwd } : {}),
      });
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
    hostWindowsSeen: hostSessions.length,
    planned: fresh.map((c) => ({
      sessionKey: c.sessionKey,
      label: c.label ?? c.sessionKey,
      sessionId: c.sessionId,
      pid: c.pid,
      sessionIdSource: c.sessionIdSource,
      // Shown in the plan so a dry run can prove the record will be
      // restartable BEFORE anything is written.
      command: c.command ?? null,
      spawnArgs: c.spawnArgs ?? [],
      cwd: c.cwd ?? null,
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
        name: c.label ?? c.sessionKey,
        hostDriver: hostDriverName,
        tmuxTarget: c.sessionKey,
        pid: c.pid,
        status: "live",
        team: args.team,
        // Flags that the daemon did not start this process: `startedAt` is
        // when we adopted it, not when it actually booted.
        adopted: true,
        // Carried from /proc so an adopted peer is restartable. Without these
        // the record is a name with no way to relaunch what it names.
        ...(c.command ? { command: c.command } : {}),
        ...(c.spawnArgs ? { spawnArgs: c.spawnArgs } : {}),
        ...(c.cwd ? { cwd: c.cwd } : {}),
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

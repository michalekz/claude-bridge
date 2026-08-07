import { z } from "zod";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { PeerDesired, PeerRecord } from "../state.ts";
import type { HandlerContext } from "./context.ts";
import { ambiguousPeerMessage, resolvePeerRef } from "./peer-ref.ts";
import { applyStateChange } from "./state-writer.ts";

/**
 * control_config — read and write DECLARED intent. One tool, not N.
 *
 * Zdeněk, 2026-08-05: "ať nevymýšlí N dalších nástrojů do MCP, máme jich dost."
 * The constraint is the design. A control plane accumulates one setter per
 * knob if you let it, and each one arrives with its own validation, its own
 * error vocabulary and its own idea of what a dry run means. This is the single
 * front door for the knobs the daemon owns.
 *
 * Named for `control_status` rather than `peer_config`: the two are a pair —
 * status reads what IS, config reads and writes what SHOULD BE — and the scope
 * is not only peers.
 *
 * What it deliberately does NOT do:
 *
 *   - Nothing destructive. `peer_stop`, `peer_restart` and `team_stop` stay
 *     where they are. A tool that can both rename a window and kill a fleet is
 *     a tool whose dry-run flag has to be right every single time.
 *   - Nothing to the world. It writes `desired` and records the request; the
 *     window is not moved and no keys are injected. Reconcile REPORTS the gap
 *     (see `windowIndex`), and closing it lands in v0.11.1 behind an explicit
 *     opt-in. Writing intent and enacting it are separate powers, and this
 *     release only grants the first.
 */

/**
 * The keys an operator may declare, and nothing else.
 *
 * A whitelist rather than "anything in PeerDesired" because the two differ on
 * purpose: `cwd`, `command` and `spawnArgs` are intent too, but they were
 * captured from a live process at adopt time and editing them by hand is how a
 * peer becomes unrestartable. They stay readable and are not settable here.
 *
 * ⚠ DO NOT ADD THE GUARD KEYS HERE BEFORE THE WRITE PATHS ARE UNIFIED.
 *
 * `contextGuard`, `notification` and `rateLimitGuard` look like they belong —
 * they are per-peer configuration and the spec lists them for this tool. They
 * do not belong yet. Those three are owned by `peer_set_context_guard`,
 * `peer_set_notification` and `peer_set_rate_limit_guard`, which live in the
 * MCP package and write to the BRIDGE REGISTRY, not to daemon state. Adding
 * them here without first unifying the write path would give one field two
 * writers backed by two different stores — which is the founding defect of this
 * entire campaign, reintroduced by the release meant to end it.
 *
 * The unification was planned for v0.11.1 and did not land there — that release
 * was spent on two defects found in the v0.11.0 roll. The keys arrive WITH the
 * unification, whichever release carries it, and not one release earlier. The
 * condition is on the work, not on a version number, precisely so that a
 * slipped number cannot be read as permission. (Attached to the v0.11.0 commit
 * approval, 2026-08-06 — written here rather than in a meeting note so that
 * whoever reaches for the obvious completion in a month reads the reason.)
 */
const PEER_SETTABLE = ["label", "windowIndex", "model", "accountProfile"] as const;

const PeerSetSchema = z
  .object({
    label: z.string().min(1).max(64).optional(),
    // A window position is an index, not an opinion. Negative is meaningless
    // and a huge value is a typo, not a request.
    windowIndex: z.number().int().min(0).max(999).optional(),
    model: z.string().min(1).nullable().optional(),
    accountProfile: z.string().min(1).nullable().optional(),
    /**
     * `team` is NOT here, and its absence is the decision.
     *
     * It looks like a field and behaves like an operation. Declaring a new team
     * would leave the record inconsistent in three places at once, none of
     * which this tool can fix:
     *
     *   - `homeSession` still names the OLD team, so the next restart puts the
     *     peer back in the old tmux session
     *   - the tmux window does not move
     *   - the derived label stops matching — `mic-tester` in team `plt` has no
     *     prefix to strip, so it falls back to the fully qualified name, which
     *     is the exact regression v0.11.2 spent a release cleaning up
     *
     * Moving a peer between teams is lifecycle work (window, home session,
     * label), and lifecycle work belongs to `team_adopt` / `team_release` or a
     * future `peer_move`. Ratified with ai-designer 2026-08-06 as part of the
     * edge-test matrix (case A6, previously "behaviour undefined").
     */
  })
  .strict();

export const ControlConfigArgsSchema = z
  .object({
    /** Peer to read or write. Resolved by id, full name, or short name in the caller's team. */
    peer: z.string().min(1).optional(),
    /** Read every peer of this team. Read-only — bulk writes are not this tool's job. */
    team: z.string().min(1).optional(),
    /** Omit to read. Present to declare. */
    set: PeerSetSchema.optional(),
    /**
     * Withdraw a declaration, returning the key to "nobody has said".
     *
     * A separate list rather than `set: {windowIndex: null}`, because those are
     * two different statements and the drift report depends on telling them
     * apart: an UNDECLARED windowIndex reports no drift no matter where the
     * window sits, while a declared one that disagrees with reality does.
     * Overloading null would fold "no opinion" into "an opinion whose value is
     * empty" — the same conflation, one level up, that this release exists to
     * undo (#80).
     */
    unset: z.array(z.enum(PEER_SETTABLE)).nonempty().optional(),
    /**
     * Preview without writing.
     *
     * Present on every call rather than only the dangerous ones: a caller
     * should never have to remember WHICH operations honour it.
     */
    dryRun: z.boolean().default(false),
    reason: z.string().optional(),
  })
  .strict()
  .refine((a) => !(a.peer !== undefined && a.team !== undefined), {
    message: "pass `peer` or `team`, not both",
  })
  .refine((a) => !((a.set !== undefined || a.unset !== undefined) && a.peer === undefined), {
    message:
      "`set`/`unset` require `peer` — declaring intent for a whole team at once is not supported",
  })
  .refine(
    (a) =>
      !(a.set !== undefined && a.unset !== undefined && a.unset.some((k) => k in (a.set ?? {}))),
    { message: "the same key cannot be both set and unset in one call" },
  );

export type ControlConfigArgs = z.infer<typeof ControlConfigArgsSchema>;

/** What is declared, what is measured, and where the two disagree. */
export interface PeerConfigView {
  sessionId: string;
  name: string;
  desired: PeerDesired;
  observed: {
    windowIndex: number | null;
    model: string | null;
    status: string;
    tmuxTarget: string | null;
    harvestedAt: string | null;
  };
  drift: ConfigDrift[];
}

export interface ConfigDrift {
  field: string;
  desired: unknown;
  observed: unknown;
  /**
   * Both ways out, always both.
   *
   * A drift report that only offers "make the world match the registry" tells
   * an operator who deliberately dragged a window that they are wrong. Often
   * they are not — reality is the newer information, and `adopt` is how they
   * say so. Naming one path and not the other turns a question into an
   * instruction.
   */
  resolve: {
    assert: string;
    adopt: string;
  };
}

export function viewOf(record: PeerRecord): PeerConfigView {
  const drift: ConfigDrift[] = [];
  const dIdx = record.desired.windowIndex;
  const oIdx = record.observed.windowIndex;
  if (dIdx !== undefined && oIdx !== undefined && dIdx !== oIdx) {
    drift.push({
      field: "windowIndex",
      desired: dIdx,
      observed: oIdx,
      resolve: {
        assert: `move the window to index ${dIdx} (v0.11.1: reconcile --assert; today: tmux move-window)`,
        adopt: `accept reality — control_config peer:"${record.observed.name}" set:{windowIndex:${oIdx}}`,
      },
    });
  }
  const dModel = record.desired.model;
  const oModel = record.observed.model;
  if (dModel != null && oModel != null && dModel !== oModel) {
    drift.push({
      field: "model",
      desired: dModel,
      observed: oModel,
      resolve: {
        assert: `switch the peer to ${dModel} (v0.11.1: verified /model send)`,
        adopt: `accept reality — control_config peer:"${record.observed.name}" set:{model:"${oModel}"}`,
      },
    });
  }
  return {
    sessionId: record.sessionId,
    name: record.observed.name,
    desired: { ...record.desired },
    observed: {
      windowIndex: record.observed.windowIndex ?? null,
      model: record.observed.model,
      status: record.observed.status,
      tmuxTarget: record.observed.tmuxTarget,
      harvestedAt: record.observed.harvestedAt ?? null,
    },
    drift,
  };
}

/** The team of whoever sent this request — the search domain for short names. */
function callerTeamOf(req: RequestEnvelope, ctx: HandlerContext): string | null {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}

export async function handleControlConfig(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = ControlConfigArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;

  // Team read — a whole team's declared intent in one call.
  if (args.team !== undefined) {
    const members = Object.values(ctx.state.peers).filter((p) => p.desired.team === args.team);
    if (members.length === 0) {
      return errResult(req.id, req.tool, "team_not_found", `No peers under team '${args.team}'`, {
        team: args.team,
        knownTeams: [
          ...new Set(
            Object.values(ctx.state.peers)
              .map((p) => p.desired.team)
              .filter((t): t is string => t !== undefined),
          ),
        ],
      });
    }
    return okResult(req.id, req.tool, {
      team: args.team,
      settableKeys: PEER_SETTABLE,
      peers: members.map(viewOf),
    });
  }

  if (args.peer === undefined) {
    // Whole-fleet read. Cheap, and the only way to answer "who has drifted".
    return okResult(req.id, req.tool, {
      settableKeys: PEER_SETTABLE,
      peers: Object.values(ctx.state.peers).map(viewOf),
    });
  }

  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf(req, ctx));
  if (resolved.kind === "ambiguous") {
    return errResult(
      req.id,
      req.tool,
      "ambiguous_peer",
      ambiguousPeerMessage(args.peer, resolved.candidates),
      { peer: args.peer, candidates: resolved.candidates },
    );
  }
  if (resolved.kind !== "found") {
    return errResult(req.id, req.tool, "peer_not_found", `No peer '${args.peer}' in daemon state`, {
      peer: args.peer,
    });
  }
  const record = resolved.record;

  // ⚠ THERE IS NO LIVENESS CHECK HERE, AND THERE MUST NOT BE ONE.
  //
  // A peer whose window has died, whose process is gone, whose status reads
  // `unknown` — its record still accepts a declaration, and that is the whole
  // point of separating intent from measurement. What an operator wants a peer
  // to be does not stop being true because the peer is not currently running;
  // it is precisely what the next restart will replay.
  //
  // Written down because "config on a dead peer should fail" reads as an
  // obvious safety check to anyone who has not thought about the split, and
  // adding it would quietly re-couple the two halves this release exists to
  // separate. Ratified with ai-designer 2026-08-06 (edge case A11).
  //
  // Refusing IS right for anything that touches the world — see `peer_restart`,
  // `peer_compact`, `team_stop`. This tool touches only the registry.

  if (args.set === undefined && args.unset === undefined) {
    return okResult(req.id, req.tool, { settableKeys: PEER_SETTABLE, peer: viewOf(record) });
  }

  // A write always reports what it changed FROM. An operator reading only the
  // new value cannot tell a no-op from a correction.
  const changes: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const key of args.unset ?? []) {
    const from = (record.desired as Record<string, unknown>)[key];
    // Withdrawing something nobody declared is a no-op, not an error.
    if (from === undefined) continue;
    changes.push({ key, from, to: null });
  }
  for (const [key, to] of Object.entries(args.set ?? {})) {
    if (to === undefined) continue;
    const from = (record.desired as Record<string, unknown>)[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ key, from: from ?? null, to });
  }

  if (changes.length === 0) {
    return okResult(req.id, req.tool, {
      dryRun: args.dryRun,
      changed: [],
      note: "Every requested value already matches what is declared. Nothing written.",
      peer: viewOf(record),
    });
  }

  if (args.dryRun) {
    await writeEvent({
      event: "control_config_preview",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: record.sessionId, changes, reason: args.reason ?? null },
    });
    return okResult(req.id, req.tool, {
      dryRun: true,
      changed: changes,
      peer: viewOf(record),
      note: "Nothing written. Re-run without dryRun to declare these values.",
    });
  }

  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[record.sessionId];
    if (!rec) return;
    // Only `desired`. The measured half belongs to whatever measured it, and a
    // config tool that could write `observed` would let an operator declare a
    // peer to be alive.
    if (args.set) Object.assign(rec.desired, args.set);
    for (const key of args.unset ?? []) {
      // `delete`, not `= undefined`: the difference between "declared empty"
      // and "not declared" is the whole point, and only one of them survives
      // an `in` check.
      delete (rec.desired as Record<string, unknown>)[key];
    }
    rec.observed.lastUpdatedAt = new Date().toISOString();
  });

  await writeEvent({
    event: "control_config_set",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId: record.sessionId, changes, reason: args.reason ?? null },
  });

  const after = ctx.state.peers[record.sessionId];
  return okResult(req.id, req.tool, {
    dryRun: false,
    changed: changes,
    peer: after ? viewOf(after) : null,
    // Said plainly, because "I set windowIndex and nothing moved" is otherwise
    // read as a bug rather than as the documented boundary of this release.
    note: "Declared. Nothing in the world was changed — v0.11.0 records intent and reports drift; asserting it lands in v0.11.1.",
  });
}

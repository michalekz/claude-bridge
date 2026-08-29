import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveBaseUrl, restartWouldDropProxy } from "../base-url.ts";
import { readConfig } from "../config.ts";
import { writeEvent } from "../events.ts";
import { parseHostTarget } from "../hosts/driver.ts";
import { defaultProcessInspector } from "../hosts/process-inspector.ts";
import { pollUntil } from "../poll.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { PeerRecord } from "../state.ts";
import type { HandlerContext } from "./context.ts";
import { bridgeIdOf } from "./peer-identity.ts";
import { ambiguousPeerMessage, resolvePeerRef, unresolvedPeerError } from "./peer-ref.ts";
import { handlePeerSpawn } from "./peer-spawn.ts";
import { handlePeerStop } from "./peer-stop.ts";
import {
  DEFAULT_RESTART_READY_POLL_MS,
  DEFAULT_RESTART_READY_TIMEOUT_MS,
  requestRestartReady,
  restartAcks,
  restartThreadId,
} from "./restart-protocol.ts";
import { applyStateChange } from "./state-writer.ts";
import { RESTART_WAKE_PROMPT, wakePeer } from "./wake.ts";

/**
 * peer_restart — the owner's protocol a)–g), on top of the primitives.
 *
 *   a) decide and verify WHO is being restarted, and what will be resumed
 *   b) ask the peer to get ready, and wait for it to say it is
 *   c) stop it with the graceful primitive from v0.11.15
 *   d) the kill archives the pane (v0.11.13, in the driver's throat)
 *   e) relaunch it with its stored environment and its own transcript
 *   f) confirm the peer that came back is the peer that left
 *   g) tell it what happened, and why
 *
 * BREAKING in v0.11.18, and it is the same break `peer_stop` took in v0.11.15:
 * a restart now ASKS FIRST and can take minutes. Until this release it was a
 * hard kill followed by a spawn, and it said so in a comment where nobody
 * calling it would read it.
 *
 * WHAT THE MEASUREMENT CHANGED. Of the seven steps, d) and e) were already
 * done, c) existed as a primitive and was switched off by one pinned argument,
 * and a), b), f), g) were absent. But the finding that mattered was not in the
 * list: this handler passed the REGISTRY KEY to `--resume`. For a peer keyed by
 * a handle — which `team_layout` produces by design — that key names no
 * transcript, so `resume` came out false and the peer was relaunched EMPTY,
 * reported as a successful restart. Measured on the fleet 2026-08-08: 24 of 25
 * records were keyed by a genuine session id and one was not. The one is not
 * the point; the design that produces more of them is.
 *
 * Because we serialize requests in the queue, stop → spawn chains safely inside
 * a single request. What does NOT survive a crash between them is the operator's
 * knowledge of it — hence `observed.restartRequest`, written before each phase
 * and reported by `team_reconcile` as `restart_pending` if it is abandoned.
 */

export const PeerRestartArgsSchema = z
  .object({
    peer: z.string().min(1),
    reason: z.string().optional(),
    /**
     * Skip the asking — both of it: no ready-request, no stop courtesy.
     *
     * FORCE SKIPS WAITING, NEVER EVIDENCE. It does not skip the dead-pane
     * archive, the identity check after the relaunch, or step g) — and step g)
     * is the one that matters most here, because a peer that was never asked to
     * tidy up is the peer most likely to be holding a half-written anchor. It
     * gets told so.
     */
    force: z.boolean().default(false),
    /** How long the peer gets to say it is ready. Ignored when `force`. */
    readyTimeoutMs: z.number().int().positive().max(600_000).optional(),
    readyPollMs: z.number().int().positive().max(10_000).optional(),
    model: z.string().optional(),
    accountProfile: z.string().optional(),
  })
  .strict();

export type PeerRestartArgs = z.infer<typeof PeerRestartArgsSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this id something `claude --resume` can actually find?
 *
 * A transcript is named by a UUID. `peer_spawn` also accepts a stable name for
 * a fresh peer, and that name is not a transcript — resuming it lands in the
 * interactive picker instead of failing, which is worse than failing.
 */
export function isResumableSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId);
}

export interface LivenessCheck {
  ok: boolean;
  reason: string;
}

/**
 * Confirm the relaunched process is still alive, and that a resumable peer
 * actually registered a session.
 *
 * Two different failures wear the same face. A process that vanished leaves no
 * pid; a process that is running but never registered leaves a pid and no
 * session file. Both are reported, separately, rather than folded into one
 * vague "did not come up".
 */
export async function confirmStillRunning(
  pid: number | null,
  identity: IdentityCheck,
  expectedSessionId: string,
  opts: { settleMs?: number; procRoot?: string; command?: string } = {},
): Promise<LivenessCheck> {
  if (pid === null) return { ok: false, reason: "no pid was reported by the spawn" };
  const windowMs = opts.settleMs ?? 2_500;
  const procRoot = opts.procRoot ?? "/proc";
  const alive = () => existsSync(join(procRoot, String(pid)));

  // The session file is the proof a peer got as far as being a peer — but only
  // Claude Code writes one. Requiring it from any other command would fail
  // every legitimate relaunch of something else (a shell in the acceptance
  // suite, a wrapper on a host that uses one), so the rule applies to the
  // process that is actually supposed to register.
  const isClaude = (opts.command ?? "").split("/").pop() === "claude";
  const mustRegister = isClaude && isResumableSessionId(expectedSessionId);
  const registered = identity.actual !== null;

  // WHAT THIS WAIT IS ACTUALLY FOR (corrected v0.11.11).
  //
  // It used to be a flat `sleep(2500)` under a comment about giving the process
  // "time to come up" — which is not what it does. Coming up is already waited
  // for, by the spawn's own `measureIdentity` poll (v0.11.16, ceiling 5 s);
  // measured 2026-08-08, a heavy peer writes that file in 0.96 s. This
  // wait is a SURVIVAL OBSERVATION: a failed resume starts, runs for about two
  // seconds and exits, and without watching for that the tool answers
  // `restarted: ok` over a corpse (finding G, v0.10.7 re-pilot).
  //
  // Two things follow, and the old shape got both wrong:
  //
  //   - A process that dies at 300 ms was still waited out for the full 2500,
  //     and then reported as having "exited within 2500 ms" — a number that was
  //     the budget, not the measurement. Polling reports when it actually died.
  //   - A peer that HAS registered its session is already past the failure mode
  //     this window exists to catch, so holding the whole fleet for another two
  //     and a half seconds each buys nothing. Eight peers spent ~20 s of a
  //     restart proving that time passes.
  // THE INVERTED CALLER, and the reason `pollUntil` names its outcomes after
  // what happened rather than after success and failure: here `aborted` means
  // the peer DIED and `expired` means it survived long enough to be believed.
  const pollMs = 100;
  const budget = registered || !mustRegister ? Math.min(windowMs, 400) : windowMs;
  const outcome = await pollUntil<never>(() => null, {
    timeoutMs: budget,
    pollMs,
    abort: () => (alive() ? { aborted: false } : { aborted: true, reason: "exited" }),
  });
  if (outcome.kind === "aborted" || !alive()) {
    // The MEASURED time of death, not the budget. A process that dies at 300 ms
    // used to be reported as having "exited within 2500 ms" — a number that was
    // the decision, not the observation.
    return { ok: false, reason: `pid ${pid} exited ${outcome.waitedMs} ms after starting` };
  }
  if (mustRegister && !registered) {
    return {
      ok: false,
      reason: `pid ${pid} is running but registered no session — ~/.claude/sessions/${pid}.json never appeared`,
    };
  }
  return { ok: true, reason: "alive and registered" };
}

export interface IdentityCheck {
  mismatch: boolean;
  actual: string | null;
}

/**
 * Step f) — did the peer come back as itself?
 *
 * NO MEASUREMENT HAPPENS HERE, and that is the change. Until v0.11.18 this file
 * polled `~/.claude/sessions/<pid>.json` itself, through a function of its own,
 * while `peer_spawn` — which this handler calls, one line earlier — had ALREADY
 * measured the identity through `measureIdentity` and written it to the record.
 * Two mechanisms answering one question, one of them redundant, both of them to
 * be kept working. That is the duplication the owner named as priority one:
 * "code must be shared, so we do not debug the same thing twice".
 *
 * So the spawn measures and this decides. The four rules are the v0.10.7 pilot
 * findings, unchanged in meaning:
 *
 *   - measured, and different from what we resumed → MISMATCH. Something is
 *     running; it is not this peer. The worst of the outcomes to report as ok,
 *     because every later lifecycle call would act on a stranger.
 *   - measured, and the same → pass.
 *   - not measured → NOT a mismatch. Silence is not evidence, in either
 *     direction: it is also not a pass on its own, which is why
 *     `confirmStillRunning` still has to like the look of the process.
 *   - nothing was resumed (a fresh session) → nothing to compare against. Claude
 *     Code chose the id; there is no expectation for it to violate.
 */
export function identityVerdict(
  intendedSessionId: string | null,
  measuredSessionId: string | null,
): IdentityCheck {
  if (intendedSessionId === null || !isResumableSessionId(intendedSessionId)) {
    return { mismatch: false, actual: measuredSessionId };
  }
  if (measuredSessionId === null) return { mismatch: false, actual: null };
  return { mismatch: measuredSessionId !== intendedSessionId, actual: measuredSessionId };
}

/**
 * Step a) — what, if anything, gets resumed.
 *
 * The handle is the key. The identity is a measurement (v0.11.16). Before this
 * function existed the two were the same string by assumption, and `--resume`
 * got the handle.
 */
export type ResumeDecision =
  /** Resume this transcript. `source` says whether the key or the measurement decided. */
  | { kind: "resume"; sessionId: string; source: "handle" | "measured-identity" }
  /** Nothing to resume — this peer never had a session id of its own. */
  | { kind: "fresh"; why: string }
  /** Refuse. Restarting would either lose the context or resume a stranger. */
  | { kind: "refuse"; why: string };

export function decideResume(record: PeerRecord): ResumeDecision {
  const handle = record.handle;
  const measured = record.observed.sessionId ?? null;
  const identity = record.observed.identity;

  // Not Claude Code, so there is no session id to HAVE — the same gate N4 and
  // N10 use, for the same reason. It does not change what gets resumed; it
  // changes whether ignorance is possible. `identity: "unknown"` is recorded for
  // these peers with reason `not-a-claude-peer`, and reading that as "we failed
  // to find out" would refuse every `/bin/sleep` peer in the acceptance suite
  // over a category that does not apply to it.
  const canHaveIdentity = (record.desired.command ?? "claude").split("/").pop() === "claude";

  // The handle IS a session id and nothing contradicts it. 24 of 25 records on
  // the fleet, and every adopted peer, because adoption read identity off
  // reality in the first place.
  if (isResumableSessionId(handle) && (measured === null || measured === handle)) {
    return { kind: "resume", sessionId: handle, source: "handle" };
  }

  // Measured, and it disagrees with the key — or the key was never an id. Either
  // way the measurement wins: it is the only one of the two that was read off a
  // running process.
  if (identity === "measured" && measured !== null && isResumableSessionId(measured)) {
    return { kind: "resume", sessionId: measured, source: "measured-identity" };
  }

  // Running, and we do not know who it is. Restarting now means guessing, and
  // both guesses are bad: resume the handle and it matches no transcript (the
  // peer comes back empty, silently); resume nothing and the context is dropped
  // on purpose. Neither is a decision a tool should make on an operator's
  // behalf, and there is a cheap way out — `team_reconcile` measures it.
  if (
    canHaveIdentity &&
    (identity === "unknown" || (identity === undefined && measured === null))
  ) {
    return {
      kind: "refuse",
      why:
        identity === "unknown"
          ? "the peer's identity is UNKNOWN — it is running, but the daemon has not been able to read its session id"
          : "this record predates identity measurement (v0.11.16) and its key is not a session id",
    };
  }

  // A peer that genuinely has no transcript: spawned under a stable name, never
  // resumable, and honest about it.
  return {
    kind: "fresh",
    why: `handle '${handle}' is not a session id and no identity was measured — the peer starts fresh`,
  };
}

/**
 * Mark a record as not-running without deleting it.
 *
 * Used by every failure path AFTER the spawn reported success. `peer_spawn`
 * has by then written a fresh record saying `live` with the new pid — and if
 * the peer did not survive, or came back as somebody else, that record is a
 * lie with a plausible pid attached. Keeping the row is right; keeping its
 * claim is not (plt-designer, 4th pilot round, finding M).
 */
async function markNotRunning(ctx: HandlerContext, handle: string): Promise<void> {
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[handle];
    if (!rec) return;
    rec.observed.status = "unknown";
    rec.observed.pid = null;
    rec.observed.lastUpdatedAt = new Date().toISOString();
  });
}

/** The team of whoever sent this request — the search domain for short names. */
function callerTeamOf(req: RequestEnvelope, ctx: HandlerContext): string | null {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}

type RestartPhase = "ready-ack" | "stopping" | "spawning" | "verifying";

/**
 * Write the "a restart is underway" mark, or move it to the next phase.
 *
 * Called BEFORE each phase, never after. A mark that appears once a phase
 * succeeded cannot describe the phase that did not — and the phase this matters
 * for is `spawning`, the only one whose abandonment can leave a process no
 * record names.
 */
async function markRestart(
  ctx: HandlerContext,
  handle: string,
  phase: RestartPhase,
  fields: {
    threadId: string;
    msgId: string | null;
    requestedAt: string;
    timeoutMs: number;
    requestId: string;
    requestedByName?: string;
    resumeSessionId: string | null;
  },
): Promise<void> {
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[handle];
    if (!rec) return;
    rec.observed.restartRequest = { ...fields, phase };
    // `restarting` only while the peer is still up. Once its own stop has run,
    // the status belongs to the stop — saying `restarting` over a killed session
    // would be a claim about a process that is not there.
    if (phase === "ready-ack") rec.observed.status = "restarting";
    rec.observed.lastUpdatedAt = new Date().toISOString();
  });
}

/** The restart resolved — one way or the other. The mark is history now. */
async function clearRestartMark(ctx: HandlerContext, handle: string): Promise<void> {
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[handle];
    if (!rec?.observed.restartRequest) return;
    rec.observed.restartRequest = null;
    rec.observed.lastUpdatedAt = new Date().toISOString();
  });
}

type ReadyOutcome =
  | { kind: "skipped" }
  | { kind: "no-host" }
  | { kind: "acked"; threadId: string; msgId: string | null; waitedMs: number; resumed: boolean }
  | {
      kind: "no-ack";
      threadId: string;
      msgId: string | null;
      timeoutMs: number;
      waitedMs: number;
      ackVerdict: string;
      resumed: boolean;
      /** Jméno toho, kdo na téhle session drží lifecycle request, když to není volající. */
      pendingRequestedBy?: string;
    };

/**
 * Step b) — ask the peer to get ready, and wait.
 *
 * Delivery is `requestFromPeer` → `writeEnvelope` → the peer's inbox, which
 * reaches a peer with a live channel by UDS push. NOT send-keys: measured
 * 2026-08-07, a message to a peer with a live channel never goes near the pane,
 * and building a second delivery path beside a working one is how the first one
 * stops being exercised.
 *
 * Idempotent the same way `peer_stop` is, and for the same reason: a record
 * carrying a `restartRequest` in phase `ready-ack` means this question was
 * already asked. Resuming waits on the SAME thread and does not sweep — sweeping
 * on a resume deletes the very ack we came back for.
 */
async function runReadyPhase(
  req: RequestEnvelope,
  ctx: HandlerContext,
  target: { handle: string; sessionKey: string; record: PeerRecord },
  args: { force: boolean; readyTimeoutMs?: number; readyPollMs?: number; reason?: string },
  resumeSessionId: string | null,
): Promise<ReadyOutcome> {
  const { handle, sessionKey, record } = target;
  if (args.force) return { kind: "skipped" };

  // Nobody home — no request can be delivered and no ack can arrive. Waiting out
  // the window to be told so would be theatre, and the relaunch is the point.
  const alive = record.observed.tmuxTarget
    ? await ctx.hostDriver.hasSession(sessionKey).catch(() => false)
    : false;
  if (!alive) return { kind: "no-host" };

  // The BRIDGE address, not the registry key. See `bridgeIdOf` — the daemon
  // used to post its request into an inbox nobody drains whenever the two
  // differ, and then wait out the window for an ack that could not come.
  const bridgeId = bridgeIdOf(record);
  const timeoutMs = args.readyTimeoutMs ?? DEFAULT_RESTART_READY_TIMEOUT_MS;
  const pollMs = args.readyPollMs ?? DEFAULT_RESTART_READY_POLL_MS;
  await mkdir(restartAcks.dir(), { recursive: true });

  const pending = record.observed.restartRequest ?? null;
  const resumable = pending !== null && pending.phase === "ready-ack";
  let threadId: string;
  let msgId: string | null;
  let requestedAtMs: number;

  // 🔴 RESUME PO VYPRŠENÍ NENÍ POKRAČOVÁNÍ ČEKÁNÍ — je to NOVÉ OKNO (29. 8.).
  //
  // Do teď si resume vzal PŮVODNÍ `requestedAt` a deadline počítal z něj.
  // Když už uplynul, vyšlo okno 0 ms: naměřeno naostro `waitedMs: 1` a hned
  // `ready_timeout`. Chybová hláška přitom slibovala „call peer_restart again
  // to keep waiting… a late ack still counts" — po vypršení ten slib NEPLATIL
  // a člověk podle něj volal znovu do prázdna.
  //
  // Reopen znamená i NOVOU OTÁZKU pro peera: ack se nově váže na okno, které
  // odpovídá (viz `ackDeadlineMs` v `verifyAckFile`), takže potvrzení psané
  // pro staré okno už nepočítá — a peer o tom musí vědět. Pravidlo „jeden dotaz,
  // ne dva" platí UVNITŘ okna; přes hranici dvou oken je druhý dotaz správný.
  const expiredAtResume =
    resumable && pending !== null && Date.now() >= Date.parse(pending.requestedAt) + timeoutMs;

  // 🔴 SOUBĚŽNÝ ŽADATEL MÁ BÝT VIDĚT (29. 8.). Dva lifecycle requesty na týž
  // handle o sobě nevěděly: druhý se o kolizi dozvěděl až z výsledku, a to jen
  // proto, že vypršelé okno tehdy padlo za 14 ms. Po opravě ① by čekal celé
  // okno, takže mlčení by bylo dražší, ne levnější.
  const foreignRequester =
    resumable && pending !== null && pending.requestId !== req.id
      ? (pending.requestedByName ?? "someone else")
      : null;
  if (foreignRequester !== null) {
    await writeEvent({
      event: "peer_restart_request_already_pending",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle,
        pendingRequestId: pending?.requestId ?? null,
        pendingRequestedBy: foreignRequester,
        pendingRequestedAt: pending?.requestedAt ?? null,
        pendingPhase: pending?.phase ?? null,
      },
    });
  }

  if (resumable && pending && !expiredAtResume) {
    threadId = pending.threadId;
    msgId = pending.msgId;
    requestedAtMs = Date.parse(pending.requestedAt);
    await writeEvent({
      event: "peer_restart_ready_resumed",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, threadId, requestedAt: pending.requestedAt, note: "no second request" },
    });
  } else {
    // Staré potvrzení se ZAMETE i při znovuotevření okna. Ack, který zbyl po
    // okně, jež skončilo, je mina: velitel 29. 8. našel potvrzení zapsané
    // v 13:24 pro žádost, kterou v 13:23 zrušil — a další restart by ho vzal
    // jako platný a pustil se rovnou do stopu ŽIVÉ pracovní session.
    await restartAcks.sweepStale(bridgeId, expiredAtResume ? "window-reopened" : "pre-request");
    // The thread the PEER will echo back, so it is built from the address the
    // peer was written to — not from the key we file it under.
    threadId = restartThreadId(bridgeId);
    requestedAtMs = Date.now();
    msgId = await requestRestartReady(bridgeId, threadId, args.reason ?? null);
    await markRestart(ctx, handle, "ready-ack", {
      threadId,
      msgId,
      requestedAt: new Date(requestedAtMs).toISOString(),
      timeoutMs,
      requestId: req.id,
      requestedByName: req.requestedBy.name,
      resumeSessionId,
    });
    if (expiredAtResume && pending) {
      await writeEvent({
        event: "peer_restart_ready_window_reopened",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle,
          previousRequestedAt: pending.requestedAt,
          previousThreadId: pending.threadId,
          timeoutMs,
          note: "previous window had expired — asking again rather than waiting 0 ms",
        },
      });
    }
    await writeEvent({
      event: "peer_restart_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, bridgeId, sessionKey, threadId, msgId, timeoutMs, resumeSessionId },
    });
  }

  const started = Date.now();
  const verdict = await restartAcks.poll(
    bridgeId,
    requestedAtMs + timeoutMs,
    pollMs,
    requestedAtMs,
    threadId,
  );
  // The MEASURED wait. A handler that reports its budget as a duration is
  // reporting a decision.
  const waitedMs = Date.now() - started;
  if (verdict.accepted) {
    await restartAcks.consume(bridgeId);
    return { kind: "acked", threadId, msgId, waitedMs, resumed: resumable };
  }
  return {
    kind: "no-ack",
    threadId,
    msgId,
    timeoutMs,
    waitedMs,
    ackVerdict: verdict.reason,
    resumed: resumable,
    ...(foreignRequester !== null ? { pendingRequestedBy: foreignRequester } : {}),
  };
}

export async function handlePeerRestart(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = PeerRestartArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;

  // Snapshot the record BEFORE stop, since stop removes it.
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
  const record = resolved.kind === "found" ? resolved.record : null;
  if (!record) {
    const unresolved = await unresolvedPeerError(args.peer);
    return errResult(req.id, req.tool, unresolved.code, unresolved.message, unresolved.details);
  }

  // IS ONE ALREADY RUNNING? (P4 idempotence, with a mechanism.)
  //
  // Phases divide here because the answer divides. Waiting for a ready-ack is
  // re-enterable — `runReadyPhase` resumes the same thread, and a late ack still
  // counts. Everything past the stop is not: a second caller entering a spawn
  // that is in flight is how one handle ends up with two processes.
  const inFlight = record.observed.restartRequest ?? null;
  if (inFlight && inFlight.phase !== "ready-ack") {
    return errResult(
      req.id,
      req.tool,
      "restart_in_progress",
      `A restart of '${record.handle}' is already in its ${inFlight.phase} phase (requested at ${inFlight.requestedAt} by ${inFlight.requestId}). Entering it twice would risk two processes behind one record. Wait for it, or check team_reconcile for a restart_pending drift if the caller is gone.`,
      { handle: record.handle, phase: inFlight.phase, since: inFlight.requestedAt },
    );
  }

  /**
   * 🔴 BRÁNA: VZAL BY TENHLE RESTART PEEROVI PROXY? (v0.11.35)
   *
   * Incident 27. 8. 19:07: `peer_restart` vrátil `mic-bitrix-dev` BEZ
   * `ANTHROPIC_BASE_URL`, tedy mimo směrování identit a na tokenu STROJE.
   * Chytil to až detektor C po deseti minutách. Příčina byla ve spawnu
   * (nikdo tu proměnnou nedosazoval); tohle je pojistka, aby se opravená
   * cesta nedala znovu tiše obejít.
   *
   * ⚠ PTÁ SE NA ROZHODNUTÍ, NE NA HODNOTU. Kdo chce peera vědomě mimo
   * proxy, deklaruje `anthropicBaseUrl: null` a brána mlčí. Odmítnutí
   * přijde jen tehdy, když peer proxy PROKAZATELNĚ MÁ (čteno z jeho
   * `/proc/<pid>/environ`) a nikdo neřekl, co má být po restartu.
   *
   * Proto srovnávací a ne absolutní: absolutní podmínka by odmítala
   * restartovat peery každé instalaci, která žádný router identit nemá —
   * a most se rozdává ven.
   */
  const baseUrlDecision = resolveBaseUrl(record.desired, await readConfig());
  if (!baseUrlDecision.decided) {
    const pid = record.observed.pid;
    const inspector = defaultProcessInspector();
    // `null` = NEVÍME (starý pid, jiná platforma, nepřečtený /proc). Brána
    // pak mlčí: hlídá doloženou ztrátu, ne domněnku.
    const liveEnviron =
      pid && inspector.readProcEnviron
        ? await inspector.readProcEnviron(pid).catch(() => null)
        : null;
    if (restartWouldDropProxy(baseUrlDecision, liveEnviron)) {
      const had = liveEnviron?.["ANTHROPIC_BASE_URL"] ?? "";
      await writeEvent({
        event: "peer_restart_refused_would_drop_proxy",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { handle: record.handle, liveBaseUrl: had, source: baseUrlDecision.source },
      });
      return errResult(
        req.id,
        req.tool,
        "restart_would_drop_proxy",
        `Peer '${record.handle}' běží s ANTHROPIC_BASE_URL=${had}, ale nikdo nedeklaroval, kudy má chodit po restartu — restart by ho vyhodil mimo proxy, na token stroje, a poznalo by se to až z hlídky. Nic se nestalo. Rozhodni: control_config peer:"${record.observed.name}" set:{anthropicBaseUrl:"${had}"} pro zachování, nebo set:{anthropicBaseUrl:null} pro vědomý přímý běh. Flotilový default patří do ~/.claude-bridge/control/config.json → spawn.anthropicBaseUrl. ⚠ Per-peer deklarace přes control_config funguje až ze session s pluginem v0.11.35+ — starší most ten klíč odmítne dřív, než se sem dostane, a restart peera plugin NEAKTUALIZUJE. Do té doby je funkční cesta flotilový default, který čte démon.`,
        {
          handle: record.handle,
          liveBaseUrl: had,
          // Aby se „nikdo nerozhodl" nečetlo jako „rozhodnuto napřímo".
          decisionSource: baseUrlDecision.source,
        },
      );
    }
  }

  // NOTE: sanitized env pulled from process.env — daemon's own process.
  // Restart intentionally does NOT inherit the caller's env; we're just
  // relaunching the same peer, not adopting the caller's environment.

  // Put the peer back in ITS directory, not the daemon's (fix, 2026-08-04).
  //
  // This passed `process.cwd()` because PeerRecord had no cwd to read. That
  // is the daemon's working directory, so `claude --resume <uuid>` looked
  // for a transcript belonging to a different project, found none, and
  // exited on the spot — tmux then removed the session. The restart still
  // reported success, because the driver asserted `alive` instead of
  // measuring it. Both halves are fixed; this is the one that stops the
  // process from dying in the first place.
  const cwd = record.desired.cwd ?? process.cwd();

  // And launch it the way it was launched. `command` was a hardcoded "claude"
  // until 2026-08-04 — the identical omission to `cwd`, one field over, in the
  // same handler, missed in the same fix. Under nvm the daemon's PATH has no
  // `claude`, so every restart on this fleet respawned a command that did not
  // exist. Found by the pilot of the cwd fix, because the driver now measures
  // `alive` and the failure was finally audible.
  const command = record.desired.command ?? "claude";
  const commandArgs = record.desired.spawnArgs ?? [];

  const missing = [
    record.desired.cwd ? null : "cwd",
    record.desired.command ? null : "command",
  ].filter((f): f is string => f !== null);
  if (missing.length > 0) {
    await writeEvent({
      event: "peer_restart_launch_params_unknown",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: record.handle,
        missing,
        fallbackCwd: cwd,
        fallbackCommand: command,
        hint: "Peer record predates launch-parameter persistence (v0.10.3). The restart uses the daemon's cwd and a bare `claude`, which fails on installs where claude is not on the daemon's PATH (nvm). Re-spawn the peer to record its real parameters.",
      },
    });
  }

  // The launch parameters are diagnosed BEFORE step a) can refuse.
  //
  // Both messages say "this record is too old to act on", and they say it about
  // different fields. Emitting only the one that happens to fire first would
  // hand an operator half a diagnosis for a single underlying cause: a record
  // written before the daemon recorded what it needs. Reading the record costs
  // nothing and cannot fail, so there is no reason to gate it behind a decision.

  // STEP a) — decide, and verify, what is being restarted.
  //
  // Not a format check. The question is which transcript comes back, and until
  // v0.11.16 there was no measurement to answer it with — so the handle answered
  // and was believed.
  const resumeDecision = decideResume(record);
  if (resumeDecision.kind === "refuse") {
    await writeEvent({
      event: "peer_restart_refused",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle: record.handle, reason: resumeDecision.why },
    });
    return errResult(
      req.id,
      req.tool,
      "restart_identity_unknown",
      `Refusing to restart '${record.handle}': ${resumeDecision.why}. Resuming the handle would relaunch the peer EMPTY and report success; resuming nothing would drop its context on purpose. Neither is this tool's decision to make. Run team_reconcile to measure the identity, then restart. NOTHING WAS TOUCHED — the peer is still running.`,
      {
        handle: record.handle,
        identity: record.observed.identity ?? null,
        measuredSessionId: record.observed.sessionId ?? null,
      },
    );
  }
  const resumeSessionId = resumeDecision.kind === "resume" ? resumeDecision.sessionId : null;
  // The same derivation `peer_stop` uses, so both ask the host about one address.
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;

  // Read the peer's home BEFORE stopping it.
  //
  // This lookup used to sit after the stop, by which point the window had
  // already been destroyed — so `inSession` was always null and every adopted
  // peer was relaunched as a session of its own anyway. The v0.10.7 fix was
  // correct and unreachable (plt-designer, re-pilot: @652 in `obetni` came back
  // as a standalone session `w1`). Ask the host while the answer still exists.
  // The record knows its home. Asking the host is only a fallback for records
  // written before homeSession existed — and it fails exactly when it matters
  // most, because a peer whose window already died has no window to ask.
  let inSession: string | null = record.desired.homeSession ?? null;
  /**
   * Where the peer sits RIGHT NOW (#103).
   *
   * Measured, not read from `desired.windowIndex`: with `renumber-windows on`
   * a stored index describes a layout that may have shifted since — the very
   * property this file's own comment recorded on 2026-08-04 and nobody carried
   * through to restart. Asked while the window still exists, because a killed
   * window has no position to report.
   *
   * The number travels to `peer_spawn` → the driver, which restores it with
   * `move-window -b` after the new window is created. See `windowIndex` in
   * SessionHostSpawnOptions for why a create cannot land there directly.
   */
  let windowIndex: number | undefined;
  if (record.observed.tmuxTarget && ctx.hostDriver.listWindows) {
    const here = (await ctx.hostDriver.listWindows()).find(
      (w) => w.target === record.observed.tmuxTarget,
    );
    if (here) {
      windowIndex = here.window;
      inSession = inSession ?? here.session;
    }
  }
  if (
    inSession === null &&
    record.observed.tmuxTarget &&
    parseHostTarget(record.observed.tmuxTarget).kind === "window"
  ) {
    const windows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
    inSession = windows.find((w) => w.target === record.observed.tmuxTarget)?.session ?? null;
    if (inSession === null) {
      await writeEvent({
        event: "peer_restart_window_home_unknown",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle: record.handle,
          tmuxTarget: record.observed.tmuxTarget,
          hint: "The window is not on the host, so its parent session cannot be read. The peer will be relaunched as a session of its own.",
        },
      });
    }
  }

  // Provenance the spawn does not know about. `peer_spawn` writes a fresh
  // record, so without carrying these forward a restart silently stripped
  // `team` and `adopted` from every peer it touched — and a fleet roll would
  // have left every team-scoped operation with nothing to match on
  // (plt-designer, v0.10.7 re-pilot, finding H).
  const provenanceDesired = {
    ...(record.desired.team !== undefined ? { team: record.desired.team } : {}),
    ...(record.desired.label !== undefined ? { label: record.desired.label } : {}),
    ...(record.desired.windowIndex !== undefined
      ? { windowIndex: record.desired.windowIndex }
      : {}),
    ...(inSession ? { homeSession: inSession } : {}),
  };
  const provenanceObserved = {
    ...(record.observed.adopted !== undefined ? { adopted: record.observed.adopted } : {}),
    ...(record.observed.spawnEnv ? { spawnEnv: record.observed.spawnEnv } : {}),
    // Carry the ORIGINAL sampling time, not the restart's.
    //
    // `peer_spawn` stamps `harvestedAt` when it is handed an `envBase`, which
    // is right for a first spawn and wrong here: the values being passed in
    // were sampled once, long ago, and a restart only copies them. Letting the
    // spawn re-stamp would date a stale environment to now — inventing a
    // provenance, which is the precise move this release exists to stop.
    ...(record.observed.harvestedAt !== undefined
      ? { harvestedAt: record.observed.harvestedAt }
      : {}),
  };

  // STEP b) — "get ready, you are coming back".
  const ready = await runReadyPhase(
    req,
    ctx,
    { handle: record.handle, sessionKey, record },
    args,
    resumeSessionId,
  );
  if (ready.kind === "no-ack") {
    // NOTHING HAS HAPPENED. The peer is running, untouched, and the request
    // stands on its record so a retry resumes it rather than asking twice.
    await writeEvent({
      event: "peer_restart_ready_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: record.handle,
        threadId: ready.threadId,
        timeoutMs: ready.timeoutMs,
        waitedMs: ready.waitedMs,
        ackVerdict: ready.ackVerdict,
        resumed: ready.resumed,
        pendingRequestedBy: ready.pendingRequestedBy ?? null,
      },
    });
    return errResult(
      req.id,
      req.tool,
      "restart_ready_timeout",
      `Peer '${record.handle}' did not say it was ready within ${ready.timeoutMs} ms (waited ${ready.waitedMs} ms, last ack verdict: ${ready.ackVerdict}). NOTHING WAS STOPPED and nothing was killed — the peer is running exactly as before. Call peer_restart again and it ASKS AGAIN on a fresh window of ${ready.timeoutMs} ms: an ack answers the window it was asked in, so one written after this window closed does not carry over. Or peer_restart with force:true to restart it now and lose whatever it had not written down.`,
      {
        handle: record.handle,
        threadId: ready.threadId,
        waitedMs: ready.waitedMs,
        stillRunning: true,
        // Kdo na téhle session drží lifecycle request. Bez toho se druhý
        // volající o kolizi dozví až z výsledku — a to jen když má štěstí.
        pendingRequestedBy: ready.pendingRequestedBy ?? null,
      },
    );
  }

  const readyThreadId = ready.kind === "acked" ? ready.threadId : restartThreadId(record.handle);
  const restartMarkFields = {
    threadId: readyThreadId,
    msgId: ready.kind === "acked" ? ready.msgId : null,
    requestedAt: new Date().toISOString(),
    timeoutMs: args.readyTimeoutMs ?? DEFAULT_RESTART_READY_TIMEOUT_MS,
    requestId: req.id,
    resumeSessionId,
  };
  await markRestart(ctx, record.handle, "stopping", restartMarkFields);

  // STEP c) — the graceful primitive from v0.11.15. Same code, switched on.
  const stopArgs = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:stop`,
    ts: req.ts,
    tool: "peer_stop",
    args: {
      peer: record.handle,
      reason: args.reason ?? "peer_restart",
      // 🔴 ONE ASK, NOT TWO — corrected by the acceptance run.
      //
      // The design had step c) run the primitive's own courtesy on a short
      // window, so that `stoppedCleanly` stayed a measurement taken by
      // `peer_stop` rather than a claim made here. Measured on a live peer
      // 2026-08-08: the ready-ack took 30 s (a full agent turn — read the
      // inbox, park the work, write the file), and the stop-request that
      // followed asked the SAME peer the SAME question, needing another whole
      // turn. It timed out, and the restart failed on a peer that had done
      // everything right.
      //
      // The estimate was not merely low. The second ask is the wrong SHAPE:
      // what `stoppedCleanly` is supposed to record is "the peer had a chance
      // to save its work before it died", and the ready-ack IS that
      // measurement. A stop-ack would only add "…and it was still ready
      // fifteen seconds later", for the price of doubling the restart.
      //
      // So the measurement moves rather than disappearing: `skipCourtesy`
      // because the asking already happened HERE, and `stoppedCleanly: true`
      // because this handler measured it — the ack file existed, was fresh, and
      // matched the thread. That is not a caller's opinion.
      ...(ready.kind === "acked" ? { skipCourtesy: true as const, stoppedCleanly: true } : {}),
      // Keep the record through the stop. The restart mark lives on it, and the
      // mark's whole job is to survive the window where the peer is neither the
      // old process nor the new one.
      keepInState: true,
      force: args.force,
      // v0.11.27: `peer_stop` now refuses `force` on a peer whose heartbeat
      // proves it is alive. A FORCED RESTART IS ALREADY THAT DECISION — the
      // caller was told in as many words that it loses whatever the peer had
      // not written down, and the peer comes back afterwards, so this is not
      // the killing the guard was built to stop. Passing the override here
      // keeps the legitimate case working: on 2026-08-10 a forced restart was
      // the only way to free two peers stuck on a modal dialog, and those peers
      // were heartbeating the whole time.
      //
      // The stop still records the override in the audit trail, so a deliberate
      // kill of a live peer stays searchable whether it came from here or from
      // a human typing `peer_stop`.
      overrideLiveness: args.force,
    },
    requestedBy: req.requestedBy,
  };
  const stopResult = await handlePeerStop(stopArgs, ctx);
  if (stopResult.outcome === "error") {
    // The peer refused, or the host would not answer. Either way it is STILL
    // RUNNING — `peer_stop` kills nothing on a failed graceful stop.
    //
    // THE MARK GOES. It was left standing at first, and the acceptance run
    // walked straight into what that costs: the restart returned an error, the
    // operator retried, and the retry was refused with `restart_in_progress`
    // for an operation that had already finished failing. Nothing could clear
    // it.
    //
    // A mark means "a restart is UNDERWAY and nobody has come back for it".
    // This caller came back — it is returning an error right now. Abandonment
    // is the absence of that, and only `ready-ack` keeps its mark, because
    // there the mark IS the resumable request.
    await clearRestartMark(ctx, record.handle);
    await writeEvent({
      event: "peer_restart_stop_failed",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: record.handle,
        code: stopResult.error?.code ?? null,
        readyAcked: ready.kind === "acked",
      },
    });
    return errResult(
      req.id,
      req.tool,
      "restart_stop_failed",
      `${stopResult.error?.message ?? "peer_stop failed"} — the restart stopped here, and the peer is still running. Retry, or use force:true.`,
      { stopResult, handle: record.handle, stillRunning: true },
    );
  }
  const stoppedCleanly =
    (stopResult.data as { stoppedCleanly?: boolean | null } | undefined)?.stoppedCleanly ?? null;

  const spawnArgs = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:spawn`,
    ts: req.ts,
    tool: "peer_spawn",
    args: {
      handle: record.handle,
      displayName: record.observed.name,
      cwd,
      // The test override stays ahead of the record so the acceptance suite can
      // relaunch something cheaper than a real Claude Code.
      command: process.env["CLAUDE_BRIDGE_TEST_COMMAND"] ?? command,
      args: commandArgs,
      ...(inSession ? { inSession } : {}),
      // Measured above, while the window still existed (#103).
      ...(windowIndex !== undefined ? { windowIndex } : {}),
      // The team, and the label derived from it.
      //
      // Omitted until v0.11.1, and that was not cosmetic: `peer_spawn` names
      // the tmux window from `windowLabelFor(displayName, team)`, so without a
      // team every relaunched window came back wearing the fully qualified
      // name. The v0.10.21 label fix covered `team_layout` and direct spawns
      // and left this path alone, where it sat unnoticed because nothing had
      // restarted through it since — until the v0.11.0 roll renamed 22 windows
      // back in one pass.
      ...(record.desired.team !== undefined ? { team: record.desired.team } : {}),
      // An operator's declared label wins over the derived one, or
      // `control_config set label=…` would survive in the record and never
      // reach the window it names.
      ...(record.desired.label !== undefined ? { label: record.desired.label } : {}),
      // The peer's own environment. Without it the relaunch inherits the
      // daemon's PATH and comes up unable to find node.
      ...(record.observed.spawnEnv
        ? {
            envBase: record.observed.spawnEnv,
            // Always passed, so the spawn never mistakes a copy for a sample.
            // `null` says "carried, provenance unknown" — which is the honest
            // answer for every record migrated out of v1.
            envHarvestedAt: record.observed.harvestedAt ?? null,
          }
        : {}),
      // Only resume something that CAN be resumed.
      //
      // This was an unconditional `true`. For a peer spawned under a stable
      // name rather than a UUID — `obetni-w3` — that composes
      // `claude --resume obetni-w3`, which matches no transcript, so Claude
      // Code drops into its interactive Resume picker and sits there. The peer
      // is then wedged at a prompt, gets a brand-new session id, and the record
      // is orphaned: the pid matches, so `team_status` still reads "live".
      // Found by plt-designer in the v0.10.6 pilot; the restart reported `ok`
      // over it, which is this release's own defect wearing a new hat.
      // The DECISION from step a), not a re-derivation of it. Handing
      // `record.sessionId` to `--resume` is the defect this release fixes: for a
      // handle-keyed peer that is a string no transcript is named after, so
      // `resume` came out false and the peer came back empty under its own name.
      resume: resumeSessionId !== null,
      ...(resumeSessionId !== null ? { resumeSessionId } : {}),
      // Intent first, measurement only as a fallback. A peer whose model was
      // switched at runtime has no `desired.model` recording that choice, and
      // relaunching it on the older declared model would be a silent downgrade
      // — so the observation still gets a turn, but never ahead of a stated
      // intent. Ordering is the whole answer here; picking one side is not.
      model: args.model ?? record.desired.model ?? record.observed.model ?? null,
      accountProfile: args.accountProfile ?? record.desired.accountProfile ?? null,
      extraAllowEnv: [],
      extraEnv: {},
    },
    requestedBy: req.requestedBy,
  };
  // The mark moves to `spawning` BEFORE the spawn — the one phase whose
  // abandonment can leave a process that no record names. A mark written after a
  // successful spawn would be silent about the spawn that did not finish.
  await markRestart(ctx, record.handle, "spawning", restartMarkFields);

  const spawnResult = await handlePeerSpawn(spawnArgs, ctx);
  if (spawnResult.outcome === "error") {
    // Put the record back.
    //
    // `peer_spawn` deletes it when the spawn produces nothing, which is right
    // for a spawn — there was never a peer. For a RESTART there was, and
    // dropping it leaves an operator with nothing to retry: `team_release`
    // answered `team_not_found, knownTeams: []` after a failed restart, and
    // the peer had vanished from the control plane entirely
    // (plt-designer, pre-rollout probe, 2026-08-04).
    //
    // It comes back as `unknown`, not `live`: nothing is running, and this
    // release is about not saying otherwise.
    await applyStateChange(ctx.state, (draft) => {
      draft.peers[record.handle] = {
        ...record,
        // Intent is untouched — the operator still wants this peer, which is
        // exactly why the record survives a failed relaunch. Only the
        // measurement changes, and it changes to "we do not know".
        observed: {
          ...record.observed,
          status: "unknown",
          pid: null,
          // The restart is over — it failed. Leaving the mark would make the
          // next call refuse as `restart_in_progress` and `team_reconcile`
          // report an abandoned restart, for something that finished and said so.
          restartRequest: null,
          lastUpdatedAt: new Date().toISOString(),
        },
      };
    });
    await writeEvent({
      event: "peer_restart_record_retained",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: record.handle,
        status: "unknown",
        hint: "The relaunch failed. The record is kept so the peer can be retried or released; nothing is running behind it.",
      },
    });
    return errResult(
      req.id,
      req.tool,
      "restart_spawn_failed",
      spawnResult.error?.message ?? "peer_spawn failed",
      { spawnResult },
    );
  }

  const hasProvenance =
    Object.keys(provenanceDesired).length > 0 || Object.keys(provenanceObserved).length > 0;
  if (hasProvenance) {
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[record.handle];
      if (!rec) return;
      // Each half onto its own half. A single flat `Object.assign` used to be
      // enough and now silently would not be: it would hang `team` off the top
      // of the record where nothing reads it, and every team-scoped operation
      // would find nothing to match — the same finding H this block exists for,
      // reintroduced by the very refactor meant to prevent that class.
      Object.assign(rec.desired, provenanceDesired);
      Object.assign(rec.observed, provenanceObserved);
    });
  }

  await markRestart(ctx, record.handle, "verifying", restartMarkFields);

  // STEP f) — did the peer come back as ITSELF?
  //
  // A restart can succeed at the level of "a process is running" and still be
  // wrong: if the resume did not take, Claude Code starts a fresh session with
  // a new id, the pid matches the record, and every subsequent report says
  // "live" about a peer whose identity has silently moved. plt-designer hit
  // exactly that in the v0.10.6 pilot.
  //
  // The measurement is the SPAWN'S — `peer_spawn` measures identity on every
  // successful spawn since v0.11.16, one call up from here. Measuring again
  // through a second mechanism was what this file used to do, and two
  // mechanisms answering one question is the duplication the owner put first.
  const spawnData = spawnResult.data as
    | { pid?: number | null; measuredSessionId?: string | null }
    | undefined;
  const newPid = spawnData?.pid ?? null;
  const identity = identityVerdict(resumeSessionId, spawnData?.measuredSessionId ?? null);

  // Is it still there a moment later?
  //
  // `spawn_produced_no_process` catches a command that never started. It does
  // NOT catch one that started and died a second later — a failed resume exits
  // in about two seconds, tmux removes the window, and the identity check finds
  // no session file. "Silence is not a mismatch" was right, but it let that
  // case through as a PASS and the tool answered `restarted: ok` over a corpse
  // (plt-designer, v0.10.7 re-pilot, finding G).
  //
  // Absence of evidence had to stop meaning evidence of absence in BOTH
  // directions: not a mismatch, and not a pass either.
  // The expectation is what we RESUMED, not the key. For a handle-keyed peer the
  // key is not a session id, so passing it here switched `mustRegister` off and
  // the survival window shrank from 2500 ms to 400 — the check quietly relaxing
  // itself for exactly the peers it was needed for.
  const liveness = await confirmStillRunning(newPid, identity, resumeSessionId ?? record.handle, {
    ...(ctx.restartSettleMs !== undefined ? { settleMs: ctx.restartSettleMs } : {}),
    ...(ctx.procRoot ? { procRoot: ctx.procRoot } : {}),
    command,
  });
  if (!liveness.ok) {
    // The spawn wrote a `live` record with the new pid before we learned the
    // peer was gone. Leave it standing and the state file asserts a running
    // peer behind a dead pid.
    await markNotRunning(ctx, record.handle);
    await clearRestartMark(ctx, record.handle);
    await writeEvent({
      event: "peer_restart_died_after_spawn",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle: record.handle, pid: newPid, reason: liveness.reason },
    });
    return errResult(
      req.id,
      req.tool,
      "restart_died_after_spawn",
      `The relaunched peer did not survive: ${liveness.reason}`,
      { handle: record.handle, pid: newPid, reason: liveness.reason },
    );
  }

  if (identity.mismatch) {
    // Something IS running, but not the peer this record names. Reporting it as
    // this peer, live, is the worst of the three outcomes: every lifecycle call
    // would then act on a stranger.
    await markNotRunning(ctx, record.handle);
    await clearRestartMark(ctx, record.handle);
    await writeEvent({
      event: "peer_restart_identity_mismatch",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        expected: resumeSessionId,
        handle: record.handle,
        actual: identity.actual,
        pid: newPid,
        hint: "The peer is running but under a different session id — the record now points at an identity that no longer exists. Adopt the new id or stop the peer; do not trust lifecycle calls on this record.",
      },
    });
    return errResult(
      req.id,
      req.tool,
      "restart_identity_mismatch",
      `Peer restarted as '${identity.actual ?? "unknown"}', not '${resumeSessionId}' — the resume did not take and the record now names an identity that is not running.`,
      { expected: resumeSessionId, handle: record.handle, actual: identity.actual, pid: newPid },
    );
  }

  await clearRestartMark(ctx, record.handle);

  await writeEvent({
    event: "peer_restarted",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      handle: record.handle,
      reason: args.reason ?? null,
      force: args.force,
      mode: args.force ? "forced" : ready.kind === "acked" ? "graceful" : "no-host",
      resumedSessionId: resumeSessionId,
      resumeSource: resumeDecision.kind === "resume" ? resumeDecision.source : null,
      readyWaitedMs: ready.kind === "acked" ? ready.waitedMs : null,
      stoppedCleanly,
      measuredSessionId: identity.actual,
      envSource: record.observed.spawnEnv ? "stored" : "daemon",
      envHarvestedAt: record.observed.harvestedAt ?? null,
    },
  });

  // STEP g) — tell the peer what happened, and why.
  //
  // A resumed session is SILENT: `--resume` restores the transcript and the
  // process, and then nothing runs until a turn is triggered from outside. Until
  // this release `peer_restart` never called this, so every restarted peer sat
  // at its prompt and every "report back after the restart" instruction in an
  // anchor was never reached. `team_layout` was the only caller of `wakePeer`.
  //
  // Under FORCE this is the most important step in the protocol, not the least:
  // the peer was never asked to tidy up, so its anchor may be mid-write, and
  // this is the only thing that tells it so. Force skips waiting, never
  // evidence — and a warning that never arrives is the absence of evidence.
  const wake = await wakePeer(req, ctx, {
    // The BRIDGE address, not the key — the same distinction step b) of this
    // protocol already makes when it ASKS the peer. Step g) TELLS it, and until
    // R3 it told a directory nobody drains.
    bridgeId: bridgeIdOf(record),
    sessionKey: (spawnData as { sessionKey?: string } | undefined)?.sessionKey ?? sessionKey,
    reason: args.reason ?? "peer_restart",
    // WAS THE PEER ASKED? — not "did the stop report itself clean".
    //
    // Found by the acceptance run, in this release's own code. A forced stop
    // skips the courtesy, so `peer_stop` has nothing to measure and returns
    // `stoppedCleanly: null` — and the wake only warns on `false`. The forced
    // restart therefore produced the most reassuring possible message for the
    // peer least entitled to it: no warning at all, after being killed
    // mid-sentence.
    //
    // This is not the caller overriding a measurement. Whether we asked is a
    // fact this handler owns, and from the peer's side an unasked stop IS an
    // unclean one: whatever it had not written down at that moment is gone.
    stoppedCleanly: ready.kind === "acked" ? stoppedCleanly : false,
    event: "restarted",
    wakePrompt: RESTART_WAKE_PROMPT,
    ...(ctx.wakeDelayMs !== undefined ? { wakeDelayMs: ctx.wakeDelayMs } : {}),
  });

  return okResult(req.id, req.tool, {
    handle: record.handle,
    // TOP LEVEL, all of it. A caller must not have to dig through two nested
    // results to learn whether the peer kept its context, whether it was asked
    // first, or whether it was told what happened.
    restarted: true,
    mode: args.force ? "forced" : ready.kind === "acked" ? "graceful" : "no-host",
    // Did the context survive? This is the question the whole release is about.
    resumedSessionId: resumeSessionId,
    resumeSource: resumeDecision.kind === "resume" ? resumeDecision.source : null,
    ...(resumeDecision.kind === "fresh" ? { resumeSkipped: resumeDecision.why } : {}),
    // MEASURED waits, never budgets.
    readyWaitedMs: ready.kind === "acked" ? ready.waitedMs : null,
    stoppedCleanly,
    measuredSessionId: identity.actual,
    // Step g). `false` means the peer is running and does not know why it
    // restarted — not fatal, and not something to leave unsaid either.
    reported: wake.injected,
    ...(wake.injected ? {} : { reportNote: wake.error ?? "the wake was not injected" }),
    stop: stopResult.data,
    spawn: spawnResult.data,
  });
}

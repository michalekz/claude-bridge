import { mkdir } from "node:fs/promises";
import { resolvePeer } from "@claude-bridge/shared";
import { z } from "zod";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { KillOutcome } from "../hosts/driver.ts";
import { defaultProcessInspector } from "../hosts/process-inspector.ts";
import { type ProcessMark, markProcess, markedProcessAlive } from "../pid.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { PeerRecord } from "../state.ts";
import type { HandlerContext } from "./context.ts";
import { bridgeIdOf } from "./peer-identity.ts";
import { ambiguousPeerMessage, resolvePeerRef, unresolvedPeerError } from "./peer-ref.ts";
import { applyStateChange } from "./state-writer.ts";
import {
  DEFAULT_STOP_ACK_POLL_MS,
  DEFAULT_STOP_ACK_TIMEOUT_MS,
  requestStop,
  stopAcks,
  stopThreadId,
} from "./stop-protocol.ts";

/**
 * A heartbeat younger than this proves the peer is running.
 *
 * Same 30 s the daemon uses to judge its own liveness, and the same reasoning:
 * a peer writes its heartbeat about once a second, so 30 s is thirty missed
 * writes — far past noise, far short of a peer that merely went quiet. The
 * victim of the 2026-08-11 incident was at 2.3 s.
 */
const LIVE_HEARTBEAT_MS = 30_000;

/**
 * peer_stop — ask a peer to stand down, then end its session.
 *
 * v0.11.15 (phase 1 of the lifecycle redesign) moved the courtesy DOWN here.
 * Until then this handler did one thing — `driver.kill()` — and the graceful
 * protocol lived in `team_stop`, one floor up. That was backwards against the
 * owner's principle that a team operation should be nothing but the primitive
 * repeated, and it meant the polite path was unreachable for a single peer.
 *
 * Two modes, and `force` picks between them:
 *
 *   force:false (default) — ASK FIRST.
 *     stop-request into the peer's inbox → wait for its ack → kill.
 *     No ack inside the window: NOTHING IS KILLED. The call fails honestly,
 *     the pending request stays on the record, and calling again resumes the
 *     same thread rather than asking twice.
 *
 *   force:true — kill now. No request, no waiting, shorter driver verify
 *     budget so an operator gets feedback fast when the host is not answering.
 *
 * FORCE SKIPS WAITING, NEVER EVIDENCE. It does not skip the dead-pane archive
 * in `driver.kill()`, and it does not skip the audit events. What it buys is
 * time, and time is the only thing it is allowed to buy.
 *
 * The driver is responsible for terminating the ENTIRE supervised tree (the
 * bg-pty-host lesson, designer msg mrxe9t7d) and for polling post-kill to
 * detect the respawn class of failures.
 */

export const PeerStopArgsSchema = z
  .object({
    peer: z.string().min(1),
    reason: z.string().optional(),
    /**
     * Skip the courtesy phase and kill immediately.
     *
     * BREAKING in v0.11.15: this used to be the only behaviour, so every
     * internal caller that wants it now says so explicitly. The default flipped
     * because a human typing `peer_stop` almost always means "wind it down",
     * and the dangerous reading is the one that should need a word.
     */
    force: z.boolean().default(false),
    /**
     * Kill a peer whose heartbeat proves it is alive.
     *
     * THE 2026-08-11 INCIDENT. A background session resurrected from the
     * previous day decided a live peer was "a zombie after the nightly crash"
     * and force-stopped it. The premise was false — the victim's heartbeat was
     * 2.3 s old and its transcript had been written 14 minutes earlier — but
     * nothing checked, because `force` asked for no evidence.
     *
     * So `force` alone now refuses a demonstrably live peer. This flag is the
     * way to say it anyway, and it exists because refusing outright would break
     * the legitimate case: a peer stuck on a modal dialog also heartbeats, and
     * killing its process is the only way out. The difference is not the state
     * of the peer — it is whether the caller KNOWS it is killing something
     * alive. That belongs in the audit trail as an override, not as routine.
     */
    overrideLiveness: z.boolean().default(false),
    /**
     * The courtesy already happened somewhere else — skip it, change nothing
     * else. FOR INTERNAL CALLERS.
     *
     * This exists because `force` means two things to the driver, and only one
     * of them belongs to an internal caller. `force` skips the ack wait AND
     * halves the post-kill verify budget (`tmux-driver.ts:571`) — and that
     * verify is what catches a supervised process respawning behind us. An
     * orchestrator that has already done the asking wants the first half and
     * must not silently buy the second: a shorter verify makes a false "kill
     * succeeded" more likely, and FORCE SKIPS WAITING, NEVER EVIDENCE.
     *
     * So `team_stop`, `team_layout` and `peer_restart` pin `skipCourtesy: true`
     * and pass `force` through unchanged, which reproduces their v0.11.14
     * behaviour exactly. A human still says `force: true` and gets both.
     */
    skipCourtesy: z.boolean().default(false),
    /** How long the peer gets to ack before the stop is reported as failed. */
    ackTimeoutMs: z.number().int().positive().max(600_000).optional(),
    ackPollMs: z.number().int().positive().max(10_000).optional(),
    /**
     * v0.10.1: keep the peer in state.peers with status:"stopped" instead
     * of deleting it. Used by team_stop so that team_layout apply can
     * resume the same handle later. Default false = original delete
     * semantics (backward-compatible with v0.10.0-rc.2 callers).
     */
    keepInState: z.boolean().default(false),
    /**
     * Only meaningful when keepInState:true — sets the resulting
     * PeerRecord.stoppedCleanly.
     *
     * Honoured in FORCE mode only. In the graceful path this handler measures
     * the outcome itself (an ack arrived, or it did not), and a measurement
     * does not take instructions from its caller. Passing it alongside
     * `force:false` is ignored, deliberately: the alternative is a record whose
     * `stoppedCleanly` says whatever the caller hoped for.
     */
    stoppedCleanly: z.boolean().nullable().optional(),
  })
  .strict();

export type PeerStopArgs = z.infer<typeof PeerStopArgsSchema>;

// Resolution lives in peer-ref.ts — see there for why a duplicate name must
// refuse rather than pick the first match.

/** The team of whoever sent this request — the search domain for short names. */
function callerTeamOf(req: RequestEnvelope, ctx: HandlerContext): string | null {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}

type CourtesyOutcome =
  /** `force:true` or `skipCourtesy:true` — nobody asked, here. */
  | { kind: "skipped" }
  /** No host session to ask. The kill is bookkeeping over something already gone. */
  | { kind: "no-host" }
  /** The peer said it was ready. */
  | { kind: "acked"; threadId: string; waitedMs: number; resumed: boolean }
  /** The peer did not say it was ready. NOTHING may be killed on this outcome. */
  | {
      kind: "no-ack";
      threadId: string;
      timeoutMs: number;
      waitedMs: number;
      ackVerdict: string;
      ackThreadId: string | null;
      resumed: boolean;
    };

/**
 * Ask the peer to stand down, and wait.
 *
 * The idempotency rule, which is the part worth reading twice: if the record
 * already carries a `stopRequest`, this RESUMES it — same thread, same clock,
 * no second message, NO SWEEP. Sweeping on a resume would delete the very ack
 * we came back for, which is the exact shape of the stale-ack fix applied
 * backwards. A peer that acked ninety seconds after the first call gave up is
 * answering a question that was asked once, and the retry is what collects it.
 */
async function runCourtesyPhase(
  req: RequestEnvelope,
  ctx: HandlerContext,
  target: { handle: string; sessionKey: string; record: PeerRecord },
  args: PeerStopArgs,
): Promise<CourtesyOutcome> {
  const { handle, sessionKey, record } = target;

  // Nobody home: no request can be delivered and no ack can arrive. Killing is
  // then pure bookkeeping over a session that is already gone, and making the
  // operator wait 120 s to be told so would be theatre.
  const alive = record.observed.tmuxTarget
    ? await ctx.hostDriver.hasSession(sessionKey).catch(() => false)
    : false;
  if (!alive) return { kind: "no-host" };

  // The BRIDGE address, not the registry key (v0.11.18). For a handle-keyed
  // peer these differ and the request lands in an inbox nobody drains.
  const bridgeId = bridgeIdOf(record);
  const timeoutMs = args.ackTimeoutMs ?? DEFAULT_STOP_ACK_TIMEOUT_MS;
  const pollMs = args.ackPollMs ?? DEFAULT_STOP_ACK_POLL_MS;
  await mkdir(stopAcks.dir(), { recursive: true });

  const pending = record.observed.stopRequest ?? null;
  const resumed = pending !== null;
  let threadId: string;
  let requestedAtMs: number;

  if (pending) {
    threadId = pending.threadId;
    requestedAtMs = Date.parse(pending.requestedAt);
    if (Number.isNaN(requestedAtMs)) requestedAtMs = Date.now() - timeoutMs;
    await writeEvent({
      event: "peer_stop_request_resumed",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle,
        sessionKey,
        threadId,
        originallyRequestedAt: pending.requestedAt,
        note: "A stop was already pending for this peer. Waiting on the same thread — no second request was written.",
      },
    });
  } else {
    // Clear the ground first. Everything after this point is an answer to THIS
    // request, without anyone having to reason about clocks.
    const swept = await stopAcks.sweepStale(bridgeId, "stale");
    if (swept) {
      await writeEvent({
        event: "peer_stop_stale_ack_swept",
        level: "warn",
        by: {
          sessionId: req.requestedBy.sessionId,
          name: req.requestedBy.name,
        },
        requestId: req.id,
        details: { handle, movedTo: swept },
      });
    }
    // Taken BEFORE the request is written, so an ack the peer produces the
    // instant it reads the message still counts.
    requestedAtMs = Date.now();
    threadId = stopThreadId(handle, requestedAtMs);
    const msgId = await requestStop(bridgeId, threadId, args.reason ?? null);
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[handle];
      if (rec) {
        rec.observed.status = "stopping";
        rec.observed.stopRequest = {
          threadId,
          msgId,
          requestedAt: new Date(requestedAtMs).toISOString(),
          timeoutMs,
        };
        rec.observed.lastUpdatedAt = new Date().toISOString();
      }
    });
    await writeEvent({
      event: "peer_stop_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, threadId, msgId, timeoutMs },
    });
  }

  const startedWaitingAt = Date.now();
  const verdict = await stopAcks.poll(
    bridgeId,
    startedWaitingAt + timeoutMs,
    pollMs,
    requestedAtMs,
    threadId,
  );
  const waitedMs = Date.now() - startedWaitingAt;
  if (!verdict.accepted) {
    return {
      kind: "no-ack",
      threadId,
      timeoutMs,
      waitedMs,
      ackVerdict: verdict.reason,
      ackThreadId: verdict.ackThreadId ?? null,
      resumed,
    };
  }
  await stopAcks.consume(bridgeId);
  return { kind: "acked", threadId, waitedMs, resumed };
}

/**
 * Počká, až proces zmizí — a řekne, jestli zmizel.
 *
 * Zabití je asynchronní: signál doletí, proces má chvíli na doběhnutí.
 * Krátká sonda v cyklu je proto poctivější než jedno čtení hned po killu,
 * které by z „ještě doumírá" udělalo „přežil".
 */
const PROCESS_GONE_BUDGET_MS = 3_000;
const PROCESS_GONE_POLL_MS = 100;

async function awaitProcessGone(mark: ProcessMark, procRoot: string): Promise<boolean> {
  const deadline = Date.now() + PROCESS_GONE_BUDGET_MS;
  while (Date.now() < deadline) {
    if (!markedProcessAlive(mark, procRoot)) return true;
    await new Promise((r) => setTimeout(r, PROCESS_GONE_POLL_MS));
  }
  return !markedProcessAlive(mark, procRoot);
}

/**
 * Drží ten hostitelský cíl proces, který máme v záznamu?
 *
 * Porovnává se PŘES PŘEDKY: v panelu bývá mezi tmuxem a peerem ještě shell
 * nebo obal, takže „pane_pid se nerovná našemu pidu" samo o sobě rozchod
 * neznamená (týž argument jako `ownsProcess` v `team_reconcile`).
 *
 * Vrací `null`, když se to zjistit nedá — driver okna neumí vypsat, cíl
 * v seznamu není, nebo panel drží mrtvolu. Nevědomost není rozchod.
 */
async function targetHoldsPid(
  ctx: HandlerContext,
  sessionKey: string,
  mark: ProcessMark | null,
  procRoot: string,
): Promise<boolean | null> {
  if (mark === null || !ctx.hostDriver.listWindows) return null;
  let windows: Awaited<ReturnType<NonNullable<typeof ctx.hostDriver.listWindows>>>;
  try {
    windows = await ctx.hostDriver.listWindows();
  } catch {
    return null;
  }
  const here = windows.find((w) => w.target === sessionKey);
  if (!here || here.pid === null || here.dead) return null;
  if (here.pid === mark.pid) return true;
  if (!markedProcessAlive(mark, procRoot)) return null; // náš proces už neběží — není co srovnávat
  try {
    const inspector = ctx.processInspector ?? defaultProcessInspector();
    const ancestors = await inspector.ancestorsOf(mark.pid);
    return ancestors.includes(here.pid);
  } catch {
    return null;
  }
}

export async function handlePeerStop(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = PeerStopArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf(req, ctx));
  if (resolved.kind === "ambiguous") {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        peer: args.peer,
        reason: "ambiguous_peer",
        candidates: resolved.candidates,
      },
    });
    return errResult(
      req.id,
      req.tool,
      "ambiguous_peer",
      ambiguousPeerMessage(args.peer, resolved.candidates),
      { peer: args.peer, candidates: resolved.candidates },
    );
  }
  const found = resolved.kind === "found" ? resolved : null;
  if (!found) {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "info",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { peer: args.peer, reason: "peer_not_found" },
    });
    const unresolved = await unresolvedPeerError(args.peer);
    return errResult(req.id, req.tool, unresolved.code, unresolved.message, unresolved.details);
  }
  const handle = found.handle;
  const record = ctx.state.peers[handle];
  if (!record) {
    // Race: peer disappeared between findPeer and now. Treat as success.
    return okResult(req.id, req.tool, { handle, alreadyGone: true });
  }
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;
  const forceFlag = args.force === true;

  // ---------------------------------------------------------------------
  // Evidence before force (v0.11.27) — the 2026-08-11 incident.
  // ---------------------------------------------------------------------
  //
  // `force` skips the courtesy phase, so nothing else in this handler ever
  // looks at whether the peer is alive. On 2026-08-11 a resurrected background
  // session used exactly that to kill a live peer on the strength of its own
  // conclusion — "a zombie after the nightly crash" — which three independent
  // measurements of the victim's heartbeat contradicted.
  //
  // The fix is not to forbid force. A peer stuck on a modal dialog also
  // heartbeats, and killing its process is the only way out; that case is real
  // and happened the day before. The fix is that a caller must SAY it is
  // killing something alive, so the claim is testable and the act is auditable.
  //
  // Deliberately asymmetric: a refused stop costs one retry with one flag, a
  // wrongful kill costs a peer its session. And a peer that stopped
  // heartbeating is not protected at all — the whole point is to distinguish
  // "looks dead" from "is dead".
  if (forceFlag && !args.overrideLiveness) {
    const liveness = await resolvePeer(record.observed.sessionId ?? handle);
    const ageMs = liveness.outcome === "found" ? liveness.peer.lastSeenAgeMs : null;
    if (ageMs !== null && ageMs < LIVE_HEARTBEAT_MS) {
      await writeEvent({
        event: "peer_stop_refused_alive",
        level: "warn",
        by: {
          sessionId: req.requestedBy.sessionId,
          name: req.requestedBy.name,
        },
        requestId: req.id,
        details: {
          handle,
          sessionKey,
          lastSeenAgeMs: ageMs,
          thresholdMs: LIVE_HEARTBEAT_MS,
        },
      });
      return errResult(
        req.id,
        req.tool,
        "peer_alive",
        `Refusing to force-stop '${record.observed.name}': its heartbeat is ${ageMs} ms old, so it is demonstrably alive. If you mean to kill a live peer anyway — a peer stuck on a modal dialog is the usual reason — repeat with overrideLiveness:true, which records the kill as an override.`,
        { handle, lastSeenAgeMs: ageMs, thresholdMs: LIVE_HEARTBEAT_MS },
      );
    }
  }
  // An override that got this far killed something alive on purpose. Say so
  // separately from the stop itself, so the audit trail can be searched for
  // the deliberate ones without reading every stop.
  if (forceFlag && args.overrideLiveness) {
    await writeEvent({
      event: "peer_stop_liveness_overridden",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, reason: args.reason ?? null },
    });
  }

  // ---------------------------------------------------------------------
  // The courtesy phase.
  // ---------------------------------------------------------------------
  //
  // Three ways out, and only one of them kills anything:
  //   acked   → the peer put its work down; proceed to kill, stoppedCleanly:true
  //   no host → there is nobody to ask; proceed to kill, stoppedCleanly:null
  //   timeout → RETURN. Nothing killed, nothing lost, state says a stop is
  //             pending and a retry resumes the same request.
  let courtesy: CourtesyOutcome = { kind: "skipped" };
  if (!forceFlag && !args.skipCourtesy) {
    courtesy = await runCourtesyPhase(req, ctx, { handle, sessionKey, record }, args);
    if (courtesy.kind === "no-ack") {
      // The honest verdict, and the whole reason the graceful path is worth
      // having: a stop that did not happen must not read like one that did.
      await writeEvent({
        event: "stop_ack_timeout",
        level: "warn",
        by: {
          sessionId: req.requestedBy.sessionId,
          name: req.requestedBy.name,
        },
        requestId: req.id,
        details: {
          handle,
          sessionKey,
          threadId: courtesy.threadId,
          timeoutMs: courtesy.timeoutMs,
          waitedMs: courtesy.waitedMs,
          ackVerdict: courtesy.ackVerdict,
          ackThreadId: courtesy.ackThreadId,
          resumed: courtesy.resumed,
        },
      });
      // WHY there was no usable ack, not just that there wasn't one — the same
      // distinction `peer_compact` learned to draw. "Nobody answered" and "an
      // ack was there and it was not yours" call for different next steps.
      const why =
        courtesy.ackVerdict === "wrong_thread"
          ? `an ack exists but answers thread '${courtesy.ackThreadId}', not '${courtesy.threadId}' — another stop is running on this peer`
          : courtesy.ackVerdict === "too_old"
            ? "an ack exists but predates this request — it answers something else"
            : `the peer did not ack within ${courtesy.timeoutMs}ms`;
      return errResult(
        req.id,
        req.tool,
        "stop_ack_timeout",
        `Peer '${handle}' is STILL RUNNING and nothing was killed: ${why}. The request stands — call peer_stop again to keep waiting on the same thread (a late ack still counts), or peer_stop with force:true to end the session now and lose whatever the peer had not written down.`,
        {
          handle,
          sessionKey,
          stopped: false,
          processLeftRunning: true,
          threadId: courtesy.threadId,
          waitedMs: courtesy.waitedMs,
          ackVerdict: courtesy.ackVerdict,
          retryIsIdempotent: true,
        },
      );
    }
  }

  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[handle];
    if (rec) {
      rec.observed.status = "stopping";
      rec.observed.lastUpdatedAt = new Date().toISOString();
    }
  });

  // 🔴 IDENTITU PROCESU SI VEZMI DŘÍV, NEŽ HO ZABIJEŠ (v0.11.40).
  //
  // 29. 8. přežil restart starý plt-velitel a běžel souběžně s novým nad
  // JEDNÍM transkriptem — dvojí `--resume`, dvojí drain fronty. Stop přitom
  // hlásil úspěch, protože `stoppedCleanly` měří SOUHLAS peera (ack), ne jeho
  // smrt, a nikdo se pak už nezeptal, jestli ten proces zmizel.
  //
  // Dvojice (pid, čas startu) se bere PŘED zabitím, aby recyklovaný pid
  // nemohl vypadat jako přeživší — pidy se recyklují a moje vlastní úvaha
  // opřená o pořadí pidů byla téhož dne vyvrácena.
  // `procRoot` z kontextu, ne natvrdo: testy tím míří na přípravek místo na
  // živý systém — a bez toho by fixture s `pid: 100` (což je na Linuxu ŽIVÉ
  // jádrové vlákno) hlásil přeživšího peera. Vymyšlené číslo v testu může být
  // skutečný pid; táž rodina jako recyklace pidů.
  const procRoot = ctx.procRoot ?? "/proc";
  const markBefore =
    record.observed.pid !== null ? markProcess(record.observed.pid, procRoot) : null;

  // 🔴 BRÁNA PŘED KILLEM: DRŽÍ TEN CÍL NAŠEHO PEERA? (v0.11.40)
  //
  // `team_reconcile` tenhle rozchod detekuje jako `pid_changed` a já si u něj
  // sám napsal, že je „ten nebezpečný, protože každé volání lifecyclu by pak
  // sáhlo na peera, kterého nikdo nemyslel". Napsal jsem to o DETEKCI a do
  // lifecyclu to nezavedl — 29. 8. se to vybralo.
  //
  // Škoda je jiná než u přeživšího procesu a proto se hlídá ZVLÁŠŤ: tam náš
  // peer nezemře, tady zemře CIZÍ. Ověření po killu tu druhou nezachytí.
  //
  // `null` = nevíme (driver okna neumí vypsat, nebo cíl v seznamu není);
  // z nevědomosti se odmítnutí nedělá — jen se zapíše.
  const targetHoldsRecordedPid = await targetHoldsPid(ctx, sessionKey, markBefore, procRoot);
  if (targetHoldsRecordedPid === false) {
    await writeEvent({
      event: "peer_stop_target_mismatch",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, pid: markBefore?.pid ?? null },
    });
    return errResult(
      req.id,
      req.tool,
      "target_holds_another_process",
      `Refusing to stop '${handle}': its recorded host target ${sessionKey} is held by a DIFFERENT process than the recorded pid ${markBefore?.pid}. Killing it would take down whoever is in there now, and would not stop this peer. Run \`team_reconcile\` to see the drift, then stop the peer by its real target.`,
      { handle, sessionKey, pid: markBefore?.pid ?? null },
    );
  }
  let killOutcome: KillOutcome;
  try {
    killOutcome = await ctx.hostDriver.kill(sessionKey, { force: forceFlag });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Special case: driver's verify caught a respawn (bg-pty-host class).
    // Leave state.peers as `stopping` — an operator has to intervene
    // manually. Emit the loudest event we have.
    if (msg.includes("respawn")) {
      await writeEvent({
        event: "peer_stop_respawn_detected",
        level: "error",
        by: {
          sessionId: req.requestedBy.sessionId,
          name: req.requestedBy.name,
        },
        requestId: req.id,
        details: { handle, sessionKey, err: msg },
      });
      return errResult(req.id, req.tool, "supervisor_respawn", msg, {
        handle,
        sessionKey,
      });
    }
    await writeEvent({
      event: "peer_stop_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, err: msg },
    });
    return errResult(req.id, req.tool, "host_kill_failed", msg, {
      handle,
      sessionKey,
    });
  }

  // ---------------------------------------------------------------------
  // Zemřel ten proces?
  // ---------------------------------------------------------------------
  //
  // Tohle je ta otázka, kterou se do 29. 8. nikdo neptal. `kill` vrací
  // verdikt (`target-missing`, `unlinked-not-killed`) a i po `killed` se
  // smrt OVĚŘUJE — reprodukováno naživo: cíl, který neexistuje, i okno
  // nalinkované do druhé session projdou bez chyby a peer běží dál.
  //
  // `null` = nevíme (záznam pid nenesl). NENÍ to „umřel".
  const pidBeforeDead = markBefore === null ? null : await awaitProcessGone(markBefore, procRoot);
  if (pidBeforeDead === false) {
    await writeEvent({
      event: "peer_stop_process_survived",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle,
        sessionKey,
        pid: markBefore?.pid ?? null,
        killOutcome,
      },
    });
    return errResult(
      req.id,
      req.tool,
      "process_survived_stop",
      `Peer '${handle}' still has a LIVE process ${markBefore?.pid} after the stop (kill outcome: ${killOutcome}). ${
        killOutcome === "unlinked-not-killed"
          ? "Its window is linked into another tmux session, so it was unlinked rather than killed — killing it would have removed the window from that session too. "
          : killOutcome === "target-missing"
            ? "The recorded host target no longer exists, so nothing was killed — the process is living somewhere the record does not name. "
            : ""
      }The record is NOT marked stopped: two processes on one transcript is the failure this refuses to hide. Find the pane with \`tmux list-panes -a -F '#{pane_pid} #{window_id} #{session_name}'\` and stop it by hand.`,
      {
        handle,
        sessionKey,
        pid: markBefore?.pid ?? null,
        killOutcome,
        pidBeforeDead,
      },
    );
  }

  const keepInState = args.keepInState;
  // MEASURED beats DECLARED.
  //
  // When this handler ran the courtesy phase itself, it knows whether an ack
  // arrived and the caller's opinion is not consulted. Only a forced stop —
  // where the politeness happened somewhere else, or not at all — falls back to
  // what the caller says it observed.
  const measuredCleanly =
    courtesy.kind === "acked" ? true : courtesy.kind === "no-host" ? null : undefined;
  const stoppedCleanly = keepInState
    ? (measuredCleanly ?? args.stoppedCleanly ?? null)
    : (measuredCleanly ?? undefined);
  await applyStateChange(ctx.state, (draft) => {
    if (keepInState) {
      const rec = draft.peers[handle];
      if (rec) {
        rec.observed.status = "stopped";
        rec.observed.stoppedCleanly = stoppedCleanly ?? null;
        rec.observed.pid = null;
        // The stop resolved: the pending request is history, not state. Leaving
        // it would make the next call resume a thread that is already answered.
        rec.observed.stopRequest = null;
        // And a stopped peer has no restart underway (v0.11.18). This is also
        // the operator's way out of a mark left by a daemon that died mid
        // restart: stop the peer, and the control plane stops claiming an
        // operation is in flight behind it.
        rec.observed.restartRequest = null;
        rec.observed.lastUpdatedAt = new Date().toISOString();
      }
    } else {
      delete draft.peers[handle];
    }
  });
  // HOW it was stopped, in one word, so a reader of the audit log never has to
  // infer it from a combination of flags.
  const mode =
    courtesy.kind === "acked"
      ? "graceful"
      : courtesy.kind === "no-host"
        ? "already-gone"
        : "forced";
  const ackWaitedMs = courtesy.kind === "acked" ? courtesy.waitedMs : null;
  const threadId = courtesy.kind === "acked" ? courtesy.threadId : null;
  const details = {
    handle,
    sessionKey,
    reason: args.reason ?? null,
    force: forceFlag,
    keepInState,
    // 🔴 `stoppedCleanly` MĚŘÍ SOUHLAS, NE SMRT — peer potvrdil, že měl šanci
    // uložit práci. Čte se jako doklad o teardownu (29. 8. tak přečten
    // velitelem), a proto vedle něj od v0.11.40 stojí `pidBeforeDead`, které
    // měří to druhé. Jedno pole na jednu otázku.
    stoppedCleanly,
    /** Zemřel proces, který tu byl před stopem? `null` = záznam pid nenesl. */
    pidBeforeDead,
    /** Držel cíl náš proces, než jsme zabíjeli? `null` = nešlo zjistit. */
    targetHoldsRecordedPid,
    /** Co kill udělal: killed | target-missing | unlinked-not-killed. */
    killOutcome,
    pidBefore: markBefore?.pid ?? null,
    mode,
    ackWaitedMs,
    threadId,
  };
  await writeEvent({
    event: "peer_stopped",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details,
  });
  await publishLifecycleEvent({
    event: "peer_stopped",
    handle,
    sessionKey,
    details: {
      reason: args.reason ?? null,
      force: forceFlag,
      keepInState,
      stoppedCleanly,
      mode,
    },
  });
  return okResult(req.id, req.tool, {
    handle,
    sessionKey,
    stopped: true,
    mode,
    force: forceFlag,
    keepInState,
    stoppedCleanly,
    // Dvě různé otázky, dvě pole: souhlas × smrt. Viz `details` výš.
    pidBeforeDead,
    killOutcome,
    ackWaitedMs,
    threadId,
  });
}

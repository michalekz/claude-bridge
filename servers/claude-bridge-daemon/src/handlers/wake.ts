import { randomBytes } from "node:crypto";
import { syntheticSenderId, writeEnvelope } from "@claude-bridge/shared";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";

/**
 * Waking a resumed peer (v0.10.1).
 *
 * A resumed Claude Code session is SILENT. `--resume` restores the transcript
 * and the process, but nothing runs until a turn is triggered from outside —
 * so an inbox message alone is never read, and a peer's own "I'll report after
 * restart" instruction in its anchor never fires. Observed live during the
 * 2026-08-02 tmux consolidation: every peer came back up and sat at the prompt.
 *
 * So waking is two halves and needs both:
 *   1. the bridge inbox message — durable, auditable, carries the payload;
 *   2. a key injection into the pane — the impulse that makes the peer take a
 *      turn, at which point it drains its inbox and finds (1).
 *
 * The injection goes through `driver.sendKeys`, so the verified-send layer
 * (copy-mode guard + post-send capture check + per-session log) upgrades this
 * path automatically once it lands.
 */

/**
 * How long to wait after spawn before injecting keys.
 *
 * `tmux new-session` returns as soon as the pane exists — Claude Code has not
 * booted, loaded plugins or connected MCP yet. Keys sent into that window land
 * in a shell that is about to be replaced, or in a CC that is not accepting
 * input, and are silently lost. This is the same class of failure as the
 * team-stop.sh `/exit` that never arrived on 2026-08-02.
 *
 * 🔴 AND THIS IS WHY `force` DOES NOT SKIP IT (v0.11.18). The ratified force
 * inventory lists this delay as something force may skip, and that reading does
 * not survive contact with what the delay is for. It is not a courtesy wait —
 * it is the condition under which the injection LANDS. Skipping it does not buy
 * time, it buys a message that was written, logged as injected, and never seen.
 *
 * Force skips waiting, never evidence. A wake that arrives nowhere is the
 * absence of evidence, and it matters most in exactly the case force is used:
 * after a forced restart, this message is what tells the peer its anchor may be
 * half-written.
 */
export const DEFAULT_WAKE_DELAY_MS = 8_000;

/** Default text injected into the pane. Deliberately short — it is typed. */
export const DEFAULT_WAKE_PROMPT =
  "[daemon] Wake — you were resumed from a stopped state. Re-onboard from your anchor, read your inbox (peer_inbox_read) and report to whoever woke you.";

/**
 * The injected text after a restart. The inbox message carries the detail —
 * this only has to make the peer take a turn and know which detail to look for.
 */
export const RESTART_WAKE_PROMPT =
  "[daemon] Restart complete — same session, new process. Re-onboard from your anchor, read your inbox (peer_inbox_read) and report to whoever restarted you.";

export interface WakePeerOptions {
  /**
   * The peer's BRIDGE address — `bridgeIdOf(record)`, NOT the registry key
   * (R3, v0.11.21).
   *
   * This field was called `sessionId` and both callers handed it a handle, so
   * the wake message after a restart or a layout resume landed in
   * `inbox/<handle>/pending/` — a directory nobody drains. The peer came back,
   * was never told why, and no error was raised anywhere.
   *
   * The same defect acceptance found in `peer_restart` on 2026-08-08, in the
   * step of that very protocol that reports the outcome to the peer. v0.11.18
   * fixed the three places it looked at and this was the fourth: a rule kept by
   * memory holds until the next caller, and step g) WAS the next caller.
   *
   * Renamed rather than merely reassigned, because a caller that hands a handle
   * to a field named `bridgeId` has to notice what it is doing.
   */
  bridgeId: string;
  sessionKey: string;
  /** Reason recorded in the inbox message and the audit events. */
  reason: string;
  /**
   * From `PeerRecord.stoppedCleanly`. When `false` the peer never completed
   * its stop-ack cycle, so its anchor and memory may be mid-write — the wake
   * message says so explicitly instead of letting it resume blind.
   */
  stoppedCleanly?: boolean | null;
  /**
   * What happened to this peer, so the message can say it (v0.11.18, step g).
   *
   * `"resumed"` — it was stopped, and later started again by something else.
   * `"restarted"` — one operation took it down and brought it back, and it
   * knows that because it was ASKED first (or, under force, was not).
   *
   * The distinction is not decoration. A peer that reads "you were resumed from
   * a stopped state" after a restart it acked has to work out what happened; a
   * peer told plainly that its restart is finished can just carry on.
   */
  event?: "resumed" | "restarted";
  /** Override the injected text. */
  wakePrompt?: string;
  /** Override the post-spawn settle delay. `0` disables the wait (tests). */
  wakeDelayMs?: number;
}

export interface WakeOutcome {
  /** Who was woken, as the BRIDGE addresses them — see `WakePeerOptions`. */
  bridgeId: string;
  wakeMsgId: string | null;
  injected: boolean;
  error?: string;
}

function generateMsgId(): string {
  const ms = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ms}-${rand}`;
}

/**
 * The wake message, in the one envelope shape the recipient can read.
 *
 * This built its own object and wrote it with a raw `atomicWriteJson`, exactly
 * as `peer-compact.ts` did, and disagreed with `MessageEnvelopeSchema` the same
 * five ways: `from`/`to` as `{sessionId, name}`, `ts` instead of `sentAt`,
 * an object `content`, and a `kind` outside the enum.
 *
 * `readEnvelope` `safeParse`s and returns null, so the recipient never saw it.
 * Waking therefore only ever worked by half: the key injection made the peer
 * take a turn, and the message explaining WHY it had been woken was silently
 * absent — including the warning that its previous stop was forced and its
 * anchor may be mid-write. That warning is a safety instruction, not a note.
 *
 * Two hand-rolled writers, both wrong, is not a coincidence — it is a missing
 * rule. Nothing writes into an inbox except `writeEnvelope`, which `parse`s and
 * so fails at the writer rather than vanishing at the reader.
 *
 * The payload is a string because the recipient renders it as text. Structured
 * fields that only a parser would find were part of how this went unnoticed.
 */
async function writeWakeMsg(opts: WakePeerOptions, threadId: string): Promise<string> {
  const msgId = generateMsgId();
  const dirty = opts.stoppedCleanly === false;
  const restarted = opts.event === "restarted";
  const lines = restarted
    ? [
        "Your restart is complete — same session, same transcript, new process.",
        "Re-onboard from your anchor before doing anything else, then report to",
        "whoever restarted you.",
        "",
        `Reason: ${opts.reason}`,
      ]
    : [
        "You were resumed from a stopped state. Re-onboard from your anchor before",
        "doing anything else, then report to whoever woke you.",
        "",
        `Reason: ${opts.reason}`,
      ];
  if (dirty) {
    lines.push(
      "",
      restarted
        ? "⚠ This restart was FORCED — you were not asked to get ready, so whatever you"
        : "⚠ Your previous stop was FORCED — you did not complete the stop-ack cycle,",
      restarted
        ? "had not written down at that moment is gone. YOUR ANCHOR MAY BE MID-WRITE OR"
        : "so your anchor and memory may be incomplete or mid-write. Verify them",
      restarted
        ? "STALE — verify it against reality before you build on it."
        : "before trusting them.",
    );
  } else if (opts.stoppedCleanly === true) {
    lines.push(
      "",
      restarted
        ? "You acknowledged the restart request, so your anchor should be whole."
        : "Your previous stop completed its ack cycle, so your anchor should be whole.",
    );
  }
  await writeEnvelope({
    id: msgId,
    from: syntheticSenderId("control-plane-daemon"),
    fromName: "control-plane-daemon",
    to: opts.bridgeId,
    kind: "ask",
    sentAt: new Date().toISOString(),
    threadId,
    content: lines.join("\n"),
  });
  return msgId;
}

/**
 * Deliver a wake to a freshly-resumed peer: inbox message, then key injection.
 *
 * Never throws — a failed wake leaves a running peer that simply has not been
 * prompted yet, which an operator can fix by hand. Callers get the outcome so
 * they can report which peers came back silent.
 */
export async function wakePeer(
  req: RequestEnvelope,
  ctx: HandlerContext,
  opts: WakePeerOptions,
): Promise<WakeOutcome> {
  const threadId = `wake:${opts.bridgeId}:${Date.now().toString(36)}`;

  let wakeMsgId: string | null = null;
  try {
    wakeMsgId = await writeWakeMsg(opts, threadId);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_wake_failed",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { bridgeId: opts.bridgeId, stage: "inbox_write", err },
    });
    return { bridgeId: opts.bridgeId, wakeMsgId: null, injected: false, error: err };
  }

  const sendKeys = ctx.hostDriver.sendKeys?.bind(ctx.hostDriver);
  if (!sendKeys) {
    // Inbox message is written; without send-keys it will be delivered on the
    // peer's next turn — whenever a human happens to trigger one.
    await writeEvent({
      event: "peer_wake_not_injected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        bridgeId: opts.bridgeId,
        wakeMsgId,
        hostDriver: ctx.hostDriver.name,
        note: "driver has no send-keys — peer stays silent until a turn is triggered by hand",
      },
    });
    return { bridgeId: opts.bridgeId, wakeMsgId, injected: false };
  }

  const delay = opts.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));

  const prompt = opts.wakePrompt ?? DEFAULT_WAKE_PROMPT;
  // Charter §8 audit checkpoint — record the EXACT keys before injecting them.
  await writeEvent({
    event: "peer_wake_inject",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      bridgeId: opts.bridgeId,
      sessionKey: opts.sessionKey,
      threadId,
      wakeMsgId,
      injectedKeys: prompt,
      delayMs: delay,
    },
  });

  try {
    await sendKeys(opts.sessionKey, prompt);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_wake_failed",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { bridgeId: opts.bridgeId, sessionKey: opts.sessionKey, stage: "send_keys", err },
    });
    return { bridgeId: opts.bridgeId, wakeMsgId, injected: false, error: err };
  }

  await writeEvent({
    event: "peer_woken",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      bridgeId: opts.bridgeId,
      sessionKey: opts.sessionKey,
      threadId,
      wakeMsgId,
      reason: opts.reason,
      stoppedCleanly: opts.stoppedCleanly ?? null,
      wakeKind: opts.event ?? "resumed",
    },
  });
  await publishLifecycleEvent({
    event: "peer_woken",
    handle: opts.bridgeId,
    sessionKey: opts.sessionKey,
    details: { reason: opts.reason, stoppedCleanly: opts.stoppedCleanly ?? null },
  });
  return { bridgeId: opts.bridgeId, wakeMsgId, injected: true };
}

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteJson, bridgeRoot } from "@claude-bridge/shared";
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
 */
export const DEFAULT_WAKE_DELAY_MS = 8_000;

/** Default text injected into the pane. Deliberately short — it is typed. */
export const DEFAULT_WAKE_PROMPT =
  "[daemon] Wake — you were resumed from a stopped state. Re-onboard from your anchor, read your inbox (peer_inbox_read) and report to whoever woke you.";

export interface WakePeerOptions {
  sessionId: string;
  sessionKey: string;
  /** Reason recorded in the inbox message and the audit events. */
  reason: string;
  /**
   * From `PeerRecord.stoppedCleanly`. When `false` the peer never completed
   * its stop-ack cycle, so its anchor and memory may be mid-write — the wake
   * message says so explicitly instead of letting it resume blind.
   */
  stoppedCleanly?: boolean | null;
  /** Override the injected text. */
  wakePrompt?: string;
  /** Override the post-spawn settle delay. `0` disables the wait (tests). */
  wakeDelayMs?: number;
}

export interface WakeOutcome {
  sessionId: string;
  wakeMsgId: string | null;
  injected: boolean;
  error?: string;
}

function inboxPendingDir(peerId: string): string {
  return join(bridgeRoot(), "inbox", peerId, "pending");
}

function generateMsgId(): string {
  const ms = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ms}-${rand}`;
}

async function writeWakeMsg(opts: WakePeerOptions, threadId: string): Promise<string> {
  const msgId = generateMsgId();
  const dirty = opts.stoppedCleanly === false;
  const envelope = {
    id: msgId,
    ts: new Date().toISOString(),
    from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
    to: { sessionId: opts.sessionId, name: opts.sessionId },
    kind: "peer-wake",
    threadId,
    content: {
      instruction:
        "You were resumed from a stopped state. Re-onboard from your anchor before doing anything else, then report to whoever woke you.",
      reason: opts.reason,
      stoppedCleanly: opts.stoppedCleanly ?? null,
      ...(dirty
        ? {
            warning:
              "Your previous stop was FORCED — you did not complete the stop-ack cycle, so your anchor and memory may be incomplete or mid-write. Verify them before trusting them.",
          }
        : {}),
    },
  };
  await atomicWriteJson(join(inboxPendingDir(opts.sessionId), `${msgId}.json`), envelope);
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
  const threadId = `wake:${opts.sessionId}:${Date.now().toString(36)}`;

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
      details: { sessionId: opts.sessionId, stage: "inbox_write", err },
    });
    return { sessionId: opts.sessionId, wakeMsgId: null, injected: false, error: err };
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
        sessionId: opts.sessionId,
        wakeMsgId,
        hostDriver: ctx.hostDriver.name,
        note: "driver has no send-keys — peer stays silent until a turn is triggered by hand",
      },
    });
    return { sessionId: opts.sessionId, wakeMsgId, injected: false };
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
      sessionId: opts.sessionId,
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
      details: { sessionId: opts.sessionId, sessionKey: opts.sessionKey, stage: "send_keys", err },
    });
    return { sessionId: opts.sessionId, wakeMsgId, injected: false, error: err };
  }

  await writeEvent({
    event: "peer_woken",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      sessionId: opts.sessionId,
      sessionKey: opts.sessionKey,
      threadId,
      wakeMsgId,
      reason: opts.reason,
      stoppedCleanly: opts.stoppedCleanly ?? null,
    },
  });
  await publishLifecycleEvent({
    event: "peer_woken",
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    details: { reason: opts.reason, stoppedCleanly: opts.stoppedCleanly ?? null },
  });
  return { sessionId: opts.sessionId, wakeMsgId, injected: true };
}

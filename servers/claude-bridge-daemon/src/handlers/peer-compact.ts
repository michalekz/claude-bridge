import { randomBytes } from "node:crypto";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, bridgeRoot, controlDir } from "@claude-bridge/shared";
import { z } from "zod";
import { publishLifecycleEvent } from "../event-subscribers.ts";
import { writeEvent } from "../events.ts";
import type { RequestEnvelope, ResultEnvelope } from "../rpc.ts";
import { errResult, okResult } from "../rpc.ts";
import type { HandlerContext } from "./context.ts";

/**
 * peer_compact — orchestrated `/compact` inject into a live peer.
 *
 * §5.3 sequence:
 *   1. Write a bridge inbox message to the peer with
 *      `kind: "compact-anchor-request"` — the operator playbook tells
 *      peers to react by writing their compact anchor and then
 *      touching `~/.claude-bridge/control/compact-ack/<sessionId>.json`.
 *   2. Poll for the ack file within `anchorTimeoutMs` (default 30 s).
 *      No ack → refuse; the peer wasn't ready and injecting /compact
 *      without a durable anchor would lose context.
 *   3. Ack received → `driver.sendKeys(sessionKey, "/compact")` — the
 *      only send-keys path in the daemon (charter §8 audit target).
 *   4. Log `peer_compacted` event; publish lifecycle event to
 *      subscribers.
 *
 * The AUTO watchdog stays gated behind `config.compactWatchdog.enabled`
 * (default false) — this handler is only invoked directly. Ownership
 * of the flip is the owner's.
 */

const DEFAULT_ANCHOR_TIMEOUT_MS = 30_000;
const DEFAULT_ACK_POLL_MS = 500;
const COMPACT_ACK_FILENAME_EXTENSION = ".json";

export const PeerCompactArgsSchema = z
  .object({
    peer: z.string().min(1),
    anchorTimeoutMs: z.number().int().positive().max(300_000).optional(),
    ackPollMs: z.number().int().positive().max(10_000).optional(),
    /** Skip the anchor request → treat the ack file as pre-existing. */
    skipAnchorRequest: z.boolean().default(false),
    reason: z.string().optional(),
  })
  .strict();

export type PeerCompactArgs = z.infer<typeof PeerCompactArgsSchema>;

function compactAckDir(): string {
  return join(controlDir(), "compact-ack");
}

function compactAckPath(sessionId: string): string {
  return join(compactAckDir(), `${sessionId}${COMPACT_ACK_FILENAME_EXTENSION}`);
}

function inboxPendingDir(peerId: string): string {
  return join(bridgeRoot(), "inbox", peerId, "pending");
}

function generateMsgId(): string {
  const ms = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ms}-${rand}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pollForAck(sessionId: string, deadline: number, pollMs: number): Promise<boolean> {
  const path = compactAckPath(sessionId);
  while (Date.now() < deadline) {
    if (await fileExists(path)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return fileExists(path);
}

async function consumeAckFile(sessionId: string): Promise<void> {
  const src = compactAckPath(sessionId);
  const done = join(compactAckDir(), "done");
  try {
    await mkdir(done, { recursive: true });
    await rename(src, join(done, `${sessionId}-${Date.now()}.json`));
  } catch {
    // Fallback: unlink if rename didn't take (e.g. cross-fs on temp dirs).
    await unlink(src).catch(() => undefined);
  }
}

async function writeAnchorRequestMsg(peerId: string, threadId: string): Promise<string> {
  const msgId = generateMsgId();
  const envelope = {
    id: msgId,
    ts: new Date().toISOString(),
    from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
    to: { sessionId: peerId, name: peerId },
    kind: "compact-anchor-request",
    threadId,
    content: {
      instruction:
        "Write your compact anchor file and touch ~/.claude-bridge/control/compact-ack/<sessionId>.json when ready.",
    },
  };
  const path = join(inboxPendingDir(peerId), `${msgId}.json`);
  await atomicWriteJson(path, envelope);
  return msgId;
}

function findPeer(state: HandlerContext["state"], key: string): { sessionId: string } | null {
  if (state.peers[key]) return { sessionId: key };
  for (const [id, rec] of Object.entries(state.peers)) {
    if (rec.name === key) return { sessionId: id };
  }
  return null;
}

export async function handlePeerCompact(
  req: RequestEnvelope,
  ctx: HandlerContext,
): Promise<ResultEnvelope> {
  const parsed = PeerCompactArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues,
    });
  }
  const args = parsed.data;
  const found = findPeer(ctx.state, args.peer);
  if (!found) {
    return errResult(
      req.id,
      req.tool,
      "peer_not_found",
      `No peer with id/name '${args.peer}' in daemon state`,
      { peer: args.peer },
    );
  }
  const sessionId = found.sessionId;
  const record = ctx.state.peers[sessionId];
  if (!record) {
    return errResult(req.id, req.tool, "peer_gone", "Peer disappeared before compact started", {
      sessionId,
    });
  }
  const sessionKey = record.tmuxTarget ?? record.name;
  const sendKeys = ctx.hostDriver.sendKeys?.bind(ctx.hostDriver);
  if (!sendKeys) {
    return errResult(
      req.id,
      req.tool,
      "sendkeys_unsupported",
      `Host driver '${ctx.hostDriver.name}' does not support send-keys on this platform`,
      { hostDriver: ctx.hostDriver.name },
    );
  }

  const anchorTimeoutMs = args.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
  const ackPollMs = args.ackPollMs ?? DEFAULT_ACK_POLL_MS;
  const threadId = `compact:${sessionId}:${Date.now().toString(36)}`;

  await mkdir(compactAckDir(), { recursive: true });

  let anchorMsgId: string | null = null;
  if (!args.skipAnchorRequest) {
    try {
      anchorMsgId = await writeAnchorRequestMsg(sessionId, threadId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeEvent({
        event: "peer_compact_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { sessionId, stage: "anchor_request", err: msg },
      });
      return errResult(req.id, req.tool, "anchor_request_write_failed", msg, { sessionId });
    }
    await writeEvent({
      event: "peer_compact_anchor_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, threadId, anchorMsgId, timeoutMs: anchorTimeoutMs },
    });
  }

  const deadline = Date.now() + anchorTimeoutMs;
  const acked = await pollForAck(sessionId, deadline, ackPollMs);
  if (!acked) {
    await writeEvent({
      event: "peer_compact_anchor_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, threadId, timeoutMs: anchorTimeoutMs },
    });
    return errResult(
      req.id,
      req.tool,
      "anchor_timeout",
      `Peer '${sessionId}' did not ack anchor within ${anchorTimeoutMs}ms`,
      { sessionId, threadId },
    );
  }

  // Charter §8 audit checkpoint — record the EXACT keys we're about to inject
  // BEFORE the send-keys call.
  await writeEvent({
    event: "peer_compact_inject",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId, sessionKey, threadId, injectedKeys: "[daemon] /compact" },
  });

  try {
    await sendKeys(sessionKey, "/compact");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_compact_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, stage: "send_keys", err: msg },
    });
    return errResult(req.id, req.tool, "send_keys_failed", msg, { sessionId, sessionKey });
  }
  await consumeAckFile(sessionId);
  await writeEvent({
    event: "peer_compacted",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId, sessionKey, threadId, reason: args.reason ?? null },
  });
  await publishLifecycleEvent({
    event: "peer_compacted",
    sessionId,
    sessionKey,
    details: { threadId, reason: args.reason ?? null },
  });
  return okResult(req.id, req.tool, { sessionId, sessionKey, threadId, anchorMsgId });
}

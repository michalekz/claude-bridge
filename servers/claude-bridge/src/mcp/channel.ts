import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { MessageEnvelope } from "../inbox/store.ts";
import { makeLogger } from "../util/logger.ts";

const log = makeLogger("channel");

/**
 * Experimental MCP push channel: `notifications/claude/channel`.
 *
 * Pushes inbound messages as user-visible content directly into the running
 * Claude Code session — bypassing the piggyback fallback (which only fires
 * when the user/agent calls another tool).
 *
 * Pre-requisite: Claude Code must be launched with
 *   --dangerously-load-development-channels plugin:claude-bridge
 *
 * Without that flag, server.notification() will return without delivering
 * (the client just ignores unknown notification methods). We don't fail —
 * the message stays in the inbox and piggyback consumption catches it on
 * the next tool call.
 *
 * Format (from Relay channel/notifications.ts):
 *   { method: "notifications/claude/channel",
 *     params: { content: string, meta: object } }
 */

export const CHANNEL_METHOD = "notifications/claude/channel";

export interface ChannelMeta {
  /** Sender peer id (sessionId UUID). */
  from: string;
  /** Sender display name at send time (snapshot). */
  fromName?: string;
  msgId: string;
  kind: string;
  inReplyTo?: string;
  threadId?: string;
  [key: string]: unknown;
}

export interface ChannelNotification {
  method: typeof CHANNEL_METHOD;
  params: {
    content: string;
    meta: ChannelMeta;
  };
}

export function buildChannelNotification(envelope: MessageEnvelope): ChannelNotification {
  const meta: ChannelMeta = {
    from: envelope.from,
    msgId: envelope.id,
    kind: envelope.kind,
    ...(envelope.fromName ? { fromName: envelope.fromName } : {}),
    ...(envelope.inReplyTo ? { inReplyTo: envelope.inReplyTo } : {}),
    ...(envelope.threadId ? { threadId: envelope.threadId } : {}),
  };
  const senderLabel = envelope.fromName
    ? `${envelope.fromName} (${envelope.from.slice(0, 8)})`
    : envelope.from;
  const header = `📬 from ${senderLabel} (${envelope.kind}, msg ${envelope.id})`;
  const replyHint = envelope.kind === "ask" ? `\n\n(use peer_reply inReplyTo=${envelope.id})` : "";
  const content = `${header}:\n${envelope.content}${replyHint}`;
  return { method: CHANNEL_METHOD, params: { content, meta } };
}

export interface ChannelSender {
  /**
   * Push a single envelope through the channel.
   * Returns {delivered: true} on success, {delivered: false} on transport failure.
   * Caller can decide whether to consume the inbox file or leave it for piggyback.
   */
  push(envelope: MessageEnvelope): Promise<{ delivered: boolean }>;
}

export function createChannelSender(server: Server): ChannelSender {
  return {
    async push(envelope) {
      const notif = buildChannelNotification(envelope);
      try {
        // biome-ignore lint/suspicious/noExplicitAny: SDK notification signature is loose
        await (server as any).notification(notif);
        log.debug("pushed", { msgId: envelope.id, from: envelope.from });
        return { delivered: true };
      } catch (e) {
        log.warn("push_failed", {
          msgId: envelope.id,
          err: e instanceof Error ? e.message : String(e),
        });
        return { delivered: false };
      }
    },
  };
}

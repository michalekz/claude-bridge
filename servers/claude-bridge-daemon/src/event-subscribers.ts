import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, bridgeRoot, controlDir, makeLogger } from "@claude-bridge/shared";

/**
 * Lifecycle event routing into peer inboxes.
 *
 * Beyond `events.jsonl` (audit trail), the operator can register peers
 * as *subscribers* to specific lifecycle events. When the daemon emits
 * `peer_started` / `peer_stopped` / `peer_crashed`, each matching
 * subscriber gets a bridge inbox message dropped into their pending/
 * dir — persistent, survives sleep (charter watchdog requirement).
 *
 * Subscribers config: `~/.claude-bridge/control/subscribers.json`
 *   {
 *     "subscribers": [
 *       { "peerId": "velitel-uuid", "events": ["peer_crashed"] },
 *       { "peerId": "keeper-uuid", "events": ["peer_started","peer_stopped","peer_crashed"] }
 *     ]
 *   }
 *
 * Owner writes this file directly — same POSIX single-user boundary as
 * the GO-registr. Agents can only READ subscribers, never mutate.
 */

const log = makeLogger("daemon.subscribers");

export interface SubscriberEntry {
  peerId: string;
  events: string[];
}

interface SubscribersFile {
  subscribers: SubscriberEntry[];
}

function subscribersFilePath(): string {
  return join(controlDir(), "subscribers.json");
}

function inboxPendingDir(peerId: string): string {
  return join(bridgeRoot(), "inbox", peerId, "pending");
}

export async function readSubscribers(): Promise<SubscriberEntry[]> {
  try {
    const raw = await readFile(subscribersFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SubscribersFile>;
    return parsed.subscribers ?? [];
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    log.warn("subscribers_read_error", { err: String(e) });
    return [];
  }
}

function generateMsgId(): string {
  const ms = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ms}-${rand}`;
}

export interface LifecycleEventPayload {
  event: string;
  sessionId: string;
  sessionKey: string;
  details: Record<string, unknown>;
}

/**
 * Emit a bridge inbox message to every subscriber for this event kind.
 * Best-effort per subscriber — one failing write doesn't block the others.
 */
export async function publishLifecycleEvent(payload: LifecycleEventPayload): Promise<void> {
  const subscribers = await readSubscribers();
  const interested = subscribers.filter((s) => s.events.includes(payload.event));
  if (interested.length === 0) return;

  for (const sub of interested) {
    const msgId = generateMsgId();
    const envelope = {
      id: msgId,
      ts: new Date().toISOString(),
      from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
      to: { sessionId: sub.peerId, name: sub.peerId },
      kind: "lifecycle-event",
      content: {
        event: payload.event,
        sessionId: payload.sessionId,
        sessionKey: payload.sessionKey,
        details: payload.details,
      },
    };
    try {
      const path = join(inboxPendingDir(sub.peerId), `${msgId}.json`);
      await atomicWriteJson(path, envelope);
    } catch (e) {
      log.warn("subscriber_dispatch_failed", {
        subscriber: sub.peerId,
        event: payload.event,
        err: String(e),
      });
    }
  }
}

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { controlDir, makeLogger, syntheticSenderId, writeEnvelope } from "@claude-bridge/shared";

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
  /** WHICH peer this is about — the registry key (R3, v0.11.21). */
  handle: string;
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
    try {
      // THE FOURTH HAND-BUILT ENVELOPE (found by R3, v0.11.21).
      //
      // This one disagreed with `MessageEnvelopeSchema` in all four of the ways
      // `peer_compact`'s did: `from`/`to` as `{sessionId, name}` objects rather
      // than strings, `ts` instead of `sentAt`, `content` as an object rather
      // than text, and `kind: "lifecycle-event"` — which is not in an enum
      // holding exactly `ask`, `reply`, `broadcast`. The recipient `safeParse`s
      // and returns null, so every one of these would have landed in `pending/`
      // and been invisible to the peer it was written for.
      //
      // NEVER FIRED. Measured 2026-08-08: `control/subscribers.json` does not
      // exist, so `interested` has always been empty and the loop never ran.
      // A latent defect in a feature nobody switched on — reported at that
      // strength, and fixed because a write path known to be broken is worse
      // sitting there than in a changelog.
      //
      // `writeEnvelope` PARSES rather than safe-parses, so a future mistake
      // here throws at the writer, which knows what it meant.
      await writeEnvelope({
        id: msgId,
        from: syntheticSenderId("control-plane-daemon"),
        fromName: "control-plane-daemon",
        to: sub.peerId,
        kind: "broadcast",
        sentAt: new Date().toISOString(),
        content: [
          `[control-plane] ${payload.event} — ${payload.handle} (${payload.sessionKey})`,
          "",
          JSON.stringify(payload.details, null, 2),
        ].join("\n"),
      });
    } catch (e) {
      log.warn("subscriber_dispatch_failed", {
        subscriber: sub.peerId,
        event: payload.event,
        err: String(e),
      });
    }
  }
}

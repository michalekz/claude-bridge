import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../util/atomic-write.ts";

/**
 * File-based inbox store.
 *
 * Layout (per peer, keyed on stable peer ID = Claude Code sessionId):
 *   <baseDir>/inbox/<peerId>/
 *     ├── pending/<msg-id>.json   ← new, unconsumed messages
 *     └── done/<msg-id>.json      ← consumed, archived
 *
 * Identity model (v0.2.0):
 * - `from` / `to` carry the recipient's **id** (sessionId UUID, never collides)
 * - `fromName` / `toName` carry the display label at send time (snapshot,
 *   may go stale if peer rotates name later — that's fine for piggyback render)
 *
 * Atomicity:
 * - Writes go through atomicWriteJson (temp + rename)
 * - Consume = fs.rename pending → done (POSIX atomic)
 *
 * Sort order:
 * - Message IDs are time-prefixed (`<ms-base36>-<random4>`), so lexical sort
 *   on filename matches chronological order.
 */

export const MessageKindSchema = z.enum(["ask", "reply", "broadcast"]);

export const MessageEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    /** Sender peer id (sessionId UUID). */
    from: z.string().min(1),
    /** Sender display name at send time (snapshot for piggyback rendering). */
    fromName: z.string().optional(),
    /** Recipient peer id (sessionId UUID). */
    to: z.string().min(1),
    /** Recipient display name at send time (snapshot, optional). */
    toName: z.string().optional(),
    kind: MessageKindSchema,
    sentAt: z.string(),
    content: z.string(),
    threadId: z.string().optional(),
    inReplyTo: z.string().optional(),
  })
  .passthrough();

export type MessageKind = z.infer<typeof MessageKindSchema>;
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

export function generateMessageId(now: number = Date.now()): string {
  const ts = now.toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export function defaultBridgeRoot(): string {
  return join(homedir(), ".claude-bridge");
}

export interface InboxStoreOptions {
  /** Override the bridge root (default: ~/.claude-bridge). Use absolute paths in tests. */
  baseDir?: string;
}

export interface FoundMessage {
  envelope: MessageEnvelope;
  /** Where the message was found — needed when caller wants to archive before reply. */
  location: "pending" | "done";
}

export interface InboxStore {
  /** Send a message — atomically writes to recipient's pending/ (dir = envelope.to). */
  send(envelope: MessageEnvelope): Promise<void>;
  /** List pending messages for the given peerId (chronological order). */
  listPending(peerId: string): Promise<MessageEnvelope[]>;
  /** Move a message from pending → done; returns the envelope or null if missing. */
  consume(peerId: string, msgId: string): Promise<MessageEnvelope | null>;
  /** Count pending messages without reading them. */
  countPending(peerId: string): Promise<number>;
  /**
   * Kinds waiting in pending/, counted from the RAW files.
   *
   * 🔴 Deliberately does NOT go through `listPending`. That one validates
   * against the envelope schema and silently drops whatever fails — including
   * daemon control kinds like `compact-anchor-request`, which are not in the
   * kind enum. Counting through it would make those messages invisible by
   * ACCIDENT rather than by decision, and an exception nobody can see is an
   * exception nobody rechecks.
   *
   * Anything unreadable is counted under the key `"?"` — a file we cannot
   * parse is still a file sitting in somebody's queue.
   */
  countPendingByKind(peerId: string): Promise<Record<string, number>>;
  /** Look up an archived message (for reply correlation). */
  findInDone(peerId: string, msgId: string): Promise<MessageEnvelope | null>;
  /**
   * Look up a message in either done/ (preferred) or pending/. Used by peer_reply
   * so push-delivered messages (still in pending/) can be replied to without a
   * manual peer_inbox_read first.
   */
  findMessage(peerId: string, msgId: string): Promise<FoundMessage | null>;
  /** List all archived messages for a peer (chronological). */
  listDone(peerId: string): Promise<MessageEnvelope[]>;
  /**
   * Record that a message was handed to the push channel.
   *
   * `pending/` means "not confirmed seen by the agent", NOT "not delivered" —
   * push is deliberately best-effort and only piggyback consumes (see
   * `pumpInboxToChannel`). That is the right safety property, but it left the
   * two states indistinguishable on disk, and on 2026-08-05 it cost two peers
   * hours each: plt-designer diagnosed a "deaf peer" from a file in `pending/`
   * that had in fact been delivered and answered, and so did I, on a different
   * peer, several hours later. Of nineteen decidable pending files, seventeen
   * turned out to be delivered.
   *
   * Written to a sidecar rather than into the envelope, because rewriting a
   * file in `pending/` races with `consume` renaming it away — the loser of
   * that race recreates a message that was already archived.
   */
  markPushed(peerId: string, msgId: string): Promise<void>;
  /**
   * When the push channel last took this message, or null if it never did.
   *
   * 🔴 THIS IS A RECORD OF WHAT *WE* DID, NOT OF WHAT THE PEER RECEIVED.
   * `pushedAt` means our `notification()` call did not throw — and a JSON-RPC
   * notification has no response by definition, so there is nothing here that
   * could have confirmed receipt. The client may drop it silently (org channel
   * policy does exactly that) and this record still says `pushedAt`.
   *
   * On 2026-08-22 two people read a file in `pushed/` as proof of delivery and
   * spent seven minutes explaining a fault that had a different cause. The
   * warning was written where the record is CREATED; it was missing here,
   * where it is read.
   *
   * A message with a push record that is STILL in `pending/` is the normal,
   * expected shape of "pushed but nobody took it" — not an anomaly.
   */
  pushRecord(peerId: string, msgId: string): Promise<PushRecord | null>;
}

export interface PushRecord {
  pushedAt: string;
  pushCount: number;
}

function peerBase(opts: InboxStoreOptions, peerId: string): string {
  return join(opts.baseDir ?? defaultBridgeRoot(), "inbox", peerId);
}

async function readEnvelope(path: string): Promise<MessageEnvelope | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const result = MessageEnvelopeSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function listEnvelopes(dir: string): Promise<MessageEnvelope[]> {
  const entries = await listDir(dir);
  entries.sort();
  const result: MessageEnvelope[] = [];
  for (const entry of entries) {
    const env = await readEnvelope(join(dir, entry));
    if (env) result.push(env);
  }
  return result;
}

export function createInboxStore(opts: InboxStoreOptions = {}): InboxStore {
  return {
    async send(envelope) {
      MessageEnvelopeSchema.parse(envelope);
      const path = join(peerBase(opts, envelope.to), "pending", `${envelope.id}.json`);
      await atomicWriteJson(path, envelope);
    },

    async listPending(peerId) {
      return listEnvelopes(join(peerBase(opts, peerId), "pending"));
    },

    async listDone(peerId) {
      return listEnvelopes(join(peerBase(opts, peerId), "done"));
    },

    async consume(peerId, msgId) {
      const src = join(peerBase(opts, peerId), "pending", `${msgId}.json`);
      const env = await readEnvelope(src);
      if (!env) return null;

      const dst = join(peerBase(opts, peerId), "done", `${msgId}.json`);
      try {
        await mkdir(dirname(dst), { recursive: true });
        await rename(src, dst);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          await unlink(src).catch(() => undefined);
        }
      }
      // The push record only exists to explain a message still sitting in
      // pending/. Once it is archived the question cannot be asked any more.
      await unlink(join(peerBase(opts, peerId), "pushed", `${msgId}.json`)).catch(() => undefined);
      return env;
    },

    async markPushed(peerId, msgId) {
      const path = join(peerBase(opts, peerId), "pushed", `${msgId}.json`);
      let pushCount = 1;
      try {
        const prev: unknown = JSON.parse(await readFile(path, "utf-8"));
        const n = (prev as PushRecord | null)?.pushCount;
        if (typeof n === "number" && Number.isFinite(n)) pushCount = n + 1;
      } catch {
        // First push, or an unreadable record — either way this is push one of
        // the ones we can account for. Never throw: failing to WRITE the note
        // must not fail the delivery the note is about.
      }
      try {
        await mkdir(dirname(path), { recursive: true });
        await atomicWriteJson(path, { pushedAt: new Date().toISOString(), pushCount });
      } catch {
        // Same reasoning.
      }
    },

    async pushRecord(peerId, msgId) {
      try {
        const raw: unknown = JSON.parse(
          await readFile(join(peerBase(opts, peerId), "pushed", `${msgId}.json`), "utf-8"),
        );
        const rec = raw as PushRecord | null;
        if (!rec || typeof rec.pushedAt !== "string") return null;
        return { pushedAt: rec.pushedAt, pushCount: rec.pushCount ?? 1 };
      } catch {
        return null;
      }
    },

    async countPending(peerId) {
      const entries = await listDir(join(peerBase(opts, peerId), "pending"));
      return entries.length;
    },

    async countPendingByKind(peerId) {
      const dir = join(peerBase(opts, peerId), "pending");
      const out: Record<string, number> = {};
      for (const entry of await listDir(dir)) {
        let kind = "?";
        try {
          const raw: unknown = JSON.parse(await readFile(join(dir, entry), "utf-8"));
          const k = (raw as { kind?: unknown } | null)?.kind;
          if (typeof k === "string" && k.length > 0) kind = k;
        } catch {
          // unreadable — still a file in somebody's queue, so it still counts
        }
        out[kind] = (out[kind] ?? 0) + 1;
      }
      return out;
    },

    async findInDone(peerId, msgId) {
      const path = join(peerBase(opts, peerId), "done", `${msgId}.json`);
      try {
        const s = await stat(path);
        if (!s.isFile()) return null;
      } catch {
        return null;
      }
      return readEnvelope(path);
    },

    async findMessage(peerId, msgId) {
      const donePath = join(peerBase(opts, peerId), "done", `${msgId}.json`);
      const doneEnv = await readEnvelope(donePath);
      if (doneEnv) return { envelope: doneEnv, location: "done" };

      const pendingPath = join(peerBase(opts, peerId), "pending", `${msgId}.json`);
      const pendingEnv = await readEnvelope(pendingPath);
      if (pendingEnv) return { envelope: pendingEnv, location: "pending" };

      return null;
    },
  };
}

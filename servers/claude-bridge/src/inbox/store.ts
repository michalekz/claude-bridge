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
      return env;
    },

    async countPending(peerId) {
      const entries = await listDir(join(peerBase(opts, peerId), "pending"));
      return entries.length;
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

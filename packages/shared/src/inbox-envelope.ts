import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "./atomic-write.ts";
import { bridgeRoot } from "./paths.ts";

/**
 * The inbox message envelope, and the one supported way for a process that is
 * not a peer to put a message into a peer's inbox.
 *
 * Why this lives in shared rather than in whichever package needed it first:
 * the MCP server already owns a copy (`servers/claude-bridge/src/inbox/store.ts`)
 * and a second, hand-rolled writer in the daemon would be a third definition of
 * the same on-disk format. `MessageEnvelopeSchema` is `.passthrough()`, so a
 * writer that drifts does not fail — it writes a subtly wrong file, the watcher
 * picks it up, and the recipient gets something broken with no error anywhere.
 * That is the defect class this repository spent 2026-08-03/04 closing, and it
 * is not worth reopening for the convenience of a private copy.
 *
 * Full unification with the MCP server's store is task #65. Until then the
 * contract is held by a test in the MCP package that feeds this writer's output
 * to that package's own schema.
 */

export const MessageKindSchema = z.enum(["ask", "reply", "broadcast"]);

export const MessageEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    /** Sender peer id. For an external injector, a synthetic label (see `isSyntheticSender`). */
    from: z.string().min(1),
    fromName: z.string().optional(),
    /** Recipient peer id — a sessionId UUID, never a display name. Names the inbox directory. */
    to: z.string().min(1),
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

/**
 * Message ids are time-prefixed base36 because the inbox has no index: order is
 * the lexical sort of the filenames. An id that does not start with a
 * monotonically increasing stamp sorts into the wrong place and the recipient
 * reads its messages out of order — silently, since nothing validates ordering.
 */
export function generateMessageId(now: number = Date.now()): string {
  return `${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

/**
 * Prefix marking a sender that is not a claude-bridge peer — a Teams relay, a
 * cron job, anything injecting from outside the fleet.
 *
 * It exists so a reply can fail loudly. Replying to a synthetic sender would
 * otherwise create `inbox/<label>/pending/` — a directory no process drains —
 * and the reply would look delivered on disk while reaching nobody.
 */
export const SYNTHETIC_SENDER_PREFIX = "external:";

export function syntheticSenderId(label: string): string {
  return label.startsWith(SYNTHETIC_SENDER_PREFIX) ? label : `${SYNTHETIC_SENDER_PREFIX}${label}`;
}

export function isSyntheticSender(from: string): boolean {
  return from.startsWith(SYNTHETIC_SENDER_PREFIX);
}

export function inboxPendingDir(peerId: string, root: string = bridgeRoot()): string {
  return join(root, "inbox", peerId, "pending");
}

/** Write an envelope into the recipient's pending dir. Validates before writing. */
export async function writeEnvelope(
  envelope: MessageEnvelope,
  root: string = bridgeRoot(),
): Promise<string> {
  const parsed = MessageEnvelopeSchema.parse(envelope);
  const path = join(inboxPendingDir(parsed.to, root), `${parsed.id}.json`);
  await atomicWriteJson(path, parsed);
  return path;
}

export interface ResolvedPeer {
  id: string;
  name: string;
  displayName?: string;
  lastSeenAgeMs: number;
  /**
   * `interactive` | `bg` — co ta session JE, když to její heartbeat řekl.
   *
   * CHYBÍ u peerů se starším pluginem (pole vzniklo v v0.11.39), a chybějící
   * hodnota NENÍ „interactive". Kdo z toho odvozuje radu, musí umět mlčet.
   */
  kind?: string;
  /** Pid peera z heartbeatu — pro dohledání `kind` ze `sessions/<pid>.json`. */
  pid?: number;
}

export type PeerLookup =
  | { outcome: "found"; peer: ResolvedPeer }
  | { outcome: "not_found" }
  | { outcome: "ambiguous"; candidates: ResolvedPeer[] };

/**
 * Resolve a peer id or display name against the heartbeat files in
 * `<root>/status/`. An id match wins outright; a name match must be unique,
 * because names can collide and picking one arbitrarily would deliver mail to
 * the wrong peer.
 */
export async function resolvePeer(
  idOrName: string,
  root: string = bridgeRoot(),
  now: number = Date.now(),
): Promise<PeerLookup> {
  const dir = join(root, "status");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { outcome: "not_found" };
  }

  const peers: ResolvedPeer[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), "utf-8")) as Record<string, unknown>;
      const id = typeof raw["id"] === "string" ? raw["id"] : null;
      const name = typeof raw["name"] === "string" ? raw["name"] : null;
      if (!id || !name) continue;
      const lastSeen =
        typeof raw["lastSeen"] === "string" ? Date.parse(raw["lastSeen"]) : Number.NaN;
      peers.push({
        id,
        name,
        ...(typeof raw["displayName"] === "string" ? { displayName: raw["displayName"] } : {}),
        ...(typeof raw["kind"] === "string" ? { kind: raw["kind"] } : {}),
        ...(typeof raw["pid"] === "number" ? { pid: raw["pid"] } : {}),
        lastSeenAgeMs: Number.isNaN(lastSeen) ? Number.POSITIVE_INFINITY : now - lastSeen,
      });
    } catch {
      // A malformed or half-written heartbeat is not a reason to fail the
      // lookup — skip it and keep going.
    }
  }

  const byId = peers.find((p) => p.id === idOrName);
  if (byId) return { outcome: "found", peer: byId };

  const byName = peers.filter((p) => p.name === idOrName || p.displayName === idOrName);
  if (byName.length === 1 && byName[0]) return { outcome: "found", peer: byName[0] };
  if (byName.length > 1) return { outcome: "ambiguous", candidates: byName };
  return { outcome: "not_found" };
}

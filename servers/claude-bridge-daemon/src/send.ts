import { readFile } from "node:fs/promises";
import {
  type MessageEnvelope,
  MessageKindSchema,
  generateMessageId,
  resolvePeer,
  syntheticSenderId,
  writeEnvelope,
} from "@claude-bridge/shared";
import { writeEvent } from "./events.ts";

/**
 * `claude-bridge-daemon send` — put one message into a peer's inbox from a
 * process that is not a peer.
 *
 * Written for the Teams relay (2026-08-04): a no-LLM job polls named Teams
 * threads and delivers each new message to a configured peer. The alternative
 * was for that job to write `inbox/<peer>/pending/<id>.json` itself, which
 * works today and is a trap — `MessageEnvelopeSchema` is `.passthrough()`, so
 * a writer that drifts from the format does not fail. It writes a subtly wrong
 * file, the watcher delivers it, and the recipient gets something broken with
 * no error on either side. Two further details are invisible from the format
 * alone: ids must be time-prefixed base36 because inbox order is the lexical
 * sort of filenames, and `to` must be a peer id, never a display name.
 *
 * Exit codes are distinct so a caller can fail loudly without parsing stderr:
 *
 *   0  delivered
 *   2  recipient not found, or a name that matches more than one peer
 *   3  malformed invocation (missing flag, empty text, unknown kind)
 *   4  the write itself failed (permissions, disk, unwritable inbox)
 *
 * stdout is JSON on success and nothing otherwise; stderr is for humans.
 */

export const EXIT_OK = 0;
export const EXIT_PEER = 2;
export const EXIT_USAGE = 3;
export const EXIT_WRITE = 4;

export const SEND_HELP = `Usage: claude-bridge-daemon send --to <peer> --from-label <label> [options]

  --to <peer>           recipient peer id or display name (name must be unique)
  --from-label <label>  who this is from, e.g. "teams:uzaverka"
  --text <text>         message body
  --text-file <path>    read the body from a file, or "-" for stdin
  --kind <kind>         ask | reply | broadcast   (default: ask)
  --thread <id>         correlation id for a multi-turn exchange
  --in-reply-to <id>    msgId this answers

Exit: 0 delivered · 2 recipient not found/ambiguous · 3 bad invocation · 4 write failed
`;

export interface SendOutcome {
  code: number;
  /** Printed to stdout — JSON, only when the message was delivered. */
  stdout?: string;
  /** Printed to stderr — for a human reading a log. */
  stderr?: string;
}

interface ParsedFlags {
  to?: string;
  fromLabel?: string;
  text?: string;
  textFile?: string;
  kind?: string;
  thread?: string;
  inReplyTo?: string;
}

const FLAG_MAP: Record<string, keyof ParsedFlags> = {
  "--to": "to",
  "--from-label": "fromLabel",
  "--text": "text",
  "--text-file": "textFile",
  "--kind": "kind",
  "--thread": "thread",
  "--in-reply-to": "inReplyTo",
};

export function parseSendFlags(argv: string[]): ParsedFlags | { error: string } {
  const out: ParsedFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined) continue;
    const key = FLAG_MAP[flag];
    if (!key) return { error: `unknown flag '${flag}'` };
    const value = argv[i + 1];
    // A flag whose value is another flag is a missing value, not a value —
    // `--to --kind ask` must not silently address a peer called "--kind".
    if (value === undefined || value.startsWith("--")) {
      return { error: `flag '${flag}' needs a value` };
    }
    out[key] = value;
    i++;
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

export async function runSend(argv: string[], now: number = Date.now()): Promise<SendOutcome> {
  const parsed = parseSendFlags(argv);
  if ("error" in parsed) {
    return { code: EXIT_USAGE, stderr: `send: ${parsed.error}\n\n${SEND_HELP}` };
  }
  if (!parsed.to) return { code: EXIT_USAGE, stderr: `send: --to is required\n\n${SEND_HELP}` };
  if (!parsed.fromLabel) {
    return { code: EXIT_USAGE, stderr: `send: --from-label is required\n\n${SEND_HELP}` };
  }
  if (parsed.text !== undefined && parsed.textFile !== undefined) {
    return { code: EXIT_USAGE, stderr: "send: pass --text or --text-file, not both\n" };
  }

  const kindResult = MessageKindSchema.safeParse(parsed.kind ?? "ask");
  if (!kindResult.success) {
    return {
      code: EXIT_USAGE,
      stderr: `send: --kind must be ask, reply or broadcast (got '${parsed.kind}')\n`,
    };
  }

  let content: string;
  if (parsed.textFile !== undefined) {
    try {
      content =
        parsed.textFile === "-" ? await readStdin() : await readFile(parsed.textFile, "utf-8");
    } catch (e) {
      return { code: EXIT_USAGE, stderr: `send: cannot read --text-file: ${String(e)}\n` };
    }
  } else {
    content = parsed.text ?? "";
  }
  // An empty body is a caller bug, not a message. Delivering it would put a
  // blank block in front of the recipient with nothing to act on.
  if (content.trim().length === 0) {
    return { code: EXIT_USAGE, stderr: "send: message body is empty\n" };
  }

  const lookup = await resolvePeer(parsed.to);
  if (lookup.outcome === "not_found") {
    return {
      code: EXIT_PEER,
      stderr: `send: no peer with id or name '${parsed.to}' — check ~/.claude-bridge/status/\n`,
    };
  }
  if (lookup.outcome === "ambiguous") {
    const ids = lookup.candidates.map((c) => c.id).join(", ");
    return {
      code: EXIT_PEER,
      stderr: `send: '${parsed.to}' matches ${lookup.candidates.length} peers (${ids}) — address one by id\n`,
    };
  }

  const peer = lookup.peer;
  const envelope: MessageEnvelope = {
    id: generateMessageId(now),
    from: syntheticSenderId(parsed.fromLabel),
    fromName: parsed.fromLabel,
    to: peer.id,
    toName: peer.displayName ?? peer.name,
    kind: kindResult.data,
    sentAt: new Date(now).toISOString(),
    content,
    ...(parsed.thread ? { threadId: parsed.thread } : {}),
    ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
  };

  let path: string;
  try {
    path = await writeEnvelope(envelope);
  } catch (e) {
    return { code: EXIT_WRITE, stderr: `send: could not write the message: ${String(e)}\n` };
  }

  // Audited like any other delivery. An external injector that leaves no trace
  // is the thing nobody can reconstruct after an incident.
  await writeEvent({
    event: "external_message_sent",
    by: { sessionId: null, name: envelope.from },
    details: {
      msgId: envelope.id,
      to: peer.id,
      toName: envelope.toName,
      kind: envelope.kind,
      contentLength: content.length,
      // The body is NOT logged — it can carry anything the relay picked up.
      peerHeartbeatAgeMs: peer.lastSeenAgeMs,
    },
  });

  return {
    code: EXIT_OK,
    stdout: `${JSON.stringify({
      ok: true,
      msgId: envelope.id,
      to: { id: peer.id, name: envelope.toName },
      from: envelope.from,
      kind: envelope.kind,
      path,
      peerHeartbeatAgeMs: peer.lastSeenAgeMs,
    })}\n`,
  };
}

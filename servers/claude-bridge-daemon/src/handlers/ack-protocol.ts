import { access, lstat, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  controlDir,
  generateMessageId,
  syntheticSenderId,
  writeEnvelope,
} from "@claude-bridge/shared";

/**
 * Ask a peer to do something, then wait for it to say it did.
 *
 * The daemon has this conversation twice — once before a `/compact`, once
 * before a graceful stop — and both halves are the same protocol:
 *
 *   1. write a request into the peer's inbox, tagged with a `threadId`
 *   2. the peer does its work and writes `<control>/<channel>/<sessionId>.json`
 *   3. the daemon polls for that file and decides whether it answers THIS request
 *   4. the ack is consumed so it cannot answer the next one
 *
 * Only two things differ: the directory name and the wording of the request.
 * Everything else — freshness, thread matching, the stale sweep, the startup
 * sweep, consumption — is identical, and every one of those was learned the
 * expensive way on the compact side:
 *
 *   - `writeEnvelope` instead of a hand-built object (v0.11.x): `peer_compact`
 *     never completed once between v0.10.0-rc and 2026-08-06 because its
 *     envelope disagreed with the schema in five places and the reader
 *     `safeParse`d it away in silence.
 *   - sweep-then-wait instead of compare-timestamps (#81): a run that timed out
 *     at 06:41 left an ack the NEXT run accepted at 06:43.
 *   - `threadId` matching: two requests racing on one peer are otherwise
 *     indistinguishable.
 *
 * `team_stop` had none of them. It built its own envelope, and that envelope is
 * unreadable — measured against both the shared schema and the MCP server's own
 * copy on 2026-08-08, five mismatches, same five as compact's. Its graceful
 * branch has never run to completion anywhere, which is why nobody noticed.
 *
 * So this module exists as the ONE place the protocol lives. A second copy is
 * how the first one drifted.
 */

const ACK_FILENAME_EXTENSION = ".json";

export interface AckVerdict {
  accepted: boolean;
  reason: "fresh" | "none" | "too_old" | "wrong_thread";
  ackThreadId?: string | null;
  writtenAt?: string | null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this ack the answer to THIS request?
 *
 * Two independent checks, because they fail differently. The timestamp catches
 * an ack that predates the request — a leftover. The `threadId` catches an ack
 * that is recent but answers a DIFFERENT request, which is what two concurrent
 * runs on one peer would produce.
 *
 * An ack without a `threadId` is accepted on freshness alone and reported as
 * such: the operator playbook has always said "touch the file", a human
 * following it writes nothing inside, and refusing that would break the
 * documented path to close a hole the sweep has already closed.
 */
export async function verifyAckFile(
  path: string,
  requestedAtMs: number,
  threadId: string,
): Promise<AckVerdict> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch {
    return { accepted: false, reason: "none" };
  }
  // One second of slack: the peer may touch the file in the same second the
  // request was written, and a filesystem timestamp is not a precision clock.
  if (stat.mtimeMs < requestedAtMs - 1_000) {
    return { accepted: false, reason: "too_old", writtenAt: new Date(stat.mtimeMs).toISOString() };
  }
  let ackThreadId: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { threadId?: unknown };
    if (typeof parsed.threadId === "string") ackThreadId = parsed.threadId;
  } catch {
    // Not JSON, or empty — a `touch`ed file. Freshness is the only check left.
  }
  if (ackThreadId !== null && ackThreadId !== threadId) {
    return {
      accepted: false,
      reason: "wrong_thread",
      ackThreadId,
      writtenAt: new Date(stat.mtimeMs).toISOString(),
    };
  }
  return {
    accepted: true,
    reason: "fresh",
    ackThreadId,
    writtenAt: new Date(stat.mtimeMs).toISOString(),
  };
}

export interface AckChannel {
  /** Directory under `<control>/` this channel's acks live in. */
  readonly channel: string;
  dir(): string;
  path(sessionId: string): string;
  /**
   * Move any ack already lying around for this peer out of the way. Once,
   * before we start waiting.
   *
   * This is the load-bearing half of the stale-ack fix, and it is stronger than
   * any comparison: with the directory swept, every ack that appears afterwards
   * is fresh BY CONSTRUCTION. Comparing timestamps still leaves you reasoning
   * about clocks; an empty directory does not.
   */
  sweepStale(sessionId: string, reason: string): Promise<string | null>;
  /**
   * Clear every ack left over from a previous daemon. Called once at startup.
   *
   * A daemon that died mid-request leaves an ack nobody will ever consume, and
   * the next request for that peer would have found it waiting.
   */
  sweepAllAtStartup(): Promise<number>;
  poll(
    sessionId: string,
    deadline: number,
    pollMs: number,
    requestedAtMs: number,
    threadId: string,
  ): Promise<AckVerdict>;
  consume(sessionId: string): Promise<void>;
}

export function createAckChannel(channel: string): AckChannel {
  // `controlDir()` is read on every call, never captured: the tests point
  // `homedir()` at a temp directory and re-import, and a path resolved at
  // module load would outlive that redirection.
  const dir = (): string => join(controlDir(), channel);
  const path = (sessionId: string): string => join(dir(), `${sessionId}${ACK_FILENAME_EXTENSION}`);

  return {
    channel,
    dir,
    path,

    async sweepStale(sessionId, reason) {
      const src = path(sessionId);
      if (!(await fileExists(src))) return null;
      const done = join(dir(), "done");
      await mkdir(done, { recursive: true });
      const dest = join(done, `${sessionId}-${reason}-${Date.now()}.json`);
      try {
        await rename(src, dest);
      } catch {
        await unlink(src).catch(() => undefined);
      }
      return dest;
    },

    async sweepAllAtStartup() {
      let names: string[];
      try {
        names = await readdir(dir());
      } catch {
        return 0;
      }
      const done = join(dir(), "done");
      await mkdir(done, { recursive: true });
      let swept = 0;
      for (const name of names) {
        if (!name.endsWith(ACK_FILENAME_EXTENSION)) continue;
        try {
          await rename(
            join(dir(), name),
            join(
              done,
              `${name.slice(0, -ACK_FILENAME_EXTENSION.length)}-startup-${Date.now()}.json`,
            ),
          );
          swept++;
        } catch {
          // A directory, or something we do not own. Leave it.
        }
      }
      return swept;
    },

    async poll(sessionId, deadline, pollMs, requestedAtMs, threadId) {
      const p = path(sessionId);
      let last: AckVerdict = { accepted: false, reason: "none" };
      while (Date.now() < deadline) {
        last = await verifyAckFile(p, requestedAtMs, threadId);
        if (last.accepted) return last;
        // A rejected ack is not a reason to stop waiting — the right one may
        // still arrive. It IS a reason to remember why the last one failed, so
        // the timeout can say "an ack was there and it was not yours".
        await new Promise((r) => setTimeout(r, pollMs));
      }
      const final = await verifyAckFile(p, requestedAtMs, threadId);
      return final.accepted ? final : final.reason === "none" ? last : final;
    },

    async consume(sessionId) {
      const src = path(sessionId);
      const done = join(dir(), "done");
      try {
        await mkdir(done, { recursive: true });
        await rename(src, join(done, `${sessionId}-${Date.now()}.json`));
      } catch {
        // Fallback: unlink if rename didn't take (e.g. cross-fs on temp dirs).
        await unlink(src).catch(() => undefined);
      }
    },
  };
}

/**
 * Put a request into a peer's inbox, in the one envelope shape the recipient
 * can read.
 *
 * `writeEnvelope` `parse`s rather than `safeParse`s, so a malformed envelope
 * throws at the WRITER instead of vanishing at the reader. That asymmetry is
 * the whole point: the write site knows what it meant, the read site only knows
 * something did not fit. Every hand-built envelope in this repository has
 * eventually disagreed with the schema, and each one failed silently.
 *
 * `kind` is `"ask"` because the enum has three values and none of them is a
 * lifecycle verb. A request that invented its own kind is exactly how
 * `team_stop` became undeliverable.
 */
export async function requestFromPeer(
  peerId: string,
  threadId: string,
  content: string,
): Promise<string> {
  const msgId = generateMessageId();
  await writeEnvelope({
    id: msgId,
    from: syntheticSenderId("control-plane-daemon"),
    fromName: "control-plane-daemon",
    to: peerId,
    kind: "ask",
    sentAt: new Date().toISOString(),
    threadId,
    content,
  });
  return msgId;
}

/** The daemon's ack conversations. Add the next one here, not a copy elsewhere. */
export const compactAcks = createAckChannel("compact-ack");
export const stopAcks = createAckChannel("stop-ack");
export const restartAcks = createAckChannel("restart-ack");

/**
 * Every channel, for the operations that must not miss one.
 *
 * The startup sweep swept only `compact-ack` from v0.10.0 to v0.11.17: two
 * channels were added and neither reached that call site. A hand-written list
 * at the call site would have the same fault, so the list lives with the
 * channels — a fourth is swept because it is declared here, not because
 * somebody remembered to go and add it.
 *
 * (The fifth instance in three days of "a list written somewhere else goes
 * stale in silence". The fix is always the same: derive it.)
 */
export const ALL_ACK_CHANNELS: readonly AckChannel[] = [compactAcks, stopAcks, restartAcks];

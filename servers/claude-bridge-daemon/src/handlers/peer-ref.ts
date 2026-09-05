import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePeer } from "@claude-bridge/shared";
import type { PeerRecord } from "../state.ts";

/** What a lifecycle handler should answer when it cannot find a peer. */
export interface UnresolvedPeerError {
  code: "peer_not_found" | "peer_unmanaged";
  message: string;
  details: Record<string, unknown>;
}

/**
 * `peer_not_found` was true of the registry and false of the world.
 *
 * THE 2026-08-11 INCIDENT, second half. After a background session force-stopped
 * a live peer, the peer was revived in tmux beside the control plane — so it
 * heartbeated, `peer_list` showed it, `peer_context_status` reported on it, and
 * every lifecycle tool answered `peer_not_found: No peer with id/name in daemon
 * state`. Read plainly, that says the peer does not exist. It existed, was
 * talking, and could not be reached — a materially different situation with a
 * different remedy, and the message named neither.
 *
 * The daemon's registry and the heartbeat directory are two populations:
 * `state.peers` holds what the control plane started or adopted, while
 * `<root>/status/` holds every Claude Code process that loaded the plugin,
 * however it was started. A peer in the second and not the first is not missing
 * — it is unmanaged, and `team_adopt` is the fix.
 *
 * Absence of a heartbeat is NOT read as proof of anything: no heartbeat gives
 * the old answer, unchanged.
 */
/**
 * Co ta session JE, přečtené z `~/.claude/sessions/<pid>.json`.
 *
 * Záloha pro peery, jejichž heartbeat `kind` ještě nenese (plugin starší než
 * v0.11.39). Soubor píše Claude Code sám a nese `kind` i `jobId`.
 *
 * `undefined` = nevíme. NENÍ to „interactive".
 */
function sessionKind(pid: number | undefined): string | undefined {
  if (pid === undefined) return undefined;
  try {
    const raw = readFileSync(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf-8");
    const parsed = JSON.parse(raw) as { kind?: unknown };
    return typeof parsed.kind === "string" ? parsed.kind : undefined;
  } catch {
    return undefined;
  }
}

export async function unresolvedPeerError(ref: string): Promise<UnresolvedPeerError> {
  const heartbeat = await resolvePeer(ref);
  if (heartbeat.outcome === "found") {
    const age = Math.round(heartbeat.peer.lastSeenAgeMs);
    const kind = heartbeat.peer.kind ?? sessionKind(heartbeat.peer.pid);
    // 🔴 DVĚ TŘÍDY NEDOSAŽITELNOSTI, DVĚ RŮZNÉ RADY (29. 8.).
    //
    // `team_adopt` je lék jen pro peera, který MÁ hostitele v tmuxu a nikdo ho
    // nepřipsal. Session hostovaná cc-démonem (`kind: "bg"` — SDK/CLI úlohy)
    // žádný tmux target NEMÁ a mít nebude: celý lifecycle démona na něm stojí.
    // Adopce by z ní udělala záznam, o kterém by každé zastavení, restart
    // i compact lhaly.
    //
    // Naostro to narazilo téhož dne: skutečná pracovní session (88 % kontextu,
    // klientská práce) dostala správný verdikt `peer_unmanaged` a k němu radu
    // „adopt it, then retry", kterou příjemce NEMŮŽE provést. Rada, která
    // nejde provést, posílá člověka hledat chybu tam, kde žádná není.
    if (kind === "bg") {
      return {
        code: "peer_unmanaged",
        message: `Peer '${ref}' IS RUNNING but it is a session hosted by the Claude Code daemon (kind=bg), not by tmux — so the control plane cannot reach it BY DESIGN, and this is not a fault to repair. Its heartbeat is ${age} ms old. Do NOT adopt it: the daemon's lifecycle is built on a tmux target, and a record without one is a record every stop, restart and compact would lie about. Its lifecycle belongs to whoever started it; for compaction the only path is the session itself.`,
        details: {
          peer: ref,
          sessionId: heartbeat.peer.id,
          name: heartbeat.peer.name,
          lastSeenAgeMs: age,
          kind,
          remedy: "owner-of-the-session",
        },
      };
    }
    // `kind` může CHYBĚT (starší plugin než v0.11.39, nečitelný sessions
    // soubor). Pak se rada nabízí, ale netvrdí se jistota — nevědomost se
    // nesmí tvářit jako změřená interaktivní session.
    const sure = kind === "interactive";
    return {
      code: "peer_unmanaged",
      message: `Peer '${ref}' IS RUNNING but the control plane does not manage it, so lifecycle tools cannot reach it. Its heartbeat is ${age} ms old. This happens when a session is started or revived outside the daemon — adopt it with team_adopt, then retry.${
        sure
          ? ""
          : " (Its kind could not be read, so first check it HAS a tmux window: a session hosted by the Claude Code daemon must NOT be adopted.)"
      }`,
      details: {
        peer: ref,
        sessionId: heartbeat.peer.id,
        name: heartbeat.peer.name,
        lastSeenAgeMs: age,
        kind: kind ?? null,
        remedy: "team_adopt",
      },
    };
  }
  return {
    code: "peer_not_found",
    message: `No peer with id/name '${ref}' in daemon state, and nothing by that name is heartbeating either.`,
    details: { peer: ref },
  };
}

/**
 * Resolve a peer reference (session id or display name) against daemon state.
 *
 * Every lifecycle handler used to do this inline as
 * `Object.values(peers).find((r) => r.name === key)`, and `find` returns the
 * FIRST match. Names are not unique: on 2026-08-05 the live fleet held two
 * peers called `admin` (jira @1071, micronic @1083) and two called `velitel`
 * (jira @1076, micronic @1085), because adoption before v0.10.15 took the name
 * from the tmux window rather than from the peer's own registration.
 *
 * So `peer_restart peer:"velitel"` stopped and respawned whichever record
 * happened to be enumerated first — a destructive action on a silently wrong
 * target, with no way for the caller to notice. `team_restart` also orders
 * "velitel last" by matching on the name, so a duplicate skews the ordering
 * the whole rollout depends on.
 *
 * `team_adopt` already refuses to guess in exactly this situation, and says
 * why: two candidates under one pane "is the duplicate-identity failure mode
 * and guessing would launder it". This brings the rest of the daemon in line —
 * one policy, one place.
 *
 * Session ids stay unambiguous by construction, so an exact id hit short-
 * circuits before names are considered at all.
 */
export type PeerRefResolution =
  | { kind: "found"; handle: string; record: PeerRecord }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: PeerRefCandidate[] };

export interface PeerRefCandidate {
  handle: string;
  name: string;
  tmuxTarget: string | null;
  status: string;
}

/**
 * The short form of a name, relative to its team — `plt-architekt` in team
 * `plt` is `architekt`.
 *
 * Returns null when the name does not carry the team prefix. That is not an
 * error: a fleet we do not run is under no obligation to follow the
 * convention, and there a peer simply has no short form and must be addressed
 * in full. Same as a host with no domain suffix to strip.
 */
export function shortFormOf(record: PeerRecord): string | null {
  const team = record.desired.team;
  if (!team) return null;
  const prefix = `${team}-`;
  if (!record.observed.name.startsWith(prefix)) return null;
  const short = record.observed.name.slice(prefix.length);
  return short.length > 0 ? short : null;
}

/**
 * Resolve a peer reference, in the order a resolver walks a hostname.
 *
 *   1. session id           — unique by construction, always wins
 *   2. full name            — `mic-velitel`, unambiguous anywhere
 *   3. short form, own team — `velitel` asked by a peer in `mic` means
 *                             `mic-velitel`; this is the search domain
 *   4. short form, globally unique — convenience: `tester` from anywhere
 *   5. short form, several matches — refuse, and name the full forms
 *
 * `callerTeam` is what makes step 3 work. Handlers have it: the request
 * envelope carries `requestedBy.sessionId`, and that peer's record has the
 * team. Omitting it only costs the search domain — everything else still
 * resolves.
 */
export function resolvePeerRef(
  peers: Record<string, PeerRecord>,
  ref: string,
  callerTeam?: string | null,
): PeerRefResolution {
  const byId = peers[ref];
  if (byId) return { kind: "found", handle: ref, record: byId };

  // 🔴 KROK, KTERÝ TU CHYBĚL DO 2026-09-05 — a chyběl jen půlce flotily.
  //
  // Do R3 (v0.11.21) byl klíč vždycky session id, takže krok výš stačil. Pak
  // se přejmenoval na `handle` právě proto, že peer, který nenabootoval, žádné
  // session id nemá — a od té chvíle jsou v registru dva druhy klíčů:
  //
  //     adoptovaní   klíč = session id      (team-adopt.ts:532)
  //     spawnutí     klíč = jméno od volajícího
  //
  // Odkaz session idčkem tedy trefil adoptovaného a MINUL spawnutého, ačkoli
  // ten svoje session id zná — má ho ZMĚŘENÉ v `observed.sessionId`. Registr
  // odpověď držel a nikdo se ho na ni nezeptal.
  //
  // Před jmény schválně: session id je unikátní konstrukcí, jméno ne.
  const byMeasured = Object.entries(peers).filter(
    ([, rec]) => rec.observed.sessionId === ref && rec.observed.identity === "measured",
  );
  if (byMeasured.length === 1) {
    const [handle, record] = byMeasured[0] as [string, PeerRecord];
    return { kind: "found", handle, record };
  }
  // Dva záznamy s jedním session id znamenají rozdvojenou identitu. Hádat
  // mezi nimi je přesně to, čemu má tenhle resolver bránit.
  if (byMeasured.length > 1) return ambiguous(byMeasured);

  const exact = Object.entries(peers).filter(([, rec]) => rec.observed.name === ref);
  if (exact.length === 1) {
    const [handle, record] = exact[0] as [string, PeerRecord];
    return { kind: "found", handle, record };
  }
  // A duplicated FULL name means the fleet has two peers claiming one
  // identity. Nothing can disambiguate that but the session id.
  if (exact.length > 1) return ambiguous(exact);

  const short = Object.entries(peers).filter(([, rec]) => shortFormOf(rec) === ref);
  if (short.length === 0) return { kind: "not_found" };
  if (short.length === 1) {
    const [handle, record] = short[0] as [string, PeerRecord];
    return { kind: "found", handle, record };
  }

  if (callerTeam) {
    const own = short.filter(([, rec]) => rec.desired.team === callerTeam);
    if (own.length === 1) {
      const [handle, record] = own[0] as [string, PeerRecord];
      return { kind: "found", handle, record };
    }
  }
  return ambiguous(short);
}

function ambiguous(matches: Array<[string, PeerRecord]>): PeerRefResolution {
  return {
    kind: "ambiguous",
    candidates: matches.map(([handle, rec]) => ({
      handle,
      name: rec.observed.name,
      tmuxTarget: rec.observed.tmuxTarget,
      status: rec.observed.status,
    })),
  };
}

/**
 * Message for the `ambiguous_peer` error.
 *
 * Offers the full NAMES, not the session ids — `mic-velitel` is something an
 * operator can read, retype and recognise, and it is the answer the naming
 * convention exists to give. Ids appear only when two peers share a full name,
 * where nothing else can separate them.
 */
export function ambiguousPeerMessage(ref: string, candidates: PeerRefCandidate[]): string {
  const distinctNames = new Set(candidates.map((c) => c.name));
  const list =
    distinctNames.size === candidates.length
      ? candidates.map((c) => c.name).join(", ")
      : candidates.map((c) => `${c.name} [${c.handle}]`).join(", ");
  return `'${ref}' matches ${candidates.length} peers — refusing to guess which one. Use the full name: ${list}`;
}

/**
 * Session ids, kterými se registr PROKAZATELNĚ zabývá.
 *
 * Pro čtenáře, kteří nemají odkaz k rozlišení, ale ŽIVÝ PROCES a jeho session
 * id, a ptají se „známe ho?". `team_reconcile` byl přesně takový a stavěl si tu
 * množinu z `Object.keys(peers)` — tedy z KLÍČŮ, pod proměnnou jménem
 * `knownSessionIds`. Pro adoptované to vycházelo (klíč JE session id), pro
 * spawnuté ne, takže každý spawnutý peer hlásil `unmanaged` napořád a skutečné
 * unmanaged se v tom šumu ztrácely.
 *
 * Klíče se berou taky, a schválně: u adoptovaného záznamu je klíč jeho session
 * id, a záznam, jehož identita se nedala změřit, nemá nic jiného, čím by se
 * prokázal. Vypustit je by vyměnilo jednu slepotu za druhou.
 */
export function knownSessionIds(peers: Record<string, PeerRecord>): Set<string> {
  const out = new Set<string>(Object.keys(peers));
  for (const rec of Object.values(peers)) {
    if (rec.observed.sessionId) out.add(rec.observed.sessionId);
  }
  return out;
}

/**
 * Záznam, na který ukazuje položka SPECIFIKACE týmu.
 *
 * Specifikace jsou psané JMÉNY (`teams/mic.json` nese „mic-velitel"), registr
 * je u adoptovaných klíčovaný session idčkem — takže `peers[spec.handle]`
 * neodpovídal ničemu a `team_layout` plánoval spawnout devět běžících peerů.
 *
 * Pořadí je totéž jako v `resolvePeerRef`: klíč, pak změřená identita, pak
 * jméno. Bez krátkých tvarů — specifikace mluví plnými jmény a domýšlet jí
 * vyhledávací doménu by znamenalo, že spec začne trefovat peery, které
 * nepojmenovala.
 */
export function recordForSpecHandle(
  peers: Record<string, PeerRecord>,
  specHandle: string,
): { handle: string; record: PeerRecord } | null {
  const direct = peers[specHandle];
  if (direct) return { handle: specHandle, record: direct };
  for (const [handle, rec] of Object.entries(peers)) {
    if (rec.observed.sessionId === specHandle && rec.observed.identity === "measured") {
      return { handle, record: rec };
    }
  }
  for (const [handle, rec] of Object.entries(peers)) {
    if (rec.observed.name === specHandle) return { handle, record: rec };
  }
  return null;
}

/**
 * Tým volajícího — vyhledávací doména pro krátké tvary jmen.
 *
 * 🔴 ŠEST KOPIÍ, ŠESTKRÁT TÁŽ VADA (2026-09-05). Každý z šesti handlerů si
 * nesl vlastní `callerTeamOf` s tělem `state.peers[requestedBy.sessionId]`, což
 * je syrové indexování KLÍČEM. Pro adoptovaného volajícího vyšlo (klíč JE
 * session id), pro spawnutého vrátilo `undefined`.
 *
 * Následek nebyl hlášený, protože nevypadá jako vada nástroje: spawnutý peer
 * prostě nemá vyhledávací doménu, takže `peer_restart peer:"velitel"` u něj
 * skončí na `ambiguous_peer`, zatímco témuž volání od adoptovaného souseda
 * projde. Uživatel to přečte jako svůj překlep.
 *
 * Kopie je taky to, čím se to udrželo: šest těl znamená šest míst, kde se ta
 * oprava musí udělat, a nikdo je nedělá najednou. Proto je tady jedno.
 */
export function teamOfSession(peers: Record<string, PeerRecord>, sessionId: string): string | null {
  const hit = resolvePeerRef(peers, sessionId);
  return hit.kind === "found" ? (hit.record.desired.team ?? null) : null;
}

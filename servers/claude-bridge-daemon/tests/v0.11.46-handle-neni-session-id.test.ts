import { describe, expect, it } from "vitest";
import { forkGuard } from "../src/handlers/fork-guard.ts";
import {
  knownSessionIds,
  recordForSpecHandle,
  resolvePeerRef,
  teamOfSession,
} from "../src/handlers/peer-ref.ts";
import { trustCanonicalTarget } from "../src/hosts/driver.ts";
import type { PeerRecord, StateDoc } from "../src/state.ts";
import { makePeer } from "./peer-fixture.ts";

/**
 * JEDEN KOŘEN, PĚT MÍST: registr má dva druhy klíčů a čtenáři to nevědí.
 *
 *     adoptovaný   klíč = session id   (team-adopt.ts:532)
 *     spawnutý     klíč = jméno od volajícího
 *
 * Každé místo, které indexuje syrovým klíčem, je proto správně pro půlku
 * flotily a špatně pro druhou. Fixtura níž je zmenšenina živého stavu z
 * 2026-09-05: 25 adoptovaných pod UUID, jeden spawnutý pod jménem.
 */
const ADOPTED = "ab9f2ec5-8635-49b1-a720-89eca403ecb5";
const SPAWNED_SID = "ba09cc10-fc3a-4205-80e7-ccfbd30aa5df";

function fleet(): Record<string, PeerRecord> {
  return {
    // adoptovaný: klíč JE session id
    [ADOPTED]: makePeer(
      ADOPTED,
      { team: "mic" },
      {
        name: "mic-bitrix-dev",
        sessionId: ADOPTED,
        identity: "measured",
        tmuxTarget: trustCanonicalTarget("@7523"),
      },
    ),
    // spawnutý: klíč je jméno, session id je ZMĚŘENÉ vedle
    "mic-hw-dev": makePeer(
      "mic-hw-dev",
      { team: "mic" },
      {
        name: "mic-hw-dev",
        sessionId: SPAWNED_SID,
        identity: "measured",
        tmuxTarget: trustCanonicalTarget("mic-hw-dev"),
      },
    ),
  };
}

const noHostSession = {
  name: "mock",
  hasSession: async () => false,
} as unknown as Parameters<typeof forkGuard>[1];

describe("fork-guard se ptal, jestli je zabraný HANDLE — ne jestli běží SESSION", () => {
  it("odmítne spawn pod JMÉNEM peera, který běží pod jiným klíčem", async () => {
    // Přesně běh velitele 2026-09-04: teams/mic.json nese "mic-bitrix-dev",
    // záznam je klíčovaný UUID, v tmuxu žádná session toho jména není.
    const hit = await forkGuard({ peers: fleet() } as unknown as StateDoc, noHostSession, {
      handle: "mic-bitrix-dev",
      sessionKey: "mic-bitrix-dev",
      displayName: "mic-bitrix-dev",
    });
    expect(hit?.reason).toBe("name_live");
    expect(hit?.details["liveHandle"]).toBe(ADOPTED);
  });

  it("odmítne resume přepisu, který už někdo drží — dva procesy, jeden přepis", async () => {
    const hit = await forkGuard({ peers: fleet() } as unknown as StateDoc, noHostSession, {
      handle: "uplne-jine-jmeno",
      sessionKey: "uplne-jine-jmeno",
      displayName: "uplne-jine-jmeno",
      resumeSessionId: ADOPTED,
    });
    expect(hit?.reason).toBe("identity_live");
  });

  it("ZASTAVENÝ záznam nebrání — jinak by nešel restart ani resume týmu", async () => {
    const peers = fleet();
    (peers[ADOPTED] as PeerRecord).observed.status = "stopped";
    const hit = await forkGuard({ peers } as unknown as StateDoc, noHostSession, {
      handle: "mic-bitrix-dev",
      sessionKey: "mic-bitrix-dev",
      displayName: "mic-bitrix-dev",
      resumeSessionId: ADOPTED,
    });
    expect(hit).toBeNull();
  });

  it("nezměřená identita na resume NEBLOKUJE — pamatovaná hodnota není důkaz", async () => {
    const peers = fleet();
    (peers[ADOPTED] as PeerRecord).observed.identity = "unknown";
    const hit = await forkGuard({ peers } as unknown as StateDoc, noHostSession, {
      handle: "jine",
      sessionKey: "jine",
      displayName: "jine",
      resumeSessionId: ADOPTED,
    });
    expect(hit).toBeNull();
  });
});

describe("resolver: odkaz session idčkem musí trefit i peera klíčovaného jménem", () => {
  it("najde spawnutého peera podle jeho ZMĚŘENÉHO session id", () => {
    const hit = resolvePeerRef(fleet(), SPAWNED_SID);
    expect(hit.kind).toBe("found");
    expect(hit.kind === "found" && hit.handle).toBe("mic-hw-dev");
  });

  it("dva záznamy s jedním session id = odmítnout, ne hádat", () => {
    const peers = fleet();
    peers["dvojnik"] = makePeer(
      "dvojnik",
      {},
      { name: "dvojnik", sessionId: SPAWNED_SID, identity: "measured" },
    );
    expect(resolvePeerRef(peers, SPAWNED_SID).kind).toBe("ambiguous");
  });
});

describe("knownSessionIds: reconcile se ptal klíčů pod jménem, které slibovalo session id", () => {
  it("nese ZMĚŘENÉ session id spawnutého peera, ne jen jeho klíč", () => {
    const known = knownSessionIds(fleet());
    expect(known.has(SPAWNED_SID)).toBe(true);
    expect(known.has(ADOPTED)).toBe(true);
  });
});

describe("specifikace mluví jmény, registr klíčuje session idčkem", () => {
  it("položka specifikace najde adoptovaný záznam pod UUID klíčem", () => {
    const m = recordForSpecHandle(fleet(), "mic-bitrix-dev");
    expect(m?.handle).toBe(ADOPTED);
  });

  it("peer, který ve flotile není, zůstává null — spec ho smí chtít spawnout", () => {
    expect(recordForSpecHandle(fleet(), "mic-nikdo")).toBeNull();
  });
});

describe("tým volajícího: šest kopií, šestkrát táž vada", () => {
  it("spawnutý volající má tým stejně jako adoptovaný", () => {
    expect(teamOfSession(fleet(), SPAWNED_SID)).toBe("mic");
    expect(teamOfSession(fleet(), ADOPTED)).toBe("mic");
  });

  it("neznámé session id nemá tým a nevymýšlí si ho", () => {
    expect(teamOfSession(fleet(), "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

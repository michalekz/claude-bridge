import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyAckFile } from "../src/handlers/ack-protocol.ts";

/**
 * v0.11.42 — ack odpovídá OKNU, ve kterém byl vyžádán.
 *
 * DVĚ DÍRY, KTERÉ PATŘÍ K SOBĚ (nalezl ai-velitel 29. 8. při první ostré akci):
 *
 * ① Resume vypršelé žádosti si bral PŮVODNÍ deadline ⇒ okno vyšlo 0 ms
 *    (naměřeno `waitedMs: 1`), zatímco hláška slibovala „call again to keep
 *    waiting… a late ack still counts". Po vypršení ten slib neplatil.
 *
 * ② Ack zapsaný po konci okna zůstával na disku jako MINA. Velitel našel
 *    potvrzení z 13:24 pro žádost, kterou v 13:23 ZRUŠIL; další restart by ho
 *    vzal jako platný a pustil se rovnou do stopu ŽIVÉ pracovní session.
 *
 * A hlavně: **samostatná oprava ① by ②-minu AKTIVOVALA** — nulové okno ji do
 * té doby nechtěně krylo. Proto jdou spolu.
 */

async function ackAt(dir: string, mtimeMs: number, threadId: string): Promise<string> {
  const p = join(dir, "ack.json");
  await writeFile(p, JSON.stringify({ threadId }), "utf-8");
  const t = new Date(mtimeMs);
  await utimes(p, t, t);
  return p;
}

describe("ack platí jen pro okno, které odpovídá", () => {
  it("ack z doby PO konci okna se odmítne jako after_window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cb-ack-"));
    const requestedAt = Date.now() - 300_000; // okno začalo před 5 minutami
    const deadline = requestedAt + 60_000; // a skončilo o minutu později
    const p = await ackAt(dir, deadline + 120_000, "t-1");

    const verdict = await verifyAckFile(p, requestedAt, "t-1", [], deadline);

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe("after_window");
  });

  it("ack UVNITŘ okna platí dál — oprava nesmí umlčet normální případ", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cb-ack-"));
    const requestedAt = Date.now() - 60_000;
    const deadline = requestedAt + 120_000;
    const p = await ackAt(dir, requestedAt + 30_000, "t-1");

    const verdict = await verifyAckFile(p, requestedAt, "t-1", [], deadline);

    expect(verdict.accepted).toBe(true);
    expect(verdict.reason).toBe("fresh");
  });

  it("bez deadline se chová jako dřív — volající, který okno nezná, nic neztratí", async () => {
    // `null` je záměrně samostatný stav: „tenhle volající okno nesleduje".
    // Kdyby se místo něj dosadila nula nebo „teď", odmítalo by se všechno.
    const dir = await mkdtemp(join(tmpdir(), "cb-ack-"));
    const requestedAt = Date.now() - 300_000;
    const p = await ackAt(dir, Date.now(), "t-1");

    const verdict = await verifyAckFile(p, requestedAt, "t-1", [], null);

    expect(verdict.accepted).toBe(true);
  });

  it("vteřina rezervy platí na OBOU koncích okna", async () => {
    // Dolní hranice ji měla od začátku (hodiny souborového systému nejsou
    // přesné měřidlo). Horní ji musí mít taky, jinak by ack zapsaný v téže
    // vteřině, kdy okno skončilo, propadl kvůli zaokrouhlení.
    const dir = await mkdtemp(join(tmpdir(), "cb-ack-"));
    const requestedAt = Date.now() - 60_000;
    const deadline = requestedAt + 30_000;
    const p = await ackAt(dir, deadline + 500, "t-1");

    const verdict = await verifyAckFile(p, requestedAt, "t-1", [], deadline);

    expect(verdict.accepted).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_PARK_WORK_TIMEOUT_MS } from "../src/handlers/ack-protocol.ts";
import { DEFAULT_RESTART_READY_TIMEOUT_MS } from "../src/handlers/restart-protocol.ts";
import { DEFAULT_STOP_ACK_TIMEOUT_MS } from "../src/handlers/stop-protocol.ts";

/**
 * v0.11.43 — okno na poctivé odložení práce je JEDNO číslo.
 *
 * Nález ai-int-deva přes velitele: `ready` okno 120 s je v témž řádu jako cena
 * poctivého uzavření práce — samotný `commit.sh` jede ~60 s testů. Peer tedy
 * okno propálí PRACÍ, ne nečinností, a `ready_timeout` znamená „nic se
 * nestalo": celá operace se zahodí uprostřed toho, oč jsme ho požádali.
 * Sobotní vlna na tom shodila tři restarty (etl-velitel, web-dev, int-dev).
 *
 * 🔴 A to číslo bylo od začátku POD jediným měřením, které samo citovalo.
 * Komentář u něj stál doslova: „NOT MEASURED… the one measurement nearby says
 * that class of work took 122 s". 120 < 122.
 *
 * `peer_compact` si svou 300 s vyladil už 28. 8. — a sourozenci zůstali na
 * 120 s. Lekce naučená na jednom místě, nepřenesená na ostatní.
 */
describe("jedna práce, jedno okno", () => {
  it("restart i stop berou TÉŽE číslo — tři kopie by se zase rozešly", () => {
    expect(DEFAULT_RESTART_READY_TIMEOUT_MS).toBe(DEFAULT_PARK_WORK_TIMEOUT_MS);
    expect(DEFAULT_STOP_ACK_TIMEOUT_MS).toBe(DEFAULT_PARK_WORK_TIMEOUT_MS);
  });

  it("okno je delší než nejdražší ZMĚŘENÁ část té práce", () => {
    // 122 s zápis kotvy (6. 8.) + ~60 s commit.sh (int-dev) = 182 s práce,
    // o které víme. Okno musí nechat rezervu, ne se jí dotýkat těsně:
    // číslo, které se rovná měření, selže při prvním pomalejším dni.
    const measuredWorkMs = 122_000 + 60_000;
    expect(DEFAULT_PARK_WORK_TIMEOUT_MS).toBeGreaterThan(measuredWorkMs);
  });
});

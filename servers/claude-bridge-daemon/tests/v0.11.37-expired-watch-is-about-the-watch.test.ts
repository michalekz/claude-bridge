/**
 * v0.11.37 — vypršelé okno hlídky je výrok o MĚŘIDLE, ne o světě.
 *
 * 🔴 INCIDENT 28. 8. 08:4x, `mic-velitel` (877 tis. tokenů):
 *
 *     08:42:55,626  démon vstříkl /compact
 *     08:45:56      hlídka to vzdala           ← DEFAULT_VERIFY_TIMEOUT_MS 180 s
 *     08:46:46,728  compactMetadata, durationMs 230 224
 *                   ⇒ START 08:42:56,5 = 0,9 s PO vstřiku
 *
 * Compact PROBĚHL a doběhl 50 s po verdiktu. Verdikt byl `error`
 * (`compact_not_observed`), operátor ho přečetl jako „neproběhlo", vstřikl
 * druhý `/compact` do session, která už byla zkomprimovaná, a compact, který
 * mezitím doběhl, si připsal jako svůj.
 *
 * Text toho verdiktu byl přitom opatrný („nothing is KNOWN to have
 * happened"). **TVAR ho přebil.** `error` se čte jako selhání operace.
 *
 * A příčina nebyla jen krátký limit: hlídka neuměla stav „PRÁVĚ PROBÍHÁ".
 * Běžící compact vypadá v transkriptu přesně jako žádný.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_VERIFY_TIMEOUT_MS } from "../src/compact-verify.ts";
import { stillRunningAtExpiry } from "../src/handlers/peer-compact.ts";
import type { AgentBusy } from "../src/hosts/agents-json.ts";

describe("rozpočet hlídky", () => {
  it("🔴 pokrývá NAMĚŘENÝCH 230 s, ne jen dřívějších 130 s", () => {
    // Konstanta je VYBRANÁ, ne odvozená — tři body (122 a 130 @ 760k,
    // 230 @ 877k) model nedají. Test hlídá jediné, co je doložitelné:
    // že nesmí být pod nejdelším skutečně naměřeným trváním.
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBeGreaterThan(230_224);
    // A s rezervou, protože peeři rostou — to je celá lekce té konstanty.
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });
});

describe("co znamená vypršení", () => {
  it("peer PRACUJE ⇒ slučitelné s běžícím compactem", () => {
    expect(stillRunningAtExpiry("busy")).toBe(true);
  });

  it("peer NEPRACUJE ⇒ opravdu se nic nepozorovalo", () => {
    expect(stillRunningAtExpiry("idle")).toBe(false);
  });

  it("🔴 NEZNALOST se nesmí stát uklidněním", () => {
    // `blocksInject` bere `probe-failed` jako důvod NEPOSÍLAT a je to správně:
    // nevíš → neposílej. Tady je asymetrie obrácená. „Nevíme, co peer dělá"
    // nesmí vyjít jako „nejspíš to běží, jen počkej" — to by z chybějícího
    // měření udělalo doklad o světě, tedy přesně tu vadu, kterou tahle verze
    // opravuje, jen o patro vedle.
    const nevime: AgentBusy[] = ["absent", "probe-failed", "unknown"];
    for (const v of nevime) {
      expect(stillRunningAtExpiry(v)).toBe(false);
    }
  });
});

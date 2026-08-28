import type { DaemonConfig } from "./config.ts";
import type { PeerDesired } from "./state.ts";

/**
 * Kudy peer chodí na Anthropic — JEDNO místo, kde se to rozhoduje.
 *
 * 🔴 Proč vlastní modul a ne dvě podmínky na dvou místech: 27. 8. se u
 * `exhausted` ukázalo, co udělají dva obhajitelné predikáty nad týmž jevem.
 * Shodly se v 95 % případů a rozešly se přesně tam, kde na tom záleželo.
 * Spawn (co dosadit) a brána (kdy odmítnout) se ptají na TOTÉŽ, takže se
 * ptají jednou funkcí.
 *
 * ROZHODUJE SE VE DVOU ÚROVNÍCH A KAŽDÁ MÁ TŘI STAVY:
 *
 *   peer    `desired.anthropicBaseUrl`        chybí → spadni níž · řetězec · null
 *   flotila `config.spawn.anthropicBaseUrl`   chybí → nerozhodnuto · řetězec · null
 *
 * `null` znamená ZÁMĚRNĚ NAPŘÍMO, `chybí` znamená NIKDO NEROZHODL. Kdyby
 * to byl jeden stav, brána by musela buď obtěžovat každého, kdo proxy nemá,
 * nebo mlčet u každého, kdo o ni přišel. (Táž past jako `args: []`, jen
 * o den později a v jiném poli.)
 */
export type BaseUrlSource =
  /** Peer si to řekl sám. */
  | "peer"
  /** Peer je ZÁMĚRNĚ mimo proxy. */
  | "peer-direct"
  /** Flotilový default z `config.json`. */
  | "fleet"
  /** Celá flotila jede ZÁMĚRNĚ napřímo. */
  | "fleet-direct"
  /** Nikdo nerozhodl. Není to totéž co „napřímo" — je to „nevíme". */
  | "undecided";

export interface BaseUrlDecision {
  /** Hodnota k dosazení, nebo `null` = žádnou proměnnou nenastavovat. */
  value: string | null;
  source: BaseUrlSource;
  /**
   * Rozhodl NĚKDO? Tohle, ne `value`, řídí bránu.
   *
   * `value: null` má dva důvody — „záměrně napřímo" a „nikdo nerozhodl" —
   * a brána na ně musí reagovat opačně. Kdyby se ptala na `value`, mlčela by
   * u obou.
   */
  decided: boolean;
}

export function resolveBaseUrl(
  desired: Pick<PeerDesired, "anthropicBaseUrl"> | undefined,
  config: Pick<DaemonConfig, "spawn">,
): BaseUrlDecision {
  const peer = desired?.anthropicBaseUrl;
  if (typeof peer === "string" && peer.length > 0) {
    return { value: peer, source: "peer", decided: true };
  }
  if (peer === null) return { value: null, source: "peer-direct", decided: true };

  const fleet = config.spawn?.anthropicBaseUrl;
  if (typeof fleet === "string" && fleet.length > 0) {
    return { value: fleet, source: "fleet", decided: true };
  }
  if (fleet === null) return { value: null, source: "fleet-direct", decided: true };

  return { value: null, source: "undecided", decided: false };
}

/**
 * Vzal by tenhle restart peerovi proxy, aniž by to někdo chtěl?
 *
 * SROVNÁVACÍ, NE ABSOLUTNÍ — a to je celý návrh. Absolutní požadavek („bez
 * adresy nespouštěj") by odmítal spouštět peery každé instalaci, která žádný
 * router identit nemá, a most se rozdává ven. Tahle otázka se ptá jen na to,
 * co incident 27. 8. skutečně byl: **peer JEL za proxy a restart by ho z ní
 * vyhodil, protože o tom nikdo nerozhodl.**
 *
 * ⚠ Odmítnutí NEŽÁDÁ konkrétní hodnotu, žádá ROZHODNUTÍ. Kdo chce peera
 * vědomě mimo proxy, deklaruje `null` a brána mlčí. To je rozdíl mezi
 * pojistkou a překážkou.
 */
export function restartWouldDropProxy(
  decision: BaseUrlDecision,
  liveEnviron: Record<string, string> | null,
): boolean {
  if (decision.decided) return false;
  // Nevíme, co peer má → nevíme, že o něco přijde. Mlčet je tu správně:
  // brána hlídá doloženou ztrátu, ne domněnku.
  if (!liveEnviron) return false;
  const live = liveEnviron["ANTHROPIC_BASE_URL"];
  return typeof live === "string" && live.length > 0;
}

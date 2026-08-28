/**
 * v0.11.35 — `ANTHROPIC_BASE_URL` se peerovi SKUTEČNĚ dosadí, a restart
 * ho o ni nesmí tiše připravit.
 *
 * 🔴 INCIDENT 27. 8. 19:07. `peer_restart` vrátil `mic-bitrix-dev` bez proxy,
 * tedy na tokenu STROJE. Chytil to až detektor C po deseti minutách.
 * v0.11.32 přitom „opravovala" právě tohle — přidala proměnnou do
 * `SPAWN_ESSENTIAL_CLAUDE_VARS`, což znamená jen „override s tímhle jménem
 * SMÍ projít". Otevřela bránu. NIKDO JÍ NEPROŠEL: grep celého `src/` mimo
 * whitelist = nula výskytů.
 *
 * 🔴 A PROČ TO TEHDEJŠÍ TEST NECHYTIL — to je jádro téhle sady. Ten test
 * volal `sanitizeEnv({}, {overrides: {ANTHROPIC_BASE_URL: …}})`, tedy si
 * override DODAL SÁM. Dokázal, že brána jde otevřít; nedokazoval, že jí
 * někdo projde. KÁNON: opravit oprávnění není opravit akci.
 *
 * Proto první test níž nespouští `sanitizeEnv`, ale SKUTEČNÝ PROCES, a ptá
 * se JEHO, co má v prostředí. Datovou strukturu lze přesvědčit; `printenv`
 * ne.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBaseUrl, restartWouldDropProxy } from "../src/base-url.ts";
import { makePeer } from "./peer-fixture.ts";

const homeHolder = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

const PROXY = "http://127.0.0.1:8402";
let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-baseurl-"));
  homeHolder.current = home;
  vi.resetModules();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("🔴 dosazení dorazí až do PROCESU, ne jen do struktury", () => {
  it("peer spuštěný démonem má ANTHROPIC_BASE_URL ve svém prostředí", async () => {
    const { dispatch } = await import("../src/handlers/index.ts");
    const { emptyState } = await import("../src/state.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");
    const { writeConfig } = await import("../src/config.ts");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".claude-bridge", "control"), { recursive: true });
    await writeConfig({
      compactWatchdog: { enabled: false, warnAtPercent: 0.85, criticalAtPercent: 0.95 },
      spawn: { anthropicBaseUrl: PROXY },
    });

    const out = join(home, "videno.txt");
    const doc = emptyState("0.11.35-test");
    const res = await dispatch(
      {
        schemaVersion: 1 as const,
        id: "req-spawn-env",
        ts: "2026-08-28T06:00:00.000Z",
        tool: "peer_spawn",
        args: {
          handle: "pokus",
          displayName: "pokus",
          cwd: home,
          command: "/bin/sh",
          // Proces se zeptá SÁM SEBE a odpověď zapíše. Tohle je ten důkaz.
          args: ["-c", `printenv ANTHROPIC_BASE_URL > ${out}; sleep 5`],
        },
        requestedBy: { sessionId: "operator", name: "operator" },
      },
      { state: doc, hostDriver: new MockDriver(), daemonVersion: "0.11.35-test" },
    );
    expect(res.outcome).toBe("ok");

    await new Promise((r) => setTimeout(r, 400));
    expect((await readFile(out, "utf-8")).trim()).toBe(PROXY);
  });
});

describe("tři stavy na dvou úrovních", () => {
  const fleet = (v: string | null | undefined) =>
    ({ spawn: v === undefined ? {} : { anthropicBaseUrl: v } }) as const;

  it("peer přebije flotilu", () => {
    const d = resolveBaseUrl({ anthropicBaseUrl: "http://peer" }, fleet(PROXY));
    expect(d).toEqual({ value: "http://peer", source: "peer", decided: true });
  });

  it("peer s `null` je ZÁMĚRNĚ napřímo — rozhodnuto, ale bez hodnoty", () => {
    const d = resolveBaseUrl({ anthropicBaseUrl: null }, fleet(PROXY));
    expect(d).toEqual({ value: null, source: "peer-direct", decided: true });
  });

  it("bez deklarace peera platí flotilový default", () => {
    expect(resolveBaseUrl({}, fleet(PROXY))).toEqual({
      value: PROXY,
      source: "fleet",
      decided: true,
    });
  });

  it('🔴 CHYBĚJÍCÍ KLÍČ ≠ `null`: nikdo nerozhodl, a to není „napřímo"', () => {
    // Táž past jako `args: []` z 27. 8. Kdyby to byl jeden stav, brána by
    // musela buď obtěžovat každého bez proxy, nebo mlčet u každého, kdo
    // o ni přišel.
    const nic = resolveBaseUrl({}, fleet(undefined));
    const zamer = resolveBaseUrl({}, fleet(null));
    expect(nic).toEqual({ value: null, source: "undecided", decided: false });
    expect(zamer).toEqual({ value: null, source: "fleet-direct", decided: true });
    // Hodnota je u obou stejná. Rozlišuje je JEN `decided`.
    expect(nic.value).toBe(zamer.value);
    expect(nic.decided).not.toBe(zamer.decided);
  });

  it("prázdný řetězec se nebere jako deklarace", () => {
    expect(resolveBaseUrl({ anthropicBaseUrl: "" }, fleet(undefined)).decided).toBe(false);
  });
});

describe("brána: srovnávací, ne absolutní", () => {
  const undecided = { value: null, source: "undecided", decided: false } as const;

  it("🔴 peer JEDE za proxy a nikdo nerozhodl ⇒ ODMÍTNOUT", () => {
    expect(restartWouldDropProxy(undecided, { ANTHROPIC_BASE_URL: PROXY })).toBe(true);
  });

  it("peer za proxy nejede ⇒ mlčet (instalace bez routeru identit)", () => {
    // Absolutní podmínka by odmítala restartovat komukoli venku, kdo žádnou
    // proxy nemá. Most se rozdává ven; pojistka nesmí být překážka.
    expect(restartWouldDropProxy(undecided, { PATH: "/usr/bin" })).toBe(false);
  });

  it("kdokoli rozhodl ⇒ mlčet, i když to znamená napřímo", () => {
    const direct = { value: null, source: "peer-direct", decided: true } as const;
    expect(restartWouldDropProxy(direct, { ANTHROPIC_BASE_URL: PROXY })).toBe(false);
  });

  it("prostředí NEZNÁME ⇒ mlčet: brána hlídá doloženou ztrátu, ne domněnku", () => {
    expect(restartWouldDropProxy(undecided, null)).toBe(false);
  });
});

describe("brána v peer_restart", () => {
  it("🔴 odmítne restart, který by peera vyhodil z proxy, a NABÍDNE CESTU VEN", async () => {
    const { dispatch } = await import("../src/handlers/index.ts");
    const { emptyState } = await import("../src/state.ts");
    const { MockDriver } = await import("../src/hosts/mock-driver.ts");

    const doc = emptyState("0.11.35-test");
    // Peer běží pod naším VLASTNÍM pid — jeho `/proc/<pid>/environ` je tedy
    // čitelné a nese, co jsme si nastavili níž.
    process.env["ANTHROPIC_BASE_URL"] = PROXY;
    doc.peers["p1"] = makePeer(
      "p1",
      { team: "t", cwd: home, command: "/bin/sh", spawnArgs: [] },
      { name: "p1", status: "live", pid: process.pid, sessionId: "p1", identity: "measured" },
    );

    const res = await dispatch(
      {
        schemaVersion: 1 as const,
        id: "req-gate",
        ts: "2026-08-28T06:00:00.000Z",
        tool: "peer_restart",
        args: { peer: "p1" },
        requestedBy: { sessionId: "operator", name: "operator" },
      },
      { state: doc, hostDriver: new MockDriver(), daemonVersion: "0.11.35-test" },
    );
    process.env["ANTHROPIC_BASE_URL"] = undefined;

    expect(res.outcome).toBe("error");
    const err = (res as { error?: { code?: string; message?: string } }).error;
    expect(err?.code).toBe("restart_would_drop_proxy");
    const msg = err?.message ?? "";
    // Odmítnutí, které nenabídne cestu ven, je slepá ulička — přesně ta,
    // do které jsme 27. 8. zabředli u `spawnArgs`.
    expect(msg).toContain("control_config");
    expect(msg).toContain("anthropicBaseUrl:null");
    expect(msg).toContain(PROXY);
  });
});

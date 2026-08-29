import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeHolder = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeHolder.current };
});

/**
 * v0.11.41 — `peer_unmanaged` mělo jednu radu na dvě různé situace.
 *
 * NARAZILO TO NAOSTRO 29. 8.: skutečná pracovní session (88 % kontextu,
 * klientská práce) běžela pod cc-démonem, tedy BEZ tmux hostitele. Compact na
 * ni dostal správný verdikt `peer_unmanaged` — a k němu radu „adopt it with
 * team_adopt, then retry", kterou příjemce NEMŮŽE provést. Celý lifecycle
 * démona stojí na tmux targetu; záznam bez něj je záznam, o kterém by každé
 * zastavení, restart i compact lhaly.
 *
 * Rada, která nejde provést, posílá člověka hledat chybu tam, kde žádná není.
 */

async function heartbeat(root: string, rec: Record<string, unknown>) {
  await mkdir(join(root, "status"), { recursive: true });
  await writeFile(
    join(root, "status", `${rec["id"]}.json`),
    JSON.stringify({ lastSeen: new Date().toISOString(), ...rec }),
    "utf-8",
  );
}

async function sessionFile(home: string, pid: number, kind: string) {
  await mkdir(join(home, ".claude", "sessions"), { recursive: true });
  await writeFile(
    join(home, ".claude", "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId: "s", kind }),
    "utf-8",
  );
}

describe("rada u nedosažitelného peera závisí na TŘÍDĚ session", () => {
  let root: string;
  beforeEach(async () => {
    homeHolder.current = await mkdtemp(join(tmpdir(), "cb-home-"));
    // `bridgeRoot()` je `homedir()/.claude-bridge`, a `homedir` je zamokovaný.
    root = join(homeHolder.current, ".claude-bridge");
    vi.resetModules();
  });

  it("cc-démoní session: NEADOPTOVAT, lifecycle patří jejímu vlastníkovi", async () => {
    const { unresolvedPeerError } = await import("../src/handlers/peer-ref.ts");
    await heartbeat(root, { id: "bg-1", name: "mic-bitrix-dev", pid: 4242, kind: "bg" });

    const err = await unresolvedPeerError("mic-bitrix-dev");

    expect(err.code).toBe("peer_unmanaged");
    expect(err.details["remedy"]).toBe("owner-of-the-session");
    expect(err.message).toMatch(/BY DESIGN/);
    expect(err.message).toMatch(/Do NOT adopt/);
    // Rada, kterou příjemce provést nemůže, tam nesmí zbýt ani jako návrh.
    expect(err.message).not.toMatch(/adopt it with team_adopt/);
  });

  it("tmux peer bez záznamu: adopce je pořád ten správný lék", async () => {
    const { unresolvedPeerError } = await import("../src/handlers/peer-ref.ts");
    await heartbeat(root, { id: "tm-1", name: "plt-alpha", pid: 4243, kind: "interactive" });

    const err = await unresolvedPeerError("plt-alpha");

    expect(err.details["remedy"]).toBe("team_adopt");
    expect(err.message).toMatch(/adopt it with team_adopt/);
    // U změřené interaktivní session se nepřidává podmínka „nejdřív ověř".
    expect(err.message).not.toMatch(/kind could not be read/);
  });

  it("`kind` se dohledá ze sessions souboru, když ho heartbeat nenese", async () => {
    // Flotila běží na pluginu starším než v0.11.39, takže `kind` v heartbeatu
    // NENÍ — a přesto se ta rada musí rozlišit. Soubor píše Claude Code sám.
    const { unresolvedPeerError } = await import("../src/handlers/peer-ref.ts");
    await heartbeat(root, { id: "bg-2", name: "mic-tester", pid: 4244 });
    await sessionFile(homeHolder.current, 4244, "bg");

    const err = await unresolvedPeerError("mic-tester");

    expect(err.details["remedy"]).toBe("owner-of-the-session");
  });

  it("neznámý `kind` radí PODMÍNEČNĚ — z nevědomosti se nedělá jistota", async () => {
    // Tři stavy: `bg`, `interactive`, a „nevíme". Třetí se nesmí tvářit jako
    // druhý, jinak by rada zněla stejně jistě u session, kterou adoptovat
    // nelze.
    const { unresolvedPeerError } = await import("../src/handlers/peer-ref.ts");
    await heartbeat(root, { id: "unk-1", name: "etl-ghost", pid: 4245 });

    const err = await unresolvedPeerError("etl-ghost");

    expect(err.details["kind"]).toBeNull();
    expect(err.message).toMatch(/kind could not be read/);
    expect(err.message).toMatch(/must NOT be adopted/);
  });
});

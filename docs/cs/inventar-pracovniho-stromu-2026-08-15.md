---
status: verified
verified_at: 2026-08-15
verified_by: ai-bridge-dev
purpose: Co leží na pracovním stromě, rozdělené na DVA nezávislé celky s odlišnými bránami. Podklad pro commit a nasazení.
---

# Inventář pracovního stromu

Na stromě jsou **dva celky, které spolu nesouvisí a nesmí se slít do jednoho commitu**.
Pořadí je závazné (shoda všech revizorů F0.5): **celek A první**.

## Celek A — pět hotových oprav (čeká na Zdeňkovu bránu od 11. 8.)

| # | co | soubory |
|---|---|---|
| #105 | mrtvá brána proti dvojitému compactu (sonda `agents --json` volala holé `claude`) | `src/hosts/agents-json.ts`, `src/handlers/peer-compact.ts` |
| #105 | `Environment=PATH` v systemd unitu — **bez toho oprava neúčinkuje** | `src/templates/…service`, `templates/…service`, `src/install.ts` |
| #106 ① | force-stop žádá doklad (tep < 30 s ⇒ odmítnout, `overrideLiveness` přebíjí) | `src/handlers/peer-stop.ts`, `peer-restart.ts` |
| #106 ② | `peer_unmanaged` místo `peer_not_found` | `src/handlers/peer-ref.ts` |
| #107 ② | práh compactu 85 % na straně démona (`belowThreshold` přebíjí) | `src/compact-verify.ts`, `src/handlers/peer-compact.ts` |
| #109 | `OOMScoreAdjust=0` — démon z první řady obětí earlyoomu do druhé | obě dvojčata `…service` |

Testy: `tests/v0.11.27-force-needs-evidence.test.ts`, `tests/v0.11.27-compact-threshold.test.ts`.

⚠ **Oprava unitu se sama nenasadí** — bez přepsání `Environment=PATH` a `daemon-reload`
bude sonda selhávat dál i s novou binárkou.

## Celek B — zpevnění vstupní cesty (#111, po revizích F0.5)

| co | soubory |
|---|---|
| snímek stavu panelu; odmítnutí zmizelého cíle a mrtvého panelu; detekce bez nápravy | `src/hosts/tmux-driver.ts` |
| `copy-mode -q` místo `send-keys -X cancel` (**jediný skutečný bug nalezený revizí**) | `src/hosts/tmux-driver.ts` |
| `history-limit 2000` na session před `new-window` | `src/hosts/tmux-driver.ts` |
| startovní hygiena: kanárek verze tmuxu + úklid osiřelých bufferů | `src/hosts/tmux-driver.ts`, `src/hosts/driver.ts`, `src/daemon.ts` |
| R3 „druhý znak": `%N` je adresa, ne jméno session | `src/hosts/driver.ts`, `src/hosts/tmux-driver.ts` |
| **#103 restart vrací peera na jeho index** (`move-window -b`; `renumber-windows on` dělá z create pouhé připojení na konec) | `src/handlers/peer-restart.ts`, `peer-spawn.ts`, `src/hosts/driver.ts`, `tmux-driver.ts` |

Testy: `tests/v0.11.28-pane-snapshot.test.ts`, `tests/lab/` (postroj + F0 brána).
Upravený: `tests/v0.10.1-verified-sendkeys.test.ts` — kontrakt zmizelého cíle se posunul
(dřív dva pokusy do prázdna a `not-verified`, teď odmítnutí před prvním úderem).

## Dokumentace (bez vlivu na běh)

`docs/cs/analyza-rizeny-tmux-2026-08-14.md`, `zadani-rizeny-tmux.md`, `plan-rizeny-tmux.md`,
`mereni-compact-hooku-2026-08-13.md`, `plan-pluginu.md`, `docs/incidents/`.

## ⏸ VÝVOJ POZASTAVEN 16. 8. (Zdeněk)

*„Pozastavme vývoj. Musím se teď věnovat jiným projektům, vrátíme se k tomuto později."*

Předcházela tomu jeho věta: **„Jsem ze stávajícího stavu nešťastný a obávám se, že jdeme špatným
směrem."** Nerozhodnuto, který ze čtyř výkladů platí — a je to první otázka po návratu:

| # | výklad | co k němu mám |
|---|---|---|
| ① | architektura (tmux + send-keys) je špatná | proti: doručování 346/351 měřeno dobře |
| ② | postup — moc analýzy, málo výsledku | **souhlasím**; dnešek: 8 měření k „peer je v pořádku", 2 špatné diagnózy |
| ③ | špatné priority — chytáme, co spadne | částečně; 16. 8. jsem 2× přerušil rozdělanou práci |
| ④ | **26 peerů na jednom stroji je neudržitelné** | nejvíc dat: 9,3 GB stálých, špičky 16,8 GB, earlyoom, binárka 100×/týden |

Data, která ten pocit podpírají: **za 5 dní přibylo 7 kritických úloh a nasadilo se nic.**

## Rozpracované, NEZAPOJENÉ

`src/reconcile-agents.ts` — smíření registru s `agents --json` (spravované / nespravované /
neuvedené / kolize jmen). **Kompiluje, ale NIKDO HO NEVOLÁ a nemá testy.** Zbývalo: zapojit do
`team_status`, událost `agents_unmanaged`, testy s fixturou z 16. 8. Odhad hodina.
Ponechán na stromě kvůli analýze v komentářích (dva incidenty, důvod pro sjednocený klíč).

## Brána

```
431 testů (démon) · tsc 0 · biome čistý
NASAZENO NIC · flotila beze změny · produkční tmux nedotčen
```

Commit řeší designer (mandát od 5. 8.), nasazení Zdeněk. Celek A má přednost — leží od 11. 8.

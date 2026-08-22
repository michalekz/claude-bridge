---
status: proposal
verified_at: 2026-08-15
verified_by: ai-bridge-dev — po revizích F0.5 (zapracovány všechny 4)
purpose: Prováděcí plán k zrevidovanému zadání — minimální rozsah, testovací implementace na izolovaném socketu.
sources: [docs/cs/zadani-rizeny-tmux.md]
---

# Plán: zpevnění vstupní cesty — po revizích

Rozsah po škrtech skeptika: ~200 řádků kódu + testy, žádná nová architektura. Vše na pracovním
stromě a izolovaném socketu; nasazení mimo rozsah.

## Změny proti původnímu plánu (F0.5 výstup)

- F1 „automat jako modul" → **zúženo na rozšíření snímku v `tmux-driver.ts`** (detekce bez nápravy)
  + oprava `copy-mode -q`.
- F2 „restrikce+konfig šablona" → **ŠKRTNUTO** (vazby jen serverové — zasáhly by `tst-c`;
  0 výskytů). Zbývá: history-limit ve spawn, kanárek verze, lint, úklid bufferů.
- F3 „doprava B za flagem" → **ŠKRTNUTO** (346/351 OK; spouštěč: první interleave).
- F4 GUI tester → **zúženo a VÝHRADNĚ na `-L cblab`** (kb-ops ⑧b: jeho produkční session
  se nesmí rozsypat) — scénáře: lidský zásah do doručování, S0/membership HANDOFF, detekce.
- Pořadí: **pět čekajících oprav se commituje a nasazuje PŘED touto prací** (provoz ⑩,
  kb-ops ⑧a) — tato práce je hotová na stromě, ale do balíku jde AŽ ZA nimi.

## Fáze

| fáze | obsah | brána |
|---|---|---|
| G0 ✅ | lab postroj (`tests/lab/tmux-lab.ts`) | 4/4 testy, sokety uklizeny |
| G1 | snímek (tab oddělovač, S-1/S0/membership/detekce) + `copy-mode -q` v `tmux-driver.ts` | jednotkové + lab testy, kritéria 1–3 |
| G2 | history-limit ve spawn + úklid bufferů + kanárek verze + lint `pipe-pane -o` | kritéria 5, 6 |
| G3 | payload matice vč. wide znaků na skutečném CC (haiku, compact-lab) | kritérium 4 |
| G4 | GUI tester na labu (plt-gui-tester přes most, session na `-L cblab`) | kritérium 2, 7 + jeho protokol |
| G5 | zpráva Zdeňkovi: doklady, škrty se spouštěči, jeho brány | — |

## Vlastnictví a brány (kb-ops ⑨b)

- návrh a kód: **bridge-dev** · aplikace čehokoli na produkční tmux: **kb-ops** · GO: **Zdeněk**
- Kdyby se někdy vracely restrikce: undo se **generuje z živého stavu** (`list-keys`,
  `show-options`, `show-hooks`) PŘED aplikací a ověřuje bajtovým porovnáním po návratu (kb-ops ⑤).
- Rollback čehokoli z G1–G2: revert na stromě; běhové chování se mění až nasazením démona.

## Rizika

| riziko | krytí |
|---|---|
| falešný HANDOFF (živý peer označen k restartu) | primární signál pid+dead, jméno sekundární; kritérium 1 |
| detekční událost zaplaví log | jen ne-čisté snímky; čistota jako bool na stávajícím logu |
| smíchání s 5 čekajícími opravami | commit pořadí: opravy první (designerův mandát), tato práce za nimi |
| kontrakt CC se změní | testy proti skutečnému CC; verify se ohlásí sám |

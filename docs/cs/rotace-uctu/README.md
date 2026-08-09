# Rotace předplatitelských účtů

Dva dokumenty z měření 9. 8. 2026. Zdroj publikovaných stránek — otevři je
v prohlížeči, nebo je znovu publikuj beze změny obsahu.

| soubor | co je | komu |
|---|---|---|
| `rozhodnuti.html` | rozhodnutí a doporučení, krátké | vlastník |
| `protokol.html` | metoda, chronologie, 22 hypotéz včetně vyvrácených, nástroje, návrh démona a jeho ovládání | designer, budoucí vývoj |
| `zadani-samostatneho-nastroje.md` | **platné zadání** — rotace jako samostatný firemní nástroj mimo claude-bridge | implementace |

Uloženo jako HTML, ne jako markdown, **záměrně**: je to přesný zdroj
publikovaných stránek. Druhý formát téhož textu by se rozešel a nikdo by nevěděl,
který z nich platí.

## Stav k 9. 8. 2026

- Doporučení: roční tokeny ze `setup-token` jako **cílové** řešení.
- Distribuce ven: **vlastník rozhodl vydat veřejně.** Před vydáním je potřeba
  změřit chování na macOS, nebo přiznat podporu platforem — Claude Code tam drží
  přihlášení v Keychainu, ne v souboru.
- Posudek designera zapracován.
- **Směr se večer změnil:** rotace nepůjde do claude-bridge, ale vznikne jako samostatný
  nástroj v privátním firemním repozitáři. Ruší to všech pět otázek kolem distribuce.
  Návrh démona v `protokol.html` §7–8 je tím **historický** — platí `zadani-samostatneho-nastroje.md`.

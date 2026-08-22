# Pilot P0 — minimalistický, testuje NÁMITKY oponentury (GO Zdeněk 16. 8. ~23:30)

Zásada: každý test má PŘEDEM napsané očekávání a kritérium. Výsledek rozhodne
o verdiktu námitky — ne naopak.

## Sestava
- 2 peery přes `claude --bg` (haiku): `tst-ccd-a` (s --channels + mcp), `tst-ccd-b` (holý)
- pohledy: tmux `-L cblab-pilot` (izolovaný socket, produkce nedotčena)
- supervizor: sdílený se strojem (jiný není) — pilotní zásahy do něj jsou bezpečné,
  v rosteru nejsou žádní produkční workeři

## Testy dnes v noci (rychlé)
| T | námitka | postup | kritérium |
|---|---|---|---|
| T1 | keeper (kb-ops1/expert1) | kill supervizoru pod připojenými pohledy | oživí ho attach klienti ≤60 s? přežijí workeři? |
| T2 | binárka (expert2) | touch mtime claude.exe pod běžícím pilotem | self-restart supervizoru; přežijí workeři+pohledy? |
| T4 | stop sémantika (expert6) | claude stop → pak reply/attach | vstane? pod jakým stavem? |
| T6 | channels u --bg (Q3) | peer_ask na tst-ccd-a | doručeno do konverzace? |
| T8 | side-efekty CLI (expert3) | agents --json s mrtvým supervizorem | adopt/spare spawn? co přesně |
| T9 | roster živost (kb-ops2) | porovnat roster vs /proc v čase | pid+procStart nutné? |
| T10 | duplicitní jméno (provoz9) | dispatch téhož jména 2× | co vznikne |
| T11 | 2 pohledy různé geometrie (expert9) | attach 160×40 + 120×30 současně | chování |

## Testy přes noc / zítřek (pomalé)
| T | námitka | postup |
|---|---|---|
| T3 | klasifikace stavů (expert4/provoz4) | N tahů, sledovat state.json oscilaci |
| T5 | idle-reap ~1h (expert5) | tst-ccd-b bez okna, kontrola po 1+ h; pinning |
| T12 | RSS + spare churn (kb-ops7/provoz7) | stopa v čase, práh +4 GiB |
| T7 | /bg migrace (Q2) | interaktivní scratch → /bg → kontrola kontextu/MCP |
| T13 | dlouhý attach × respawn (Q1) | pohled připojený hodiny → claude respawn |

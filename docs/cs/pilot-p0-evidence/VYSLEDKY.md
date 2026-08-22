# Pilot P0 — výsledky (noc 16.→17. 8.)

Sestava: 2 peery `--bg` haiku (a: --channels+bypass, b: holý), pohledy tmux `-L cblab-pilot`.
Websearch křížení: changelog CC, docs agent-view, issue #60112.

| T | otázka | výsledek | dopad na námitku |
|---|---|---|---|
| T6 | channels u `--bg` | **PASS** — peer_ask doručeno, odpověď kanálem ~4 s | Q3 uzavřena; provoz 5 (obava) padá |
| T1 | kill -9 supervizoru pod pohledy | **PASS** — nový supervizor ≤90 s (podruhé <1 s), workeři 2/2 přežili, pohledy nepřerušeny | keeper NETŘEBA za běhu; kb-ops 1 / expert 1 se zužují na boot |
| T2 | touch binárky pod pilotem | **PASS** — self-restart „cause=upgrade", adopted=2 dead=0, ~15 s | expert 2 se zužuje na „EACCES + žádný klient" — vzácný průnik |
| T9 | roster vs /proc | procStart == starttime, ověření levné | kb-ops 2: přijmout jako předpis |
| T10 | duplicitní jméno | projde bez varování (2× tst-ccd-a) | provoz 9: preflight u dispatch NUTNÝ |
| T4 | stop → pohled/výpis/oživení | pohled ZEMŘE se stopem (okno zmizí) · bez `--all` zastavené NEVIDĚT · **attach stopnutou OŽIVÍ** (state: running, zpět v rosteru) | expert 6 POTVRZEN: stop není hrob; fleet_stop musí být atomický (stop+deregistrace) a fleet_status s `--all` |
| T8 | CLI s mrtvým supervizorem | oživení pod 1 s, side-efekt jen spare spawn | expert 3 se zužuje: čtení souborů preferovat, ale riziko malé |
| T11 | 2 pohledy různé geometrie | PASS — obě renderují, odpojení druhého nic nerozbilo | expert 9 částečně uzavřen |
| T3 | klasifikace stavů | **POTVRZENO**: „hotový úkol"→blocked, „rozluč se"→done — stav píše klasifikátor per tah | expert 4 / provoz 4 DRŽÍ v plné síle |

Websearch nálezy (changelog CC):
- „`claude stop` silently undone when it raced a background-agent respawn" — OPRAVENÁ rasa; třída existuje
- „roster transient corruption permanently disabling orphan cleanup" — opravená korupce rosteru
- Ctrl+T pin = „keep its process running while idle" — dokumentovaná ochrana proti idle-reap
- issue #60112: SessionStart hooky shazovaly bg sessions — naše flotila SessionStart hook MÁ; pilot přežil (2.1.233), hlídat v kanárku

## Běží přes noc
- T5 idle-reap peera b bez okna (vzorky à 10 min → night-watch.log)
- T12 RSS + počet procesů v čase
- T13 ráno: `claude respawn` pod celonočně připojeným pohledem a

## Ještě neměřeno
- T7 /bg migrace interaktivního peera (Q2) — ráno
- restart stroje (Q4) — jen při plánovaném rebootu

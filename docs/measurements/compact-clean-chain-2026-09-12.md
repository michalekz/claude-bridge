---
status: verified
verified_at: 2026-09-12
verified_by: "ai-bridge-dev (vlastní compact, doložený events.jsonl)"
purpose: "Referenční vzorek ÚSPĚŠNÉHO řízeného compactu — jak vypadá čistý řetěz událostí, proti kterému se poznává odchylka."
sources:
  - ~/.claude-bridge/control/events.jsonl (requestId mty2yr9e)
---

# Čistý řetěz řízeného compactu — referenční vzorek

Podnět plt-velitele, 12. 9. 2026: *„tři doklady, jak vypadá selhání, bez
jediného dokladu, jak vypadá úspěch, dělají z evidence katalog poruch místo
měřítka."* Tohle je ten chybějící doklad.

## Naměřený řetěz

```
07:45:28.881  request_received
07:45:28.884  peer_compact_anchor_requested   threadId compact:fb749bc6…:mty2yreb
07:46:55.492  peer_compact_inject             contextPercentBefore 87 · agentBusy idle
                                              idleWaitedMs 13 538 · injectedKeys "[daemon] /compact"
07:49:47.814  peer_compacted                  preTokens 870 353 → postTokens 19 841
07:49:48.099  request_completed               outcome ok · durationMs 259 217
```

## Co na tom čte operátor

| údaj | hodnota | proč na něm záleží |
|---|---|---|
| `anchor_requested` → `inject` | 86,6 s | peer psal kotvu; **není to prodleva, je to práce** |
| `idleWaitedMs` | 13 538 | démon čekal na konec tahu, který psal ack (v0.11.33) |
| `agentBusy` | `idle` | sonda peera pustila — inject může doletět, ne se zařadit do fronty |
| `inject` → `peer_compacted` | 172 s | samotný compact; **netrackuje velikost okna** (naměřeno 706k za 206 s vs. 929k za 128 s) |
| `preTokens` → `postTokens` | 870 353 → 19 841 | důkaz, že compact proběhl, ne že příkaz odešel |
| celkem | 259 s | pod `verifyTimeoutMs` 360 s s rezervou |

## Čtyři místa, kde se odchylka pozná

1. **Chybí `peer_compact_inject`** → skončilo to `skipped_busy` nebo
   `skipped_below_threshold`; peer nebyl vyrušen.
2. **Je `inject`, chybí `peer_compacted`** → příkaz byl DORUČEN, ne VYKONÁN
   (panel byl zaneprázdněný a Claude Code si ho zařadil do fronty — incident
   9. 8. 2026, kdy se peer zkomprimoval dvakrát).
3. **`agentBusy` jiné než `idle`** → viz `turn-end-gate.ts`: „busy" neznamená
   „uprostřed tahu", pokud peerovi běží hlídka na pozadí.
4. **`postTokens` chybí nebo se rovná `preTokens`** → compact se nespustil,
   i když všechno ostatní vypadá správně.

📌 Od v0.11.57 přijde objednateli do schránky oznámení, když výsledek NENÍ
tohle — tedy u ①. Úspěch se neoznamuje záměrně.

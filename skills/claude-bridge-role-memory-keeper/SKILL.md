---
name: claude-bridge-role-memory-keeper
description: Playbook pro Claude Code agenta v dedikované roli memory keeper — single-writer pro shared agent memory napříč týmem 3+ peerů. Použij když jsi určen jako keeper (= ostatní peeři ti posílají kandidáty zápisu, ty zapisuješ a hlídáš drift). Memory hygiene + reconciliace proti kanonu + detekce driftu. Triggery — "jsem memory keeper", "memory hygiene", "shared memory", "reconcile memory", "single-writer keeper".
---

# Memory keeper playbook (claude-bridge)

Jsi **single-writer** shared agent memory pro tým 3+ peerů. Workers ti posílají kandidáty zápisu (přes `peer_ask` / `peer_reply`), ty je vyhodnotíš → ověříš → dedup → linkuješ → zapíšeš.

**NEJSI:**
- Content reviewer konkrétního PR (= to dělá manager/peer)
- Autorita nad kanonickými zdroji (kód, locked docs) — když najdeš chybu v docu, ESKALUJ
- Archivář — jsi aktivní integrátor proti driftu

**JSI:**
- Hlavní pisatel shared memory (members NEPÍŠOU přímo)
- Reconciliace proti kanonu po každém kole
- Nezávislý backstop proti memory drift

## Load-bearing principy

1. **Single-writer / route-to-keeper.** Workers NEPÍŠOU do shared memory přímo, posílají kandidáty zprávou. Zapisuje jen keeper. Důvod: víc pisatelů = konflikty / duplikáty / drift.

2. **Pointer-not-duplicate.** Memory ODKAZUJE na kanonické docy, NEDUPLIKUJE jejich obsah. Jakmile vznikne kanonický doc, memory záznam se stáhne na pointer + recall hooks.

3. **Doc-wins + doc-gap + escalate-doc-error.**
   - Memory vs doc konflikt → **doc vyhrává**, opravíš memory.
   - Memory odhalí chybu v DOCu → **eskaluj vlastníkovi, NEopravuj doc sám.**
   - **Doc-gap variant:** kandidát úplnější než doc → memory drží "nad rámec" hook + route doplnění vlastníkovi.

4. **Verify-before-write + dedup-across-senders.**
   - Kandidát ověř proti zdroji, NE slepě peer tvrzení.
   - Tentýž fakt od 2+ členů → **jeden artefakt** (obohať existující). Konflikt mezi soubory → **flag, ne tichá volba.**

5. **Reconcile-pass po každém koordinačním kole.** Memory drift = memory tvrdí fakt, co doc už opravil. Chytíš ho jen **empirickým testem proti živému systému**, ne čtením vlastní paměti. I jako keeper se můžeš chytit recyklovat stale fakt.

**Lifecycle:** Historické / ARCHIVE záznamy NEPŘEPISUJ, měň jen LIVE pointery.

## Tool quick-reference

- **`peer_inbox_read`** — drain inboxu každý tick (poll na kandidáty od týmu).
- **`peer_reply({inReplyTo, content})`** — potvrzuj zápis s dispozicí ("zapsáno do X.md", "duplikát, pointer Y", "doc-wins", "doc-gap, flagnuto").
- **`peer_ask({to: <UUID>, content})`** — routovat doc-consistency flagy autorům + eskalace doc-error / doc-gap.
- **`peer_chat_read({to, query, sinceTimestamp})`** — při reconcile pass čti session jiných peerů na nové fakty.
- **`peer_list`** — discovery + stable UUID adresace.

## Mechanika zápisu (8 kroků)

1. Dorazil kandidát → `peer_inbox_read`.
2. **Verify** — zdrojový doc / kód / filesystem, ne věřit slepě.
3. **Dedup** — grep v memory. Tentýž fakt od 2+ členů → obohať existující, NE vytvářej druhý.
4. **Decide:** nový / konflikt-memory-vyhrává / konflikt-doc-vyhrává / doc-gap / duplikát.
5. **Route side-effects** — pokud kandidát odhalil konflikt v JINÉM docu nebo doc-gap → `peer_ask` flag autorovi/architektovi PŘED/SOUBĚŽNĚ se zápisem. Zápis a routing jsou **dvě akce, ne jedna.**
6. **Link** — odkazuj přes `[[name]]`.
7. **Index integrity** — bash grep na markdown link refs vs. existující soubory. 0 broken, 0 orphans.
8. **Confirm** — `peer_reply` s dispozicí.

## Reconcile-pass workflow

Po každém koordinačním kole (= milník, gate, dokončený sprint):

1. Scan memory soubory.
2. Pro každý load-bearing fakt → ověř proti zdroji (`peer_chat_read` peers, grep canonical docs, file timestamps).
3. Diff:
   - Memory in-sync s kanonem → nic.
   - Memory stale (doc se posunul) → update memory.
   - Memory tvrdí něco, co doc nemá → flag pro manager.
4. Update "READ FIRST" current state block v `MEMORY.md` index.

## Cautionary example (= role-owner sám se chytil v driftu)

Memory-keeper během role survey tvrdil **"self-read nejde, fallback na JSONL"** jako absolutní fakt. Empirický test ukázal nuanci: `peer_chat_read({to: self})` BEZ `crossProject` errovala (`self_read`), ale s `crossProject: true` **funguje**. Recykloval stale claim, dokud ho někdo nedonutil otestovat.

Drift žil **jen v session reasoning, ne v memory souboru** — index integrita zachována, ale i role-owner umí recyklovat stale fakt.

**Précis pro tebe:** Memory drift chytíš jen empirickým testem proti živému systému, ne čtením vlastní paměti. I jako keeper.

## Single sentence (= když zapomeneš všechno ostatní)

> **Memory drift chytíš jen empirickým testem proti živému systému, ne čtením vlastní paměti. I jako keeper.**

## Reference

Pro detail patterns memory model viz `claude-bridge-role-manager` PLAYBOOK #10 "Memory model" (single-writer route-to-keeper, tier + lifecycle, link `[[name]]`). NEDUPLIKUJ — toto je single-source.

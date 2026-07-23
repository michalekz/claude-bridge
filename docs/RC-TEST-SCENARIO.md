# v0.10.0-rc.1 — small-team test scenario

Live demo of the control-plane daemon on a **test peer** that is completely separate from the HMH team. No `hmh:*` tmux session is touched.

**Roles**
- **Owner** (Zdeněk) — drives the session, watches `events.jsonl`.
- **Designer** — observes across the thread `control-plane-zadani-2026-07-23`.
- **bridge-dev** (this session) — daemon lives here; monitors from the sidelines, doesn't intervene unless asked.

**Prerequisites**
- `/plugin marketplace update` + `/mcp reconnect` in Owner's session → new bundle with the 7 control-plane tools loaded.
- Daemon 0.10.0-rc.0 running on the host (verified: `control_status alive:true`).
- Terminal 2 tailing `~/.claude-bridge/control/events.jsonl` so Owner sees the audit trail live:
  ```sh
  tail -f ~/.claude-bridge/control/events.jsonl | jq -c '{ts, level, event, requestId, details}'
  ```

## Steps (max 10)

1. **`control_status`** — expect `daemon.running: true`, `state.peerCount: 0`, `hostDriver: "tmux"`.
2. **`team_status verbose:true`** — baseline: `peerCount:0, peers:[]`.
3. **`peer_spawn wait:true, timeoutMs:5000`** with a test peer:
   ```json
   {
     "sessionId": "rc-test-alice",
     "displayName": "rc-test:alice",
     "cwd": "/tmp",
     "command": "/bin/sleep",
     "args": ["300"],
     "wait": true,
     "timeoutMs": 5000
   }
   ```
   Expect `outcome:"ok"` with sessionKey `rc-test:alice` + a pid. Audit event `peer_started` visible in the tail.
4. **`team_status verbose:true`** — one peer, `hostAlive:true`, `status:"live"`, `hostPid` matches. `tmux list-sessions` shows `rc-test:alice`.
5. **`peer_spawn`** the SAME `rc-test-alice` again — **fork-guard demo**. Expect `outcome:"error", code:"session_already_live", details.reason:"state_live"`. Audit event `peer_spawn_rejected` with `reason:"state_live"`.
6. **Pre-write the ack file** (test peer is just `sleep`, so we simulate what a real peer would do):
   ```sh
   mkdir -p ~/.claude-bridge/control/compact-ack
   echo '{"ready":true,"ts":"2026-07-23T..."}' > ~/.claude-bridge/control/compact-ack/rc-test-alice.json
   ```
7. **`peer_compact wait:true, timeoutMs:5000`** — **first live send-keys demo**:
   ```json
   {
     "peer": "rc-test-alice",
     "skipAnchorRequest": true,
     "reason": "rc-test-live-demo",
     "wait": true,
     "timeoutMs": 5000
   }
   ```
   Expect `outcome:"ok"`. Audit trail must show, in order:
   - `peer_compact_inject` with `details.injectedKeys: "[daemon] /compact"` — the charter §8 checkpoint fires BEFORE the send-keys call.
   - `peer_compacted` with the same threadId.
   - The ack file is gone from `compact-ack/` (either moved to `compact-ack/done/` or unlinked).
8. **`team_layout apply:false`** on an inline spec — plan-only preview, no mutation:
   ```json
   {
     "team": "rc-test",
     "apply": false,
     "prune": false,
     "inline": {
       "team": "rc-test",
       "peers": [
         { "sessionId": "rc-test-alice", "displayName": "rc-test:alice", "cwd": "/tmp",
           "command": "/bin/sleep", "args": ["300"], "resume": false }
       ]
     },
     "wait": true
   }
   ```
   Expect `outcome:"ok", mode:"plan"`. `plannedSpawn:[], plannedStop:[], keptExtras:[]` (peer already matches spec, nothing to do).
9. **`peer_stop wait:true, timeoutMs:5000`**:
   ```json
   { "peer": "rc-test-alice", "reason": "rc-test-cleanup", "wait": true, "timeoutMs": 5000 }
   ```
   Expect `outcome:"ok"`. Audit event `peer_stopped`. `tmux list-sessions` shows no `rc-test:alice`.
10. **`team_status`** — `peerCount:0`, matching the baseline from step 2. Test done.

## What we're checking (checklist for Owner)

- [ ] control_status returns fresh heartbeat
- [ ] peer_spawn passes sanitized env (grep spawn env in journal if desired — no `ANTHROPIC_API_KEY` / `CLAUDE_*`)
- [ ] fork-guard fires on duplicate (`session_already_live` + `state_live` reason)
- [ ] send-keys audit checkpoint fires BEFORE the injection (order in events.jsonl matters)
- [ ] Ack file consumption cleanup works
- [ ] team_layout plan mode reports zero-diff correctly
- [ ] peer_stop leaves no zombies (`tmux list-sessions` clean)
- [ ] state.peers empty at the end

## Rollback / safety

- **Not touching `hmh:*` tmux sessions at any point** — test peer name is `rc-test:alice`, explicit isolation.
- If any step throws unexpected error: `peer_stop rc-test-alice force:true` cleans up; if that itself fails, `tmux kill-session -t rc-test:alice` from the shell is the ultimate fallback.
- Daemon lock + state survives a `kill -9` (alpha kill-test — proven). If the daemon needs a hard restart mid-test, `systemctl --user restart claude-bridge-daemon.service` — state.json will rehydrate and the tmux session will be reattached by name.

## Expected duration

~5 minutes end-to-end, most of which is the Owner reading the events.jsonl tail between steps.

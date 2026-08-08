# Setting up the control-plane daemon (v0.10.0+)

The claude-bridge plugin ships with an **opt-in** background service, the *control-plane daemon*, that supervises peer lifecycle (spawn, stop, restart, compact watchdog) and keeps an audit trail. Without it, the plugin behaves exactly like v0.9.4 — nothing changes for users who don't opt in.

Design context: [`docs/architecture.md` ADR-008](architecture.md#adr-008--control-plane-daemon-vedle-file-based-filozofie).

## When to install

- You run multiple Claude Code peers as an autonomous team and want *someone* to notice when one crashes.
- You need every peer restart, compact injection, or spawn attempt to leave an audit trail (`events.jsonl`).
- You want a declarative team spec (`teams/<name>.json`) instead of a `start_peer.sh` script.

## When NOT to install

- You use claude-bridge only for cross-chat messaging in a single-user, single-project setup — the daemon adds no value there.
- You're on native Windows (no WSL2): the tmux driver is the MVP, native `windows-native` driver ships in v0.10.0 F3.

## Prerequisites

- Linux with `systemd --user` (macOS launchd and Windows Task Scheduler in F3).
- `tmux` on `$PATH` — the driver executes `tmux new-session / kill-session / send-keys / has-session / list-sessions / display-message`.
- Node.js 18+ (matches what the plugin bundle requires).
- POSIX single-user boundary — daemon does not span accounts (see ADR-008).

## Installing

The daemon lives in the plugin cache alongside the MCP server bundle. Locate it after installing/updating the plugin:

```sh
# Absolute path — one level below the plugin's src bundle
DAEMON_BIN="$HOME/.claude/plugins/cache/claude-bridge/claude-bridge/<version>/servers/claude-bridge-daemon/dist/daemon.cjs"
node "$DAEMON_BIN" install --systemd
```

The install command:
1. **Copies the daemon bundle to `~/.claude-bridge/bin/claude-bridge-daemon.cjs`** (v0.10.2+), along with the unit template, and writes `bin/deployed-from.json` recording the source path, version and timestamp.
2. Renders `~/.config/systemd/user/claude-bridge-daemon.service` from the template — `ExecStart` points at the Node interpreter that ran the install command, plus **the deployed copy**.
3. Runs `systemctl --user daemon-reload && enable && start`.
4. Verifies the service is up by tailing the acquire-lock event to journal.

### Why the binary is copied (v0.10.2)

Before v0.10.2, `ExecStart` pointed at whatever path the installer was invoked
from. If that was a git working tree — which is how the platform machine ran
it — then **`git checkout` became a silent deploy**: switch branch, restart the
service, and the daemon runs whatever the tree now contains, with nothing
announcing the change and `control_status` reporting a version that no longer
matches the code.

Running from a copy the daemon owns means editing the tree has no effect until
someone deliberately re-installs. To see what is actually running:

```bash
cat ~/.claude-bridge/bin/deployed-from.json
```

`uninstall --systemd` removes the copy as well, so a later
`systemctl --user start` cannot resurrect it.

Check status:

```sh
node "$DAEMON_BIN" status
# → { alive: true, lock: { pid, startedAt, procStart }, heartbeatAgeMs }
systemctl --user status claude-bridge-daemon.service
```

The daemon respects `Restart=always` with a 2 s backoff — a `kill -9` restarts within 3 s and reconstructs its state from `state.json` (verified by the alpha kill-test).

## Runtime layout

```
~/.claude-bridge/control/
├── daemon.lock             # PID lock — single writer
├── state.json              # authoritative state (stateVersion:1, peers dict)
├── events.jsonl            # append-only audit
├── heartbeat               # mtime = alive signal
├── config.json             # operator knobs (compactWatchdog etc.)
├── subscribers.json        # who wants lifecycle events in their inbox
├── requests/               # inbox (MCP tool writes → daemon reads)
│   └── done/               # consumed requests
├── results/                # daemon's replies (poll if you passed wait:true)
├── teams/                  # <team>.json declarative specs
├── compact-ack/            # peer writes here to signal "anchor ready"
│   └── done/               # consumed acks
├── accounts/               # future: peer_login profiles (F3)
└── pending-logins/         # future: offline device-code (F3)
```

The daemon is the **only writer** of `state.json`, `events.jsonl`, `results/`, `requests/done/`, and the entries under `telemetry/`. The MCP tool writes ONLY into `requests/`; operators write into `config.json`, `subscribers.json`, `teams/*.json`, and the GO registry.

## MCP tools (bridge → daemon)

The plugin exposes seven tools that talk to the daemon over file-based RPC:

| Tool | Purpose |
|---|---|
| `control_status` | Read-only health + state summary. |
| `peer_spawn` | Start a peer inside a tmux session with sanitized env. |
| `peer_stop` | Ask the peer to stand down, wait for its ack, then kill the supervised tree and verify no supervisor respawn. `force:true` skips the asking. |
| `peer_restart` | Stop + spawn with carry-over from `state.peers`. |
| `peer_compact` | Orchestrated `/compact` (charter §8 audited path). |
| `team_status` | Read-only view over `state.peers` + host driver. |
| `team_layout` | Declarative reconcile against `teams/<team>.json`. |

All seven return `daemon_not_running` + a `setupPointer` when the service isn't up — same shape as the plugin's `hasLiveData:false`. Fire-and-forget by default; opt in with `wait: true, timeoutMs: N`.

## Configuration

### `~/.claude-bridge/control/config.json`

```json
{
  "compactWatchdog": {
    "enabled": false,
    "warnAtPercent": 0.85,
    "criticalAtPercent": 0.95
  }
}
```

`compactWatchdog.enabled` is **false by default**. Injecting `/compact` via `send-keys` is the most sensitive operation the daemon performs (charter §8 amendment) — you must flip this yourself once you've verified the manual `peer_compact` path works for your team.

### `~/.claude-bridge/control/subscribers.json`

```json
{
  "subscribers": [
    { "peerId": "velitel-uuid", "events": ["peer_crashed"] },
    { "peerId": "keeper-uuid", "events": ["peer_started", "peer_stopped", "peer_compacted"] }
  ]
}
```

For each event listed, the daemon drops a `lifecycle-event` message into that peer's bridge inbox `pending/`. Persistent — survives sleep. Owner-only writable (POSIX permissions); agents can read but not mutate.

### `~/.claude-bridge/control/teams/<team>.json`

```json
{
  "team": "hmh",
  "peers": [
    {
      "sessionId": "keeper-uuid",
      "displayName": "hmh-memory-keeper",
      "cwd": "/opt/hmh",
      "command": "claude",
      "args": [],
      "resume": true,
      "model": null,
      "accountProfile": null,
      "extraAllowEnv": [],
      "extraEnv": {}
    }
  ]
}
```

Reconcile with `team_layout({ team: "hmh", apply: true })`. Add `prune: true` to also stop peers that aren't in the spec. Preview with `apply: false`.

**displayName canonicalization (v0.10.0-rc.2):** `displayName` is used as the tmux session name. Characters outside `[A-Za-z0-9_-]` (notably `:` and `.` — both reserved by tmux target syntax) are silently replaced with `_` when the daemon talks to tmux; the canonical form is returned as `sessionKey` in the spawn response and stored in `state.peers[].tmuxTarget`. `name` keeps the raw string. So `"hmh:node.1"` becomes `hmh_node_1` on the tmux side while still showing as `hmh:node.1` in `team_status`.

## Auditing

Everything the daemon does lands in `events.jsonl` — append-only, `schemaVersion: 1`. Tail it live during operations:

```sh
tail -f ~/.claude-bridge/control/events.jsonl | jq -c '{ts, level, event, requestId}'
```

Fields:

- `ts` — ISO timestamp
- `pid` — daemon process id (useful when tracing across restarts)
- `level` — `info` / `warn` / `error`
- `event` — canonical name (see below)
- `by` — `{ sessionId, name }` of the requester (MCP wire captures this from `ctx.self`)
- `requestId` — matches `requests/<id>.json`
- `details` — event-specific payload

Canonical events:

- Daemon lifecycle: `daemon_started`, `daemon_stopping`, `daemon_stopped`
- Request pipeline: `request_received`, `request_completed`, `request_unknown_tool`, `request_malformed`
- Peer lifecycle: `peer_started`, `peer_stopped`, `peer_restarted`, `peer_stop_rejected`, `peer_stop_failed`, `peer_stop_respawn_detected`, `peer_spawn_rejected`, `peer_spawn_failed`
- Graceful stop (v0.11.15): `peer_stop_requested`, `peer_stop_request_resumed`, `peer_stop_stale_ack_swept`, `stop_ack_timeout`
- Compact: `peer_compact_anchor_requested`, `peer_compact_anchor_timeout`, `peer_compact_inject`, `peer_compacted`, `peer_compact_failed`
- Team layout: `team_layout_reconciling`, `team_layout_applied`

## Uninstalling

```sh
node "$DAEMON_BIN" uninstall --systemd
```

Stops the service, disables it, removes the unit file and the deployed binary
under `~/.claude-bridge/bin/`, then `daemon-reload`s systemd. The runtime data
under `~/.claude-bridge/control/` is **preserved** — audit trail is forever;
you must delete it explicitly if you truly want it gone.

## Rolling forward across plugin updates

Re-run `install --systemd` after every plugin update. Since v0.10.2 the unit no
longer points into the plugin cache, so an upgrade does not break `ExecStart` —
but the deployed copy still holds the **old build** until you re-install. Until
then `control_status` truthfully reports the old version, which is the point:
the running daemon and the reported version cannot drift apart.

A future setup-check hook (v0.10.0 F2) will do this automatically.

## Troubleshooting

`daemon_not_running` from any of the seven MCP tools:
1. Check the lock file: `cat ~/.claude-bridge/control/daemon.lock` — if missing, service is down.
2. `systemctl --user status claude-bridge-daemon.service` — journal will show the last error.
3. Re-run `install --systemd` — the bundled path may point at an outdated plugin cache after an update.

### `stop_ack_timeout` from `peer_stop` (v0.11.15)

**The peer is still running. Nothing was killed.** That is the designed outcome,
not a half-finished operation: `peer_stop` asks the peer to park its work and
flush its anchor, and without that acknowledgement it refuses to end the session.

Three ways forward, in order of preference:

1. **Wait longer, by calling again.** The request stands — a second `peer_stop`
   resumes the SAME request rather than asking twice, and an ack that arrives
   late still counts. This is the normal answer for a peer that is mid-turn.
2. **Look at what the peer is doing** (`peer_context_status`, or the pane). A
   peer in a long generation reaches its inbox only between turns.
3. **`force: true`** — ends the session immediately. Whatever the peer had not
   written down is lost. It skips the WAITING; the dead-pane archive and the
   audit events still happen.

`ackVerdict` in the event says WHY there was no usable ack: `none` (nobody
answered), `wrong_thread` (an ack exists but answers a different stop — another
one is running on this peer), `too_old` (a leftover from an earlier request).

`supervisor_respawn` from `peer_stop`:
- Something outside the daemon is bringing the session back after `kill-session`. Look for `bg-pty-host …/pty/<sessionId>.sock` or similar supervisor processes. Kill them first, then retry `peer_stop`.

`anchor_timeout` from `peer_compact`:
- The peer didn't touch `~/.claude-bridge/control/compact-ack/<sessionId>.json` within the budget. Check the peer's session — did it receive the anchor request in its inbox? Its skill / playbook may need updating.

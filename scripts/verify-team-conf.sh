#!/usr/bin/env bash
# Does a team-sessions.conf still describe the fleet that is actually running?
#
# `team-start.sh` reads two identity fields per line, and both go stale on a
# rename:
#
#   resume_name — matched against the bridge name in the JSONL to find the
#                 session to resume. Stale => the peer comes back under its OLD
#                 identity and the old tmux session is recreated beside the new
#                 one. The same class as a stale `homeSession`, one layer up.
#
#   jmeno       — the tmux window name to create. Stale => the window returns
#                 under its old label, which breaks the short-form half of the
#                 naming convention (window name == the full name minus its team
#                 prefix) even while every peer answers to the right name.
#
# The first version of this script checked only `resume_name`. It then reported
# /opt/hmh as clean while three of its window names were still the pre-rename
# ones — a check claiming success about something it never looked at, which is
# exactly the failure it exists to catch. Found 2026-08-05, minutes after the
# fleet rename, by reading its own output instead of trusting the exit code.
#
# Names are mutable here on purpose: they survive a peer rotation, which a
# pinned session id does not. So this cannot be designed away, only measured.
# Run after any rename, and before any team-start.
set -uo pipefail

status_dir="${HOME}/.claude-bridge/status"
state="${HOME}/.claude-bridge/control/state.json"

declare -A live_window=()
declare -A live_name=()
for f in "$status_dir"/*.json; do
  [ -e "$f" ] || continue
  n=$(jq -r '.name // empty' "$f" 2>/dev/null) || continue
  [ -z "$n" ] && continue
  live_name["$n"]=1
  sid=$(basename "$f" .json)
  tgt=$(jq -r --arg s "$sid" '.peers[$s].tmuxTarget // empty' "$state" 2>/dev/null)
  [ -z "$tgt" ] && continue
  w=$(tmux display-message -p -t "$tgt" '#{window_name}' 2>/dev/null) || continue
  [ -n "$w" ] && live_window["$n"]="$w"
done

rc=0
for conf in "$@"; do
  [ -f "$conf" ] || { echo "?? chybí: $conf"; rc=1; continue; }
  echo "── $conf"
  while IFS='|' read -r win name resume pin flags cwd; do
    case "$win" in ''|\#*) continue ;; esac
    [ -z "${resume:-}" ] && continue
    if [ -z "${live_name[$resume]:-}" ]; then
      printf "   DRIFT %-24s ← žádný živý peer se tak nejmenuje\n" "$resume"
      rc=1
      continue
    fi
    actual="${live_window[$resume]:-}"
    if [ -n "$actual" ] && [ "$actual" != "$name" ]; then
      printf "   DRIFT %-24s okno v conf '%s', ve skutečnosti '%s'\n" "$resume" "$name" "$actual"
      rc=1
    else
      printf "   ok    %-24s okno %s\n" "$resume" "$name"
    fi
  done < "$conf"
done

if [ $rc -eq 0 ]; then
  echo "VŠE SEDÍ — team-start je bezpečný"
else
  echo "!! NESPOUŠTĚT team-start, dokud conf nesedí"
fi
exit $rc

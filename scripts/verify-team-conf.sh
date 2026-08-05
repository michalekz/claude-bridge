#!/usr/bin/env bash
# Does every `resume_name` in a team-sessions.conf still name a live peer?
#
# `team-start.sh` finds a session by matching resume_name against the bridge
# name in the JSONL. A conf naming a peer that no longer answers to it will
# start the peer under its OLD identity and recreate the old tmux session
# beside the new one — the same class as a stale `homeSession`, one layer up.
#
# Names are deliberately mutable here (they survive session rotation, which a
# pinned session id does not), so this cannot be prevented by design — only
# measured. Run it after any rename, and before any team-start.
set -uo pipefail
status_dir="${HOME}/.claude-bridge/status"
live=$(for f in "$status_dir"/*.json; do jq -r '.name // empty' "$f" 2>/dev/null; done | sort -u)
rc=0
for conf in "$@"; do
  [ -f "$conf" ] || { echo "?? chybí: $conf"; rc=1; continue; }
  echo "── $conf"
  while IFS='|' read -r win name resume pin flags cwd; do
    case "$win" in ''|\#*) continue ;; esac
    [ -z "${resume:-}" ] && continue
    if grep -qxF "$resume" <<<"$live"; then
      printf "   ok    %-24s okno %s\n" "$resume" "$name"
    else
      printf "   DRIFT %-24s okno %s  ← žádný živý peer se tak nejmenuje\n" "$resume" "$name"
      rc=1
    fi
  done < "$conf"
done
[ $rc -eq 0 ] && echo "VŠE SEDÍ — team-start je bezpečný" || echo "!! NESPOUŠTĚT team-start, dokud conf nesedí"
exit $rc

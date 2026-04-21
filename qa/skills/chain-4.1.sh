#!/usr/bin/env bash
# chain-4.1 — Fresh install → delete → re-install → 409
set -u
source "$(cd "$(dirname "$0")" && pwd)/qa-lib.sh"

NS="anthropics-skills"
NAME="skill-creator"
SOURCE="anthropics/skills/skill-creator"

# Start from a clean slate for this skill only — delete by skill_id if present
sid=$(skill_id_for "$NS" "$NAME")
if [ -n "$sid" ]; then
  skill_delete "$sid" >/dev/null
  echo "[prep] cleared pre-existing @$NS/$NAME"
fi

step "1. Fresh install → v1"
install_skill "$SOURCE" >/dev/null
expect_version "$NS" "$NAME" 1 "fresh"

step "2. Re-install without delete → 409"
code=$(install_status "$SOURCE")
[ "$code" = "409" ] && pass "re-install returns 409" || fail "got $code"

step "3. Delete → gone"
sid=$(skill_id_for "$NS" "$NAME")
skill_delete "$sid" >/dev/null
got=$(skill_version "$NS" "$NAME")
[ "$got" = "-" ] && pass "deleted" || fail "still v$got after delete"

step "4. Re-install after delete → v1 again"
install_skill "$SOURCE" >/dev/null
expect_version "$NS" "$NAME" 1 "after delete"

# cleanup
sid=$(skill_id_for "$NS" "$NAME")
[ -n "$sid" ] && skill_delete "$sid" >/dev/null

summary

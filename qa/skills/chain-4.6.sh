#!/usr/bin/env bash
# chain-4.6 — Install → stale-hash → check-for-updates sees "update" → pull → bump
set -u
source "$(cd "$(dirname "$0")" && pwd)/qa-lib.sh"

NS="anthropics-skills"
NAME="pdf"
SOURCE="anthropics/skills/pdf"

sid=$(skill_id_for "$NS" "$NAME")
[ -n "$sid" ] && skill_delete "$sid" >/dev/null

step "1. Install"
install_skill "$SOURCE" >/dev/null
expect_version "$NS" "$NAME" 1 "install"

step "2. Corrupt source-hash to force 'update available'"
# Stop daemon so sqlite handle is released, patch DB, restart.
deno task atlas daemon stop --force >/dev/null 2>&1 || true
sqlite3 "$SKILLS_DB" "UPDATE skills SET frontmatter=json_set(frontmatter,'\$.\"source-hash\"','STALE') WHERE namespace='$NS' AND name='$NAME';"
deno task atlas daemon start --detached >/dev/null 2>&1 &
# wait for daemon
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  curl -s http://localhost:8080/health -o /dev/null -w '%{http_code}' 2>/dev/null | grep -q 200 && break
  sleep 1
done

step "3. check-update sees update"
resp=$(curl -s "$API/skills/@$NS/$NAME/check-update")
has_update=$(echo "$resp" | jq -r '.hasUpdate')
[ "$has_update" = "true" ] && pass "hasUpdate=true" || fail "hasUpdate=$has_update"

step "4. Pull update → v2"
curl -s -X POST "$API/skills/@$NS/$NAME/update" >/dev/null
expect_version "$NS" "$NAME" 2 "after update"

step "5. check-update idempotent — no further update"
resp=$(curl -s "$API/skills/@$NS/$NAME/check-update")
has_update=$(echo "$resp" | jq -r '.hasUpdate')
[ "$has_update" = "false" ] && pass "idempotent" || fail "expected false, got $has_update"

# cleanup
sid=$(skill_id_for "$NS" "$NAME")
[ -n "$sid" ] && skill_delete "$sid" >/dev/null

summary

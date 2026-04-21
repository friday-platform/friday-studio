#!/usr/bin/env bash
# chain-4.5 — Install → check-for-updates → no change
set -u
source "$(cd "$(dirname "$0")" && pwd)/qa-lib.sh"

NS="anthropics-skills"
NAME="pdf"
SOURCE="anthropics/skills/pdf"

# ensure clean slate
sid=$(skill_id_for "$NS" "$NAME")
[ -n "$sid" ] && skill_delete "$sid" >/dev/null

step "1. Install"
install_skill "$SOURCE" >/dev/null
expect_version "$NS" "$NAME" 1 "install"

step "2. Check for updates — expect no change"
resp=$(curl -s "$API/skills/@$NS/$NAME/check-update")
has_update=$(echo "$resp" | jq -r '.hasUpdate')
[ "$has_update" = "false" ] && pass "hasUpdate=false" || fail "hasUpdate=$has_update"

local_hash=$(echo "$resp" | jq -r '.localHash')
remote_hash=$(echo "$resp" | jq -r '.remote.hash')
[ "$local_hash" = "$remote_hash" ] && pass "hashes match" || fail "hash drift: local=$local_hash remote=$remote_hash"

step "3. Version unchanged"
expect_version "$NS" "$NAME" 1 "post-check"

# cleanup
sid=$(skill_id_for "$NS" "$NAME")
[ -n "$sid" ] && skill_delete "$sid" >/dev/null

summary

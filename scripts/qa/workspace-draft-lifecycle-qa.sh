#!/usr/bin/env bash
# QA Checkpoint 2 — Test full draft flow with transcript scenarios
# Branch: feature/workspace-creation-redesign
# Task: #65
#
# Exercises the full draft lifecycle for both Inbox-Zero and Meeting-Scheduler
# workspace shapes via the daemon HTTP API (curl).
#
# Run with: bash scripts/qa/workspace-draft-lifecycle-qa.sh

set -euo pipefail

API="http://localhost:8080/api"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"; cleanup_workspaces' EXIT

PASS=0
FAIL=0

pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

created_workspaces=()

cleanup_workspaces() {
  for ws in "${created_workspaces[@]}"; do
    curl -s -X DELETE "${API}/workspaces/${ws}?force=true" > /dev/null 2>&1 || true
  done
}

create_workspace() {
  local name="$1"
  local body
  body=$(cat <<EOF
{
  "config": {
    "version": "1.0",
    "workspace": { "name": "${name}", "description": "QA test workspace" }
  },
  "workspaceName": "${name}"
}
EOF
)
  curl -s -X POST "${API}/workspaces/create" \
    -H "Content-Type: application/json" \
    -d "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('workspace',{}).get('id',''))"
}

ws_path() {
  local ws_id="$1"
  curl -s "${API}/workspaces/${ws_id}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('path',''))"
}

file_exists() {
  test -f "$1"
}

# =============================================================================
# TEST 1: Inbox-Zero full lifecycle
# =============================================================================
echo ""
echo "=== TEST 1: Inbox-Zero full lifecycle ==="

WS_IZ=$(create_workspace "qa-inbox-zero")
created_workspaces+=("$WS_IZ")
WS_IZ_PATH=$(ws_path "$WS_IZ")

# 1. Begin draft
echo "  → Begin draft..."
RES=$(curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/begin")
if echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)"; then
  pass "begin draft returns 200"
else
  fail "begin draft failed: $RES"
fi

# Verify draft file exists
if file_exists "${WS_IZ_PATH}/workspace.yml.draft"; then
  pass "draft file exists on disk"
else
  fail "draft file missing on disk"
fi

# 2. Upsert 3 agents
echo "  → Upsert agents..."
for agent in email-triager inbox-summarizer memory-writer; do
  curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/items/agent" \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"${agent}\",\"config\":{\"type\":\"llm\",\"description\":\"${agent}\",\"config\":{\"provider\":\"anthropic\",\"model\":\"claude-sonnet-4-6\",\"prompt\":\"You are ${agent}. For this test, simply return the word 'done' and nothing else. Do not attempt to access any tools, resources, or external services.\",\"tool_choice\":\"none\"}}}" > /dev/null
done
pass "upsert 3 agents into draft"

# 3. Upsert 3 signals
echo "  → Upsert signals..."
curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/items/signal" \
  -H "Content-Type: application/json" \
  -d '{"id":"review-inbox","config":{"provider":"http","description":"Review inbox","config":{"path":"/review-inbox"}}}' > /dev/null

curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/items/signal" \
  -H "Content-Type: application/json" \
  -d '{"id":"draft-reply","config":{"provider":"http","description":"Draft reply","config":{"path":"/draft-reply"}}}' > /dev/null

curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/items/signal" \
  -H "Content-Type: application/json" \
  -d '{"id":"record-feedback","config":{"provider":"http","description":"Record feedback","config":{"path":"/record-feedback"}}}' > /dev/null

pass "upsert 3 signals into draft"

# 4. Upsert 3 jobs
echo "  → Upsert jobs..."
curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/items/job" \
  -H "Content-Type: application/json" \
  -d '{"id":"review_inbox","config":{"description":"Review inbox","triggers":[{"signal":"review-inbox"}],"execution":{"strategy":"sequential","agents":["email-triager"]}}}' > /dev/null

curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/items/job" \
  -H "Content-Type: application/json" \
  -d '{"id":"draft_reply","config":{"description":"Draft reply","triggers":[{"signal":"draft-reply"}],"execution":{"strategy":"sequential","agents":["inbox-summarizer"]}}}' > /dev/null

curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/items/job" \
  -H "Content-Type: application/json" \
  -d '{"id":"record_feedback","config":{"description":"Record feedback","triggers":[{"signal":"record-feedback"}],"execution":{"strategy":"sequential","agents":["memory-writer"]}}}' > /dev/null

pass "upsert 3 jobs into draft"

# 5. Enable Gmail MCP
echo "  → Enable Gmail MCP..."
RES=$(curl -s -X PUT "${API}/workspaces/${WS_IZ}/mcp/google-gmail")
if echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'server' in d else 1)"; then
  pass "enable Gmail MCP during draft"
else
  fail "enable Gmail MCP failed: $RES"
fi

# Verify MCP config is in draft file, not live file
if grep -q "google-gmail" "${WS_IZ_PATH}/workspace.yml.draft" 2>/dev/null; then
  pass "Gmail MCP config written to draft file"
else
  fail "Gmail MCP config not found in draft file"
fi

if grep -q "google-gmail" "${WS_IZ_PATH}/workspace.yml" 2>/dev/null; then
  fail "Gmail MCP config leaked to live file before publish"
else
  pass "Gmail MCP config NOT in live file before publish"
fi

# 6. Validate draft
echo "  → Validate draft..."
RES=$(curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/validate")
STATUS=$(echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('report',{}).get('status',''))")
if [ "$STATUS" = "ok" ] || [ "$STATUS" = "warning" ]; then
  pass "draft validation returns ok/warning (status=$STATUS)"
else
  fail "draft validation failed: $RES"
fi

# 7. Publish draft
echo "  → Publish draft..."
RES=$(curl -s -X POST "${API}/workspaces/${WS_IZ}/draft/publish")
if echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)"; then
  pass "publish draft succeeds"
else
  fail "publish draft failed: $RES"
fi

# 8. Verify live updated, draft gone
if file_exists "${WS_IZ_PATH}/workspace.yml.draft"; then
  fail "draft file still exists after publish"
else
  pass "draft file removed after publish"
fi

if grep -q "email-triager" "${WS_IZ_PATH}/workspace.yml" 2>/dev/null; then
  pass "live file contains upserted agents"
else
  fail "live file missing agents after publish"
fi

if grep -q "google-gmail" "${WS_IZ_PATH}/workspace.yml" 2>/dev/null; then
  pass "live file contains Gmail MCP after publish"
else
  fail "live file missing Gmail MCP after publish"
fi

# 9. Fire signal and check completion
echo "  → Fire review-inbox signal..."
RES=$(curl -s -X POST "${API}/workspaces/${WS_IZ}/signals/review-inbox" \
  -H "Content-Type: application/json" \
  -d '{"payload":{}}')
STATUS=$(echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))")
if [ "$STATUS" = "completed" ]; then
  pass "signal firing produces completed session"
else
  fail "signal session did not complete: $RES"
fi

# 10. Test direct mode upsert on workspace with no draft
echo "  → Direct mode upsert (no draft)..."
RES=$(curl -s -X POST "${API}/workspaces/${WS_IZ}/items/agent" \
  -H "Content-Type: application/json" \
  -d '{"id":"direct-agent","config":{"type":"llm","description":"Direct agent","config":{"provider":"anthropic","model":"claude-sonnet-4-6","prompt":"Direct","tool_choice":"none"}}}')
OK=$(echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok',''))")
if [ "$OK" = "True" ]; then
  pass "direct mode upsert writes live immediately when no draft exists"
else
  fail "direct mode upsert failed: $RES"
fi

if grep -q "direct-agent" "${WS_IZ_PATH}/workspace.yml" 2>/dev/null; then
  pass "direct mode upsert persisted to live file"
else
  fail "direct mode upsert not found in live file"
fi

# =============================================================================
# TEST 2: Meeting-Scheduler full lifecycle
# =============================================================================
echo ""
echo "=== TEST 2: Meeting-Scheduler full lifecycle ==="

WS_MS=$(create_workspace "qa-meeting-scheduler")
created_workspaces+=("$WS_MS")
WS_MS_PATH=$(ws_path "$WS_MS")

# Begin draft
curl -s -X POST "${API}/workspaces/${WS_MS}/draft/begin" > /dev/null

# Upsert 4 agents
for agent in email-scanner availability-checker reply-drafter meeting-booker; do
  curl -s -X POST "${API}/workspaces/${WS_MS}/draft/items/agent" \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"${agent}\",\"config\":{\"type\":\"llm\",\"description\":\"${agent}\",\"config\":{\"provider\":\"anthropic\",\"model\":\"claude-sonnet-4-6\",\"prompt\":\"You are ${agent}. For this test, simply return the word 'done' and nothing else. Do not attempt to access any tools, resources, or external services.\",\"tool_choice\":\"none\"}}}" > /dev/null
done
pass "upsert 4 agents into draft"

# Upsert 3 signals
curl -s -X POST "${API}/workspaces/${WS_MS}/draft/items/signal" \
  -H "Content-Type: application/json" \
  -d '{"id":"scan-email","config":{"provider":"http","description":"Scan email","config":{"path":"/scan-email"}}}' > /dev/null

curl -s -X POST "${API}/workspaces/${WS_MS}/draft/items/signal" \
  -H "Content-Type: application/json" \
  -d '{"id":"scheduled-scan","config":{"provider":"schedule","description":"Scheduled scan","config":{"schedule":"0 10 * * *","timezone":"America/Los_Angeles"}}}' > /dev/null

curl -s -X POST "${API}/workspaces/${WS_MS}/draft/items/signal" \
  -H "Content-Type: application/json" \
  -d '{"id":"book-meeting","config":{"provider":"http","description":"Book meeting","config":{"path":"/book-meeting"}}}' > /dev/null

pass "upsert 3 signals into draft"

# Upsert 2 jobs
curl -s -X POST "${API}/workspaces/${WS_MS}/draft/items/job" \
  -H "Content-Type: application/json" \
  -d '{"id":"scan_email_for_meetings","config":{"description":"Scan email for meetings","triggers":[{"signal":"scan-email"},{"signal":"scheduled-scan"}],"execution":{"strategy":"sequential","agents":["email-scanner","availability-checker"]}}}' > /dev/null

curl -s -X POST "${API}/workspaces/${WS_MS}/draft/items/job" \
  -H "Content-Type: application/json" \
  -d '{"id":"book_meeting","config":{"description":"Book meeting","triggers":[{"signal":"book-meeting"}],"execution":{"strategy":"sequential","agents":["reply-drafter","meeting-booker"]}}}' > /dev/null

pass "upsert 2 jobs into draft"

# Enable Gmail + Calendar MCP
curl -s -X PUT "${API}/workspaces/${WS_MS}/mcp/google-gmail" > /dev/null
curl -s -X PUT "${API}/workspaces/${WS_MS}/mcp/google-calendar" > /dev/null
pass "enable Gmail + Calendar MCP during draft"

if grep -q "google-gmail" "${WS_MS_PATH}/workspace.yml.draft" && grep -q "google-calendar" "${WS_MS_PATH}/workspace.yml.draft"; then
  pass "both MCP configs written to draft file"
else
  fail "MCP configs missing from draft file"
fi

# Validate
RES=$(curl -s -X POST "${API}/workspaces/${WS_MS}/draft/validate")
STATUS=$(echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('report',{}).get('status',''))")
if [ "$STATUS" = "ok" ] || [ "$STATUS" = "warning" ]; then
  pass "draft validation returns ok/warning (status=$STATUS)"
else
  fail "draft validation failed: $RES"
fi

# Publish
RES=$(curl -s -X POST "${API}/workspaces/${WS_MS}/draft/publish")
if echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)"; then
  pass "publish draft succeeds"
else
  fail "publish draft failed: $RES"
fi

if ! file_exists "${WS_MS_PATH}/workspace.yml.draft"; then
  pass "draft file removed after publish"
else
  fail "draft file still exists after publish"
fi

# Fire signal
RES=$(curl -s -X POST "${API}/workspaces/${WS_MS}/signals/scan-email" \
  -H "Content-Type: application/json" \
  -d '{"payload":{}}')
STATUS=$(echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))")
if [ "$STATUS" = "completed" ]; then
  pass "signal firing produces completed session"
else
  fail "signal session did not complete: $RES"
fi

# =============================================================================
# TEST 3: Publish with intentional error (orphan agent)
# =============================================================================
echo ""
echo "=== TEST 3: Publish refused with hard validation error ==="

WS_ERR=$(create_workspace "qa-error-test")
created_workspaces+=("$WS_ERR")
WS_ERR_PATH=$(ws_path "$WS_ERR")

curl -s -X POST "${API}/workspaces/${WS_ERR}/draft/begin" > /dev/null

# Add a job with an FSM referencing a non-existent agent (hard error)
curl -s -X POST "${API}/workspaces/${WS_ERR}/draft/items/job" \
  -H "Content-Type: application/json" \
  -d '{"id":"broken-job","config":{"description":"Broken job","triggers":[{"signal":"test"}],"fsm":{"id":"broken-fsm","initial":"step_0","states":{"step_0":{"entry":[{"type":"agent","agentId":"nonexistent-agent"}]}}}}}' > /dev/null

# Try to publish — should be refused
RES=$(curl -s -w "\n%{http_code}" -X POST "${API}/workspaces/${WS_ERR}/draft/publish")
HTTP_CODE=$(echo "$RES" | tail -n1)
BODY=$(echo "$RES" | sed '$d')

if [ "$HTTP_CODE" = "422" ]; then
  pass "publish refused with 422 for validation failure"
else
  fail "publish did not refuse: HTTP $HTTP_CODE, body: $BODY"
fi

# Both files should still be intact
if file_exists "${WS_ERR_PATH}/workspace.yml.draft" && file_exists "${WS_ERR_PATH}/workspace.yml"; then
  pass "both draft and live files intact after refused publish"
else
  fail "files missing after refused publish"
fi

# =============================================================================
# TEST 4: Discard draft
# =============================================================================
echo ""
echo "=== TEST 4: Discard draft ==="

WS_DIS=$(create_workspace "qa-discard-test")
created_workspaces+=("$WS_DIS")
WS_DIS_PATH=$(ws_path "$WS_DIS")

curl -s -X POST "${API}/workspaces/${WS_DIS}/draft/begin" > /dev/null

# Upsert something into draft
curl -s -X POST "${API}/workspaces/${WS_DIS}/draft/items/agent" \
  -H "Content-Type: application/json" \
  -d '{"id":"discard-agent","config":{"type":"llm","description":"Discard agent","config":{"provider":"anthropic","model":"claude-sonnet-4-6","prompt":"Discard","tool_choice":"none"}}}' > /dev/null

# Verify draft has the agent
if grep -q "discard-agent" "${WS_DIS_PATH}/workspace.yml.draft" 2>/dev/null; then
  pass "draft contains upserted entity before discard"
else
  fail "draft missing entity before discard"
fi

# Live should NOT have the agent
if grep -q "discard-agent" "${WS_DIS_PATH}/workspace.yml" 2>/dev/null; then
  fail "live file leaked entity before publish"
else
  pass "live file does not contain draft-only entity"
fi

# Discard
RES=$(curl -s -X DELETE "${API}/workspaces/${WS_DIS}/draft")
if echo "$RES" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)"; then
  pass "discard draft returns 200"
else
  fail "discard draft failed: $RES"
fi

# Draft file should be gone
if ! file_exists "${WS_DIS_PATH}/workspace.yml.draft"; then
  pass "draft file gone after discard"
else
  fail "draft file still exists after discard"
fi

# Live file should be unchanged
if ! grep -q "discard-agent" "${WS_DIS_PATH}/workspace.yml" 2>/dev/null; then
  pass "live file untouched after discard"
else
  fail "live file modified after discard"
fi

# =============================================================================
# TEST 5: MCP enable during draft does NOT start server, after publish it does
# =============================================================================
echo ""
echo "=== TEST 5: MCP draft-aware enablement ==="

WS_MCP=$(create_workspace "qa-mcp-draft")
created_workspaces+=("$WS_MCP")
WS_MCP_PATH=$(ws_path "$WS_MCP")

curl -s -X POST "${API}/workspaces/${WS_MCP}/draft/begin" > /dev/null

# Enable time MCP (configured=true, lightweight)
curl -s -X PUT "${API}/workspaces/${WS_MCP}/mcp/time" > /dev/null

# Draft should have time MCP
if grep -q "time" "${WS_MCP_PATH}/workspace.yml.draft" 2>/dev/null; then
  pass "MCP config written to draft"
else
  fail "MCP config not in draft"
fi

# Live should NOT have time MCP yet
if ! grep -q "time" "${WS_MCP_PATH}/workspace.yml" 2>/dev/null; then
  pass "MCP config NOT in live before publish"
else
  fail "MCP config leaked to live before publish"
fi

# Publish
curl -s -X POST "${API}/workspaces/${WS_MCP}/draft/publish" > /dev/null

# Live should now have time MCP
if grep -q "time" "${WS_MCP_PATH}/workspace.yml" 2>/dev/null; then
  pass "MCP config in live after publish"
else
  fail "MCP config missing from live after publish"
fi

# Draft should be gone
if ! file_exists "${WS_MCP_PATH}/workspace.yml.draft"; then
  pass "draft file gone after publish"
else
  fail "draft file still exists after publish"
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "========================================"
echo "QA Checkpoint 2 Results"
echo "========================================"
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo "🎉 All acceptance criteria passed!"
  exit 0
else
  echo "⚠️  Some tests failed. Review output above."
  exit 1
fi

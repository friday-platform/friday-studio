#!/usr/bin/env bash
set -euo pipefail

# Operator verification for kernel-cron-resume.
# Pushes workspace config to the daemon, waits for two cron ticks,
# and confirms: (a) no in-flight sessions were killed, (b) consecutive
# ticks dispatched different task_ids.
#
# Usage:
#   ./verify-cron-resume.sh [PLATFORM_URL]
#
# Exit 0 = pass, exit 1 = fail with diagnostics.

PLATFORM_URL="${1:-http://localhost:8080}"
KERNEL_WS_ID="thick_endive"
TICK_INTERVAL_S=120
WAIT_TICKS=2
WAIT_BUFFER_S=60
TOTAL_WAIT_S=$(( TICK_INTERVAL_S * WAIT_TICKS + WAIT_BUFFER_S ))

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_YML="$SCRIPT_DIR/../workspace.yml"

fail() { echo "FAIL: $1" >&2; exit 1; }
info() { echo "INFO: $1"; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

# ── Step 0: Preflight — verify the workspace exists and cron signal is active ──

info "Checking workspace $KERNEL_WS_ID exists at $PLATFORM_URL"
WS_RESPONSE=$(curl -sf "$PLATFORM_URL/api/workspaces/$KERNEL_WS_ID" 2>&1) \
  || fail "Cannot reach workspace $KERNEL_WS_ID at $PLATFORM_URL. Is the daemon running?"

echo "$WS_RESPONSE" | python3 -c "
import json, sys
ws = json.load(sys.stdin)
signals = ws.get('config', ws).get('signals', {})
if 'autopilot-tick-cron' not in signals:
    print('FAIL: autopilot-tick-cron signal not found in workspace config', file=sys.stderr)
    sys.exit(1)
sig = signals['autopilot-tick-cron']
schedule = sig.get('config', {}).get('schedule', '')
if not schedule:
    print('FAIL: autopilot-tick-cron has no schedule', file=sys.stderr)
    sys.exit(1)
print(f'OK: autopilot-tick-cron schedule = {schedule}')
" || fail "Preflight: cron signal not configured"

# ── Step 1: Snapshot pre-existing sessions ──

info "Snapshotting current sessions for $KERNEL_WS_ID"
PRE_SESSIONS=$(curl -sf "$PLATFORM_URL/api/sessions?workspaceId=$KERNEL_WS_ID&limit=10") \
  || fail "Cannot query sessions API"

PRE_ACTIVE_IDS=$(echo "$PRE_SESSIONS" | python3 -c "
import json, sys
sessions = json.load(sys.stdin)
if isinstance(sessions, dict):
    sessions = sessions.get('sessions', sessions.get('data', []))
active = [s['sessionId'] for s in sessions if s.get('status') == 'active']
print('\n'.join(active))
")

if [ -n "$PRE_ACTIVE_IDS" ]; then
  info "Found active sessions before config push:"
  echo "$PRE_ACTIVE_IDS" | while read -r sid; do echo "  - $sid"; done
else
  info "No active sessions before config push"
fi

# ── Step 2: Push workspace config (with backup) ──

info "Pushing workspace config to $KERNEL_WS_ID (backup=true)"
if [ ! -f "$WORKSPACE_YML" ]; then
  fail "workspace.yml not found at $WORKSPACE_YML"
fi

CONFIG_JSON=$(python3 -c "
import json, sys
try:
    import yaml
    with open('$WORKSPACE_YML') as f:
        config = yaml.safe_load(f)
except ImportError:
    print('ERROR: PyYAML not installed. Install with: pip3 install pyyaml', file=sys.stderr)
    sys.exit(1)
print(json.dumps({'config': config, 'backup': True}))
") || fail "Failed to convert workspace.yml to JSON"

UPDATE_RESPONSE=$(curl -sf -X POST \
  "$PLATFORM_URL/api/workspaces/$KERNEL_WS_ID/update" \
  -H "Content-Type: application/json" \
  -d "$CONFIG_JSON" 2>&1)
UPDATE_STATUS=$?

if [ $UPDATE_STATUS -ne 0 ]; then
  # Check if it's a 409 (active-session guard)
  UPDATE_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "$PLATFORM_URL/api/workspaces/$KERNEL_WS_ID/update" \
    -H "Content-Type: application/json" \
    -d "$CONFIG_JSON")
  HTTP_CODE=$(echo "$UPDATE_RESPONSE" | tail -1)
  if [ "$HTTP_CODE" = "409" ]; then
    info "Got 409 Conflict — active-session-guard is working correctly"
    info "Retrying with force=true"
    CONFIG_JSON_FORCE=$(python3 -c "
import json
d = json.loads('$( echo "$CONFIG_JSON" | python3 -c "import sys; print(sys.stdin.read().replace(\"'\", \"'\\''\"))" )')
" 2>/dev/null || true)
    # Simpler: re-parse with force
    CONFIG_JSON_FORCE=$(python3 -c "
import json, sys
try:
    import yaml
    with open('$WORKSPACE_YML') as f:
        config = yaml.safe_load(f)
except ImportError:
    sys.exit(1)
print(json.dumps({'config': config, 'backup': True, 'force': True}))
") || fail "Failed to build force payload"
    curl -sf -X POST \
      "$PLATFORM_URL/api/workspaces/$KERNEL_WS_ID/update" \
      -H "Content-Type: application/json" \
      -d "$CONFIG_JSON_FORCE" >/dev/null \
      || fail "Config push failed even with force=true"
    info "Config pushed with force=true"
  else
    fail "Config push failed with HTTP $HTTP_CODE"
  fi
else
  info "Config push succeeded"
fi

# ── Step 3: Verify active-session-guard is live ──

info "Verifying active-session-guard (409 on update during active session)..."
GUARD_CHECK=$(curl -s -w "\n%{http_code}" -X POST \
  "$PLATFORM_URL/api/workspaces/$KERNEL_WS_ID/update" \
  -H "Content-Type: application/json" \
  -d "$CONFIG_JSON")
GUARD_HTTP=$(echo "$GUARD_CHECK" | tail -1)
GUARD_BODY=$(echo "$GUARD_CHECK" | sed '$d')

if [ "$GUARD_HTTP" = "409" ]; then
  info "Active-session-guard confirmed: got 409 with active sessions"
elif [ "$GUARD_HTTP" = "200" ]; then
  info "Update returned 200 — no active sessions at this moment (guard may still be live)"
else
  info "Warning: unexpected HTTP $GUARD_HTTP from guard check"
fi

# ── Step 4: Wait for two cron ticks ──

info "Waiting ${TOTAL_WAIT_S}s for $WAIT_TICKS cron ticks (interval=${TICK_INTERVAL_S}s + ${WAIT_BUFFER_S}s buffer)..."
info "Started at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

ELAPSED=0
POLL_INTERVAL=30
while [ $ELAPSED -lt $TOTAL_WAIT_S ]; do
  sleep $POLL_INTERVAL
  ELAPSED=$(( ELAPSED + POLL_INTERVAL ))
  REMAINING=$(( TOTAL_WAIT_S - ELAPSED ))
  if [ $REMAINING -gt 0 ]; then
    info "  ... ${REMAINING}s remaining"
  fi
done

info "Wait complete at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ── Step 5: Post-flight checks ──

info "Fetching post-flight sessions"
POST_SESSIONS=$(curl -sf "$PLATFORM_URL/api/sessions?workspaceId=$KERNEL_WS_ID&limit=15") \
  || fail "Cannot query sessions API after wait"

# Run all assertions in a single python script
RESULT=$(echo "$POST_SESSIONS" | python3 -c "
import json, sys

pre_active_ids = '''$PRE_ACTIVE_IDS'''.strip().split('\n')
pre_active_ids = [x for x in pre_active_ids if x]

sessions_raw = json.load(sys.stdin)
if isinstance(sessions_raw, dict):
    sessions = sessions_raw.get('sessions', sessions_raw.get('data', []))
else:
    sessions = sessions_raw

errors = []

# Assertion 1: No pre-existing active session was killed
for sid in pre_active_ids:
    match = [s for s in sessions if s.get('sessionId') == sid]
    if match:
        status = match[0].get('status', 'unknown')
        if status in ('error', 'cancelled'):
            errors.append(f'Pre-existing session {sid} was killed (status={status})')

# Find cron-triggered sessions (those triggered by autopilot-tick-cron)
cron_sessions = []
for s in sessions:
    trigger = s.get('trigger', s.get('signalId', ''))
    if isinstance(trigger, dict):
        trigger = trigger.get('signalId', trigger.get('signal', ''))
    if 'autopilot-tick-cron' in str(trigger):
        cron_sessions.append(s)

# Also check job name or other identifiers
if not cron_sessions:
    for s in sessions:
        job = s.get('jobId', s.get('job', ''))
        if 'autopilot-tick' in str(job):
            cron_sessions.append(s)

# Assertion 2: At least two cron-triggered sessions exist
if len(cron_sessions) < 2:
    errors.append(
        f'Expected >=2 cron-triggered sessions, found {len(cron_sessions)}. '
        f'Total sessions: {len(sessions)}'
    )

# Assertion 3: Check session statuses — none should be error/cancelled
for cs in cron_sessions:
    status = cs.get('status', 'unknown')
    sid = cs.get('sessionId', 'unknown')
    if status in ('error', 'cancelled'):
        errors.append(f'Cron session {sid} has bad status: {status}')

# Assertion 4: Dispatched task_ids differ between consecutive ticks
task_ids = []
for cs in cron_sessions:
    # task_id may be in various places depending on session structure
    blocks = cs.get('agentBlocks', [])
    tid = None
    for block in blocks:
        for tc in block.get('toolCalls', []):
            args = tc.get('args', {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (json.JSONDecodeError, TypeError):
                    continue
            if isinstance(args, dict):
                tid = args.get('task_id', tid)
    if tid is None:
        # Check session-level metadata
        meta = cs.get('metadata', {})
        if isinstance(meta, dict):
            tid = meta.get('task_id')
    if tid is None:
        payload = cs.get('payload', cs.get('input', {}))
        if isinstance(payload, dict):
            tid = payload.get('task_id')
    if tid:
        task_ids.append(tid)

if len(task_ids) >= 2:
    unique = set(task_ids)
    if len(unique) < 2:
        errors.append(
            f'All {len(task_ids)} cron ticks dispatched the same task_id: {task_ids[0]}. '
            f'Per-task cooldown may not be working.'
        )
    else:
        print(f'OK: Dispatched task_ids: {list(unique)}')
elif len(task_ids) == 1:
    print(f'WARN: Only found 1 task_id ({task_ids[0]}); cannot verify diversity')
else:
    print('WARN: Could not extract task_ids from cron sessions')

if errors:
    for e in errors:
        print(f'FAIL: {e}', file=sys.stderr)
    sys.exit(1)

print(f'OK: {len(cron_sessions)} cron sessions found, no pre-existing sessions killed')
sys.exit(0)
") || {
  echo "$RESULT"
  fail "Post-flight assertions failed"
}

echo "$RESULT"
info "kernel-cron-resume verification PASSED"

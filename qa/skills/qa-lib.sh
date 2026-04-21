#!/usr/bin/env bash
# qa/skills/qa-lib.sh — shared helpers for skills QA scripts.
# Source this at the top of any chain/regression script.
#
# Requires: curl, jq, sqlite3, agent-browser
# Assumes: daemon on :8080, playground on :5200, agent-browser session "atlas-qa"

set -o pipefail

API="http://localhost:8080/api"
UI="http://localhost:5200"
SESSION="atlas-qa"
SKILLS_DB="${HOME}/.atlas/skills.db"
SNAPSHOT="/tmp/skills.db.snapshot.$$"

PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); FAILURES+=("$1"); echo "  ✗ $1" >&2; }
step() { echo ""; echo "── $1"; }

summary() {
  echo ""
  echo "========================================"
  echo "  PASS: $PASS    FAIL: $FAIL"
  echo "========================================"
  if [ "$FAIL" -gt 0 ]; then
    echo "Failures:"
    for f in "${FAILURES[@]}"; do echo "  - $f"; done
    exit 1
  fi
}

# ─── DB snapshot / restore ─────────────────────────────────────────

qa_snapshot() {
  [ -f "$SKILLS_DB" ] || { echo "no skills.db at $SKILLS_DB" >&2; return 1; }
  cp "$SKILLS_DB" "$SNAPSHOT"
  local n
  n=$(sqlite3 "$SKILLS_DB" 'SELECT COUNT(*) FROM skills' 2>/dev/null || echo "?")
  echo "[snap] $n skill rows saved → $SNAPSHOT"
}

qa_restore() {
  [ -f "$SNAPSHOT" ] || return 0
  echo "[restore] stopping daemon to drop sqlite handle…"
  deno task atlas daemon stop --force >/dev/null 2>&1 || true
  cp "$SNAPSHOT" "$SKILLS_DB"
  deno task atlas daemon start --detached >/dev/null 2>&1 &
  # wait for daemon to come back up
  local tries=30
  while [ $tries -gt 0 ]; do
    if curl -s "$API/../health" -o /dev/null -w '%{http_code}' | grep -q 200; then
      echo "[restore] daemon back up"
      rm -f "$SNAPSHOT"
      return 0
    fi
    sleep 1
    tries=$((tries - 1))
  done
  echo "[restore] daemon failed to restart in time!" >&2
  return 1
}

# ─── Skill primitives ──────────────────────────────────────────────

# install_skill <source> [workspaceId] → emits JSON to stdout
install_skill() {
  local body
  if [ -n "${2:-}" ]; then
    body=$(printf '{"source":"%s","workspaceId":"%s"}' "$1" "$2")
  else
    body=$(printf '{"source":"%s"}' "$1")
  fi
  curl -s -X POST "$API/skills/install" -H "Content-Type: application/json" -d "$body"
}

# install_status <source> → HTTP status only
install_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$API/skills/install" \
    -H "Content-Type: application/json" -d "$(printf '{"source":"%s"}' "$1")"
}

# skill_get <namespace> <name> → emits JSON
skill_get() { curl -s "$API/skills/@$1/$2"; }

# skill_version <namespace> <name> → prints current version (or '-' if missing)
skill_version() {
  local v
  v=$(skill_get "$1" "$2" | jq -r '.skill.version // "-"' 2>/dev/null)
  echo "$v"
}

# expect_version <ns> <name> <version> <label>
expect_version() {
  local got
  got=$(skill_version "$1" "$2")
  if [ "$got" = "$3" ]; then
    pass "$4: @$1/$2 is v$3"
  else
    fail "$4: @$1/$2 expected v$3 got v$got"
  fi
}

# skill_delete <skillId>
skill_delete() {
  curl -s -X DELETE "$API/skills/$1" -o /dev/null -w '%{http_code}'
}

# skill_id_for <ns> <name>
skill_id_for() { skill_get "$1" "$2" | jq -r '.skill.skillId // empty'; }

# ─── Browser assertions ────────────────────────────────────────────

nav() {
  agent-browser --session-name "$SESSION" open "$1" >/dev/null 2>&1
  agent-browser --session-name "$SESSION" wait --load networkidle >/dev/null 2>&1
  sleep 1
}

assert_toast_contains() {
  local text
  text=$(agent-browser --session-name "$SESSION" eval \
    'document.querySelector("[data-portal] .toast")?.innerText || ""' 2>/dev/null)
  if [[ "$text" == *"$1"* ]]; then
    pass "toast contains: $1"
  else
    fail "toast did not contain '$1' — got: ${text:0:120}"
  fi
}

assert_no_console_errors() {
  local errs
  errs=$(agent-browser --session-name "$SESSION" console 2>&1 \
    | grep -E '^\[(error|warning)\]' \
    | grep -vE '1password|WebMCP|HMR|Snap-ins|sourcemap|devtools|messenger' \
    || true)
  if [ -z "$errs" ]; then
    pass "console clean"
  else
    fail "console had errors/warnings:"
    echo "$errs" | head -5 >&2
  fi
}

clear_console() {
  agent-browser --session-name "$SESSION" console --clear >/dev/null 2>&1 || true
}

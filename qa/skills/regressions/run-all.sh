#!/usr/bin/env bash
# qa/skills/regressions/run-all.sh — curl-only regression pack
# R-01..R-15 must all pass; any FAIL is a bug that came back.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../qa-lib.sh
source "$SCRIPT_DIR/qa-lib.sh"

step "R-01 install should not 500 (shouldAssign leftover)"
# Status: either 201 (fresh) or 409 (already installed). NEVER 500.
code=$(install_status "anthropics/skills/pdf")
if [ "$code" = "201" ] || [ "$code" = "409" ]; then
  pass "R-01: POST /install returned $code (not 500)"
else
  fail "R-01: POST /install returned $code"
fi

step "R-02 install same source twice should 409"
# whatever the current state, a re-install of the same source must 409
existing=$(install_status "anthropics/skills/pdf")
if [ "$existing" = "409" ]; then
  pass "R-02: re-install returns 409"
else
  # may still be 201 if first test actually created it — try again
  code=$(install_status "anthropics/skills/pdf")
  if [ "$code" = "409" ]; then
    pass "R-02: second attempt returns 409"
  else
    fail "R-02: expected 409, got $code"
  fi
fi

step "R-03 @namespace param accepts 'anthropic' as substring"
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/skills/@anthropics-skills/pdf")
if [ "$code" = "200" ]; then
  pass "R-03: @anthropics-skills resolves"
else
  fail "R-03: @anthropics-skills returned $code"
fi

step "R-07 lint warnings do not block install"
# ctf-reverse has a well-known description-person warning yet must install.
# if already installed, 409 is fine — the point is we never see 400/500 from lint.
code=$(install_status "ljagiello/ctf-skills/ctf-reverse")
case "$code" in
  201|409) pass "R-07: ctf-reverse install status = $code (no lint block)" ;;
  *)       fail "R-07: ctf-reverse install status = $code (expected 201 or 409)" ;;
esac

step "R-15 reserved word only blocks exact segments"
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/skills/@anthropics-skills/mcp-builder")
[ "$code" = "200" ] && pass "R-15: anthropics-skills not rejected" || fail "R-15: status $code"

# UI-driven regressions (R-04, R-05, R-06, R-08, R-09, R-10, R-11, R-12, R-13, R-14)
# are covered by chain-UI runs; the curl pack asserts the backend invariants.

summary

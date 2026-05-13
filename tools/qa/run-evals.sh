#!/usr/bin/env bash
# Runs tools/qa promptfoo suites in parallel against a provider profile.
#
# Usage: tools/qa/run-evals.sh [--profile anthropic|groq|openai]
#                              [--filter SUBSTR] [--core-only] [--out DIR]
# Defaults: --profile anthropic, --out tools/qa/results/$profile/$ts
#
# Suites: `core` (FSM/daemon — swappable provider), `prompt` (Anthropic-only
# inline-fetch — skipped on other profiles), `no-llm` (model-agnostic).

set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
QA_DIR="${REPO_ROOT}/tools/qa"
LIVE_DIR="${QA_DIR}/live-daemon/promptfoo"
PROMPT_TUNING_DIR="${QA_DIR}/prompt-tuning/promptfoo"

PROFILE="anthropic"
FILTER=""
CORE_ONLY="false"
OUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --filter) FILTER="$2"; shift 2 ;;
    --core-only) CORE_ONLY="true"; shift ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$PROFILE" in
  anthropic) export FRIDAY_QA_PROVIDER="anthropic"; export FRIDAY_QA_MODEL="claude-sonnet-4-6" ;;
  groq)      export FRIDAY_QA_PROVIDER="groq"; export FRIDAY_QA_MODEL="meta-llama/llama-4-scout-17b-16e-instruct" ;;
  openai)    export FRIDAY_QA_PROVIDER="openai"; export FRIDAY_QA_MODEL="gpt-4o-mini" ;;
  *) echo "unknown profile: $PROFILE" >&2; exit 2 ;;
esac

TS="$(date +%Y%m%dT%H%M%S)"
OUT_DIR="${OUT_DIR:-${QA_DIR}/results/${PROFILE}/${TS}}"
mkdir -p "$OUT_DIR"

declare -a CORE_SUITES=(
  "${LIVE_DIR}/promptfooconfig.yaml"
  "${LIVE_DIR}/retrieval-gated-config.yaml"
  "${LIVE_DIR}/tool-suite-management-config.yaml"
  "${PROMPT_TUNING_DIR}/tool-choice-config.yaml"
)
declare -a PROMPT_SUITES=(
  "${LIVE_DIR}/connect-service-on-auth-error-config.yaml"
  "${LIVE_DIR}/delegate-error-contract-config.yaml"
  "${LIVE_DIR}/delegate-skills-config.yaml"
  "${LIVE_DIR}/load-skill-injection-config.yaml"
)
declare -a NOLLM_SUITES=(
  "${LIVE_DIR}/oauth-refresh-transient-config.yaml"
  "${LIVE_DIR}/table-outcomes-config.yaml"
)

declare -a SUITES=()
SUITES+=("${CORE_SUITES[@]}")
if [[ "$CORE_ONLY" != "true" ]]; then
  SUITES+=("${NOLLM_SUITES[@]}")
  if [[ "$PROFILE" == "anthropic" ]]; then
    SUITES+=("${PROMPT_SUITES[@]}")
  fi
fi

if [[ -n "$FILTER" ]]; then
  FILTERED=()
  for s in "${SUITES[@]}"; do
    if [[ "$s" == *"$FILTER"* ]]; then FILTERED+=("$s"); fi
  done
  SUITES=("${FILTERED[@]}")
fi

if [[ ${#SUITES[@]} -eq 0 ]]; then
  echo "no suites match filter '$FILTER' for profile '$PROFILE'" >&2
  exit 1
fi

echo "==> profile=$PROFILE  provider=$FRIDAY_QA_PROVIDER  model=$FRIDAY_QA_MODEL"
echo "==> out=$OUT_DIR"
echo "==> suites:"
for s in "${SUITES[@]}"; do echo "    - ${s##*/}"; done
echo

NAMES=()
PIDS=()
LOGS=()
REPORTS=()

START_TS=$(date +%s)

for cfg in "${SUITES[@]}"; do
  name="$(basename "$cfg" -config.yaml)"
  name="${name%%.yaml}"
  log="${OUT_DIR}/${name}.log"
  report="${OUT_DIR}/${name}.report.json"
  echo "  starting $name → $log"
  (
    cd "$(dirname "$cfg")" && \
    FRIDAY_QA_PROVIDER="$FRIDAY_QA_PROVIDER" \
    FRIDAY_QA_MODEL="$FRIDAY_QA_MODEL" \
    npx promptfoo@latest eval \
      --config "$(basename "$cfg")" \
      --output "$report" \
      --no-cache \
      > "$log" 2>&1
  ) &
  NAMES+=("$name")
  PIDS+=("$!")
  LOGS+=("$log")
  REPORTS+=("$report")
done

STATUSES=()
for i in "${!PIDS[@]}"; do
  if wait "${PIDS[$i]}"; then
    STATUSES+=("pass")
  else
    STATUSES+=("FAIL($?)")
  fi
done

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

echo
echo "==> done in ${ELAPSED}s"
echo
printf "%-44s %-10s %s\n" "suite" "status" "report"
printf "%-44s %-10s %s\n" "-----" "------" "------"

OVERALL_PASS=0
OVERALL_FAIL=0
# Sort by name for stable output. Build "name|status|report" lines, sort,
# then split.
LINES=()
for i in "${!NAMES[@]}"; do
  LINES+=("${NAMES[$i]}|${STATUSES[$i]}|${REPORTS[$i]}")
done
while IFS='|' read -r name status report; do
  printf "%-44s %-10s %s\n" "$name" "$status" "$report"
  if [[ "$status" == "pass" ]]; then
    OVERALL_PASS=$((OVERALL_PASS+1))
  else
    OVERALL_FAIL=$((OVERALL_FAIL+1))
  fi
done < <(printf '%s\n' "${LINES[@]}" | sort)

echo
echo "==> suites passing: ${OVERALL_PASS}/${#NAMES[@]}  (fail: ${OVERALL_FAIL})"

if [[ "$OVERALL_FAIL" -gt 0 ]]; then
  exit 1
fi

#!/usr/bin/env bash
# Runs every suite under tools/evals/promptfoo/suites/* in a single promptfoo
# invocation so they share one scheduler — true parallelism across the full
# suite × provider × test matrix (promptfoo's -j is a global worker pool).
#
# Knobs (all env, all optional):
#   EVAL_TIER=small|medium|large    pick a provider tier
#                                   (forwarded as --filter-providers 'tier:<v>')
#                                   accepts a regex: small|medium → both tiers
#   EVAL_CONCURRENCY=N              -j N (default 20)
#   PROMPTFOO_PASS_RATE_THRESHOLD=N exit 100 if pass rate < N (promptfoo built-in)
#
# Pass through any extra promptfoo flags after `--`:
#   deno task evals:promptfoo -- --filter-pattern simple-substitution
#
# Examples:
#   deno task evals:promptfoo                                # full matrix
#   EVAL_TIER=small deno task evals:promptfoo                # cheap CI run
#   EVAL_TIER='small|medium' deno task evals:promptfoo       # PR matrix
#   PROMPTFOO_PASS_RATE_THRESHOLD=95 deno task evals:promptfoo
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

CONFIG_ARGS=()
for cfg in tools/evals/promptfoo/suites/*/promptfooconfig.yaml; do
  CONFIG_ARGS+=(-c "$cfg")
done

FILTER_ARGS=()
if [[ -n "${EVAL_TIER:-}" ]]; then
  FILTER_ARGS+=(--filter-providers "tier:(${EVAL_TIER})")
fi

exec npx promptfoo@latest eval \
  "${CONFIG_ARGS[@]}" \
  --no-cache --no-share \
  -j "${EVAL_CONCURRENCY:-20}" \
  ${FILTER_ARGS[@]+"${FILTER_ARGS[@]}"} "$@"

#!/usr/bin/env bash
# Runs every suite under tools/evals/promptfoo/suites/* against the LiteLLM
# proxy. Each suite gets its own promptfoo invocation, in PARALLEL, with
# per-suite JSON output aggregated into a single pass-rate table at the end.
#
# Why per-suite invocations: promptfoo's multi-config merge (`-c A -c B`)
# uses the first config's basePath to resolve `file://` vars in ALL configs'
# tests, so `progress-line/tests.yaml` referencing `file://prompts/X.txt`
# resolves wrong when `agent-config-prompt/` sorts first.
#
# Why parallel: with 7 suites at 4s–6min each, sequential takes ~13min;
# parallel finishes in roughly the slowest single suite's wall-clock.
#
# Knobs (all env, all optional):
#   EVAL_TIER=small|medium|large    pick a provider tier
#                                   (forwarded as --filter-providers 'tier:<v>')
#                                   accepts a regex: small|medium → both tiers
#   EVAL_CONCURRENCY=N              -j N PER SUITE (default 20)
#   PROMPTFOO_PASS_RATE_THRESHOLD=N exit 100 if AGGREGATE pass rate < N
#                                   (default 0 = always succeed; the table
#                                   is the signal, the exit code is the gate)
#
# Pass through any extra promptfoo flags after `--`:
#   deno task evals:promptfoo -- --filter-pattern simple-substitution
#
# Examples:
#   deno task evals:promptfoo                                # full matrix
#   EVAL_TIER=medium deno task evals:promptfoo               # PR-tier run
#   PROMPTFOO_PASS_RATE_THRESHOLD=80 deno task evals:promptfoo  # CI gate
set -euo pipefail
shopt -s nullglob

# Preflight: must be inside a git checkout so the suites glob resolves
# against the repo root, not whatever cwd the caller happened to be in.
if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "✗ run-all.sh must run inside a git checkout (git rev-parse --show-toplevel failed)" >&2
  exit 1
fi
cd "$REPO_ROOT"

# Preflight: API keys. Both are consumed downstream — LITELLM_API_KEY gates
# the @atlas/llm registry's LiteLLM routing (workspace-chat suites);
# LITELLM_MASTER_KEY is the bearer the shared providers send to the proxy.
# Failing here keeps cryptic per-suite 401s out of the logs.
MISSING_KEYS=()
[[ -z "${LITELLM_API_KEY:-}" ]] && MISSING_KEYS+=("LITELLM_API_KEY")
[[ -z "${LITELLM_MASTER_KEY:-}" ]] && MISSING_KEYS+=("LITELLM_MASTER_KEY")
if (( ${#MISSING_KEYS[@]} > 0 )); then
  echo "✗ missing required env: ${MISSING_KEYS[*]}" >&2
  echo "  see tools/evals/promptfoo/litellm/README.md for setup" >&2
  exit 1
fi

FILTER_ARGS=()
if [[ -n "${EVAL_TIER:-}" ]]; then
  FILTER_ARGS+=(--filter-providers "tier:(${EVAL_TIER})")
fi

CONCURRENCY="${EVAL_CONCURRENCY:-20}"
THRESHOLD="${PROMPTFOO_PASS_RATE_THRESHOLD:-0}"

# Per-suite outputs land in a temp dir; kept on success too so the JSON can be
# diffed across runs if needed (e.g., `jq` on results.json for a specific case).
OUT_DIR=$(mktemp -d -t friday-promptfoo-XXXXXX)
echo "▶ outputs: ${OUT_DIR}"

# Kill backgrounded suites if the user Ctrl-Cs — otherwise `npx promptfoo`
# subprocesses get orphaned and keep burning tokens.
trap 'kill $(jobs -p) 2>/dev/null; exit 130' INT TERM

# Launch every suite as a background job. Capture stdout/stderr per suite so
# parallel output doesn't interleave; print start markers up front. macOS
# ships bash 3.x — no associative arrays, no `wait -n` — so we track suites
# by name in a plain list and poll for .exit files.
SUITES=()
CFGS=(tools/evals/promptfoo/suites/*/promptfooconfig.yaml)
if (( ${#CFGS[@]} == 0 )); then
  echo "✗ no suites matched tools/evals/promptfoo/suites/*/promptfooconfig.yaml" >&2
  exit 1
fi

# Per-suite launches are intentionally tolerant: each one writes its exit code
# to a .exit file and we aggregate in the wait loop. Relax -e here so a single
# suite's non-zero exit doesn't abort the whole batch before aggregation.
set +e
for cfg in "${CFGS[@]}"; do
  suite=$(basename "$(dirname "$cfg")")
  SUITES+=("$suite")
  log="${OUT_DIR}/${suite}.log"
  json="${OUT_DIR}/${suite}.json"
  echo "▶ launching: ${suite}"
  (
    npx promptfoo@latest eval \
      -c "$cfg" \
      -o "$json" \
      --no-cache --no-share \
      -j "$CONCURRENCY" \
      ${FILTER_ARGS[@]+"${FILTER_ARGS[@]}"} "$@" \
      >"$log" 2>&1
    echo $? >"${OUT_DIR}/${suite}.exit"
  ) &
done
set -e

# Wait for jobs, printing one-line status as each .exit file appears.
while :; do
  pending=0
  for suite in "${SUITES[@]}"; do
    if [[ -f "${OUT_DIR}/${suite}.exit" && ! -f "${OUT_DIR}/${suite}.reported" ]]; then
      exit_code=$(cat "${OUT_DIR}/${suite}.exit")
      touch "${OUT_DIR}/${suite}.reported"
      printf '✓ done: %-32s exit=%s\n' "$suite" "$exit_code"
    fi
    if [[ ! -f "${OUT_DIR}/${suite}.reported" ]]; then
      pending=$((pending + 1))
    fi
  done
  if (( pending == 0 )); then break; fi
  sleep 2
done

# Aggregate from per-suite JSON. Promptfoo's results.json shape:
#   { results: { stats: { successes, failures, errors }, ... } }
# Use Deno (always available in this repo) for parsing.
echo ""
echo "════════════════════════════════════════════════════════════"
echo "▶ summary"
echo "════════════════════════════════════════════════════════════"

deno run --allow-read --quiet - "$OUT_DIR" "$THRESHOLD" <<'DENO'
const [outDir, thresholdStr] = Deno.args;
const threshold = Number(thresholdStr);

const files = [];
for await (const e of Deno.readDir(outDir)) {
  if (e.isFile && e.name.endsWith(".json")) files.push(e.name);
}
files.sort();

let totalPass = 0;
let totalFail = 0;
let totalErr = 0;
const rows = [];

for (const file of files) {
  const suite = file.replace(/\.json$/, "");
  let pass = 0, fail = 0, err = 0, parseErr = "";
  try {
    const data = JSON.parse(await Deno.readTextFile(`${outDir}/${file}`));
    const stats = data?.results?.stats ?? {};
    pass = stats.successes ?? 0;
    fail = stats.failures ?? 0;
    err = stats.errors ?? 0;
  } catch (e) {
    parseErr = `parse error: ${e instanceof Error ? e.message : String(e)}`;
  }
  totalPass += pass;
  totalFail += fail;
  totalErr += err;
  const total = pass + fail + err;
  const pct = total > 0 ? ((pass / total) * 100).toFixed(1) : "—";
  rows.push({ suite, pass, total, pct, parseErr });
}

const w = (s, n) => String(s).padEnd(n);
console.log(`  ${w("suite", 36)} ${w("pass/total", 12)} ${w("%", 8)}`);
console.log(`  ${"─".repeat(36)} ${"─".repeat(12)} ${"─".repeat(8)}`);
for (const r of rows) {
  const cell = r.parseErr ? r.parseErr : `${r.pass}/${r.total}`;
  console.log(`  ${w(r.suite, 36)} ${w(cell, 12)} ${w(r.pct, 8)}`);
}

const grandTotal = totalPass + totalFail + totalErr;
const grandPct = grandTotal > 0 ? (totalPass / grandTotal) * 100 : 0;
console.log(`  ${"─".repeat(36)} ${"─".repeat(12)} ${"─".repeat(8)}`);
console.log(
  `  ${w("AGGREGATE", 36)} ${w(`${totalPass}/${grandTotal}`, 12)} ${w(grandPct.toFixed(1), 8)}`,
);

if (threshold > 0 && grandPct < threshold) {
  console.log("");
  console.log(`✗ aggregate ${grandPct.toFixed(1)}% < threshold ${threshold}%`);
  Deno.exit(100);
}
Deno.exit(0);
DENO

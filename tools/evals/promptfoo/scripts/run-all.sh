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
#   PROMPTFOO_SUITE_FLOOR=N         exit 100 if ANY suite's pass rate < N
#                                   (default 70). A suite that errored out
#                                   and produced no parseable JSON counts as
#                                   failing the floor (gate=ERROR). A suite
#                                   that ran but produced zero results (e.g.
#                                   --filter-providers matched nothing) is
#                                   gate=SKIPPED — excluded from the floor
#                                   AND from aggregate numerator/denominator.
#   PROMPTFOO_AGGREGATE_CEILING=N   exit 100 if AGGREGATE pass rate < N
#                                   (default 85)
#   PROMPTFOO_REQUIRE_SUITES=N      exit 100 if fewer than N suites ran with
#                                   non-zero results (default = total suites
#                                   discovered). Catches the case where
#                                   --filter-providers silently skips every
#                                   suite. Set to 0 to opt out.
#
# Pass through any extra promptfoo flags after `--`:
#   deno task evals:promptfoo -- --filter-pattern simple-substitution
#
# Examples:
#   deno task evals:promptfoo                                # full matrix
#   EVAL_TIER=medium deno task evals:promptfoo               # PR-tier run
#   PROMPTFOO_SUITE_FLOOR=80 PROMPTFOO_AGGREGATE_CEILING=90 \
#     deno task evals:promptfoo                              # stricter CI gate
set -euo pipefail
shopt -s nullglob

# Preflight: external tools we shell out to. Failing here keeps cryptic
# "command not found" errors out of mid-run per-suite logs.
for tool in curl npx deno; do
  command -v "$tool" >/dev/null || {
    echo "✗ $tool is required but not installed" >&2
    exit 1
  }
done

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

# Preflight: proxy must answer on :4000. Without this, each suite emits a
# cryptic per-suite connection-refused ERROR row buried in its own log.
if ! curl -sf -m 2 http://localhost:4000/health \
    -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" >/dev/null; then
  echo "✗ proxy not responding at :4000 (run tools/evals/promptfoo/litellm/start.sh)" >&2
  echo "  see tools/evals/promptfoo/litellm/README.md for setup" >&2
  exit 1
fi

FILTER_ARGS=()
if [[ -n "${EVAL_TIER:-}" ]]; then
  FILTER_ARGS+=(--filter-providers "tier:(${EVAL_TIER})")
fi

CONCURRENCY="${EVAL_CONCURRENCY:-20}"
SUITE_FLOOR="${PROMPTFOO_SUITE_FLOOR:-70}"
AGGREGATE_CEILING="${PROMPTFOO_AGGREGATE_CEILING:-85}"

# Per-suite outputs land in a temp dir; kept on success too so the JSON can be
# diffed across runs if needed (e.g., `jq` on results.json for a specific case).
OUT_DIR=$(mktemp -d -t friday-promptfoo-XXXXXX)
echo "▶ outputs: ${OUT_DIR}"

# Each backgrounded suite must run in its OWN process group so the cleanup
# trap can reach the `npx → node → deno` grandchildren — not just the immediate
# subshell. Without `set -m`, `kill $(jobs -p)` SIGTERMs only the direct
# children; the grandchildren orphan and keep burning tokens.
set -m

# Track PGIDs for the trap. Under `set -m`, each background subshell becomes
# its own process-group leader, so $! equals the PGID at fork time. Signalling
# a negative PID (`kill -TERM -$pgid`) hits every descendant in that group.
SUITE_PGIDS=()
cleanup() {
  for pgid in ${SUITE_PGIDS[@]+"${SUITE_PGIDS[@]}"}; do
    kill -TERM "-$pgid" 2>/dev/null || true
  done
  exit 130
}
trap cleanup INT TERM

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

# Default REQUIRE_SUITES to the discovered suite count — i.e. assume the caller
# wanted every suite to run unless they explicitly opted out with `=0`. A suite
# that ran with zero results (provider filter excluded everything) doesn't count
# toward this floor; see the Deno aggregator below.
REQUIRE_SUITES="${PROMPTFOO_REQUIRE_SUITES:-${#CFGS[@]}}"

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
    npx promptfoo@0.121.12 eval \
      -c "$cfg" \
      -o "$json" \
      --no-cache --no-share \
      -j "$CONCURRENCY" \
      ${FILTER_ARGS[@]+"${FILTER_ARGS[@]}"} "$@" \
      >"$log" 2>&1
    echo $? >"${OUT_DIR}/${suite}.exit"
  ) &
  SUITE_PGIDS+=("$!")
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

deno run --allow-read --quiet - "$OUT_DIR" "$SUITE_FLOOR" "$AGGREGATE_CEILING" "$REQUIRE_SUITES" <<'DENO'
const [outDir, floorStr, ceilingStr, requireStr] = Deno.args;
const suiteFloor = Number(floorStr);
const aggregateCeiling = Number(ceilingStr);
const requireSuites = Number(requireStr);

const files = [];
for await (const e of Deno.readDir(outDir)) {
  if (e.isFile && e.name.endsWith(".json")) files.push(e.name);
}
files.sort();

interface Row {
  suite: string;
  pass: number;
  total: number;
  pct: number | null;
  parseErr: string;
  skipped: boolean;
}

let totalPass = 0;
let totalFail = 0;
let totalErr = 0;
const rows: Row[] = [];

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
  const total = pass + fail + err;
  // A successful run that produced zero results = suite was filtered out
  // (e.g. EVAL_TIER=small against a suite that excludes tier:small).
  // Exclude from aggregate so a skipped suite can't silently green-light the run.
  const skipped = !parseErr && total === 0;
  if (!skipped) {
    totalPass += pass;
    totalFail += fail;
    totalErr += err;
  }
  const pct = total > 0 && !parseErr ? (pass / total) * 100 : null;
  rows.push({ suite, pass, total, pct, parseErr, skipped });
}

const w = (s: string, n: number) => String(s).padEnd(n);
const fmtPct = (pct: number | null) => pct === null ? "—" : pct.toFixed(1);

// A suite fails the floor if its pct is below floor, OR it errored out (no
// parseable JSON). SKIPPED suites (intentionally filtered to zero providers)
// don't count — they weren't tested.
const suiteFailed = (r: Row) => !r.skipped && (r.pct === null || r.pct < suiteFloor);
const gateFor = (r: Row) => {
  if (r.skipped) return "SKIPPED";
  if (r.parseErr) return "ERROR";
  return suiteFailed(r) ? "FAIL" : "PASS";
};

console.log(`  ${w("suite", 36)} ${w("pass/total", 12)} ${w("%", 8)} gate`);
console.log(`  ${"─".repeat(36)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(7)}`);
for (const r of rows) {
  const cell = r.parseErr ? r.parseErr : `${r.pass}/${r.total}`;
  console.log(`  ${w(r.suite, 36)} ${w(cell, 12)} ${w(fmtPct(r.pct), 8)} ${gateFor(r)}`);
}

const grandTotal = totalPass + totalFail + totalErr;
const grandPct = grandTotal > 0 ? (totalPass / grandTotal) * 100 : 0;
const aggregateFailed = grandPct < aggregateCeiling;
const aggregateGate = aggregateFailed ? "FAIL" : "PASS";
console.log(`  ${"─".repeat(36)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(7)}`);
console.log(
  `  ${w("AGGREGATE", 36)} ${w(`${totalPass}/${grandTotal}`, 12)} ${w(grandPct.toFixed(1), 8)} ${aggregateGate}`,
);

const trippedSuites = rows.filter(suiteFailed).map((r) => r.suite);
const skippedSuites = rows.filter((r) => r.skipped).map((r) => r.suite);
const ranSuites = rows.length - skippedSuites.length;
// `requireSuites=0` opts out of the gate entirely (ad-hoc tier filtering).
const requireGateFailed = requireSuites > 0 && ranSuites < requireSuites;
if (trippedSuites.length > 0 || aggregateFailed || requireGateFailed) {
  console.log("");
  if (requireGateFailed) {
    console.log(
      `✗ only ${ranSuites}/${requireSuites} suites ran; SKIPPED: ${
        skippedSuites.join(", ")
      } (override with PROMPTFOO_REQUIRE_SUITES=0)`,
    );
  }
  if (trippedSuites.length > 0) {
    console.log(`✗ suite floor ${suiteFloor}% tripped by: ${trippedSuites.join(", ")}`);
  }
  if (aggregateFailed) {
    console.log(`✗ aggregate ${grandPct.toFixed(1)}% < ceiling ${aggregateCeiling}%`);
  }
  Deno.exit(100);
}
Deno.exit(0);
DENO

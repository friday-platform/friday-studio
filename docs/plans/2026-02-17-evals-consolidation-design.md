# Evals Consolidation

Shipped on branch `evals-3`, February 2026.

Consolidated two fragmented eval packages (`tools/evals`, `tools/evals-2`) and
the evalite runtime dependency into a single `tools/evals` package with a custom
runner CLI, first-party AI SDK tracing in `@atlas/llm`, and a full post-run
analysis toolkit (report, baseline, diff, inspect, diagnose).

## What Changed

### `packages/llm/src/tracing.ts` — First-party trace capture

Replaced evalite's `wrapAISDKModel` with `traceModel()` using
AsyncLocalStorage-scoped `wrapLanguageModel` middleware. Both `wrapGenerate` and
`wrapStream` are implemented. Zero-cost outside eval scope — ALS check at call
time, not wrap time.

`TraceEntry` normalizes both generate and stream into one shape: `type`,
`modelId`, input messages, output (text + toolCalls), usage (in/out/total
tokens), scope-relative timing (`startMs`/`endMs`). Tool call `input` is
`JSON.parse`'d from AI SDK v5's stringified JSON.

Exports: `traceModel`, `TraceCollector`, `enterTraceScope`, `TraceEntry` type.

### All production agents — `traceModel()` instrumentation

Mechanical replacement of `wrapAISDKModel(model)` → `traceModel(model)` across
every agent that calls `registry.languageModel(...)`. Packages touched:
`@atlas/bundled-agents`, `@atlas/core`, `@atlas/llm`, `@atlas/hallucination`,
`@atlas/system`, `@atlas/workspace-builder`, `@atlas/document-store`, and
`src/core/`.

### `tools/evals/run.ts` — Custom runner CLI

Replaced `Deno.test` shelling with a custom CLI built on `gunshi`. Eval files
are discovered via `tools/evals/**/*.eval.ts` glob, dynamically imported, and
executed through `runEval()`. Each file must export `evals: EvalRegistration[]`.

Commands:

| Command | What it does |
|---|---|
| `run` | Execute evals. Flags: `-t` target file, `-F` filter by name, `--fail-fast`, `--verbose` |
| `list` | List discovered `.eval.ts` files |
| `report` | Latest results as ASCII table or `--json`. `--failures` to filter |
| `inspect` | Full conversation transcript for one eval (`-e name`) |
| `baseline save` | Snapshot current results to `baseline.json` |
| `baseline show` | Print committed baseline |
| `diff --baseline` | Compare current vs baseline. Exits 1 on regressions |
| `diagnose` | LLM-powered failure analysis for one eval (`-e name`) |

### `tools/evals/lib/` — Eval harness

Core lifecycle:

- **`registration.ts`** — `EvalRegistration`, `BaseEvalCase`, `defineEval<T>()`.
  The contract between eval files and the runner. `defineEval` preserves
  generics across `run`/`assert`/`score` callbacks via an existential-type
  workaround.
- **`run-eval.ts`** — `runEval()` lifecycle: trace scope → context creation →
  execution → assertion → scoring → write result. Scoring always runs if
  execution succeeded, even when assertion fails.
- **`runner.ts`** — `executeEvals()` top-level driver. Generates a shared
  `runId`, imports files, applies filter, handles file-level and eval-level
  errors, respects `--fail-fast`.
- **`context.ts`** — `AgentContextAdapter`. Each `createContext()` returns
  hermetic session/stream/logger with unique IDs. No daemon, DB, or workspace
  runtime required.

Persistence and analysis:

- **`output.ts`** — `writeEvalResult()` writes JSON to
  `__output__/{evalName}/{timestamp}.json`. `readOutputDir()` reads them back
  with filtering (runId, evalName, latest). `writeSummaryMarkdown()` writes
  `LATEST_SUMMARY.md` after each run.
- **`scoring.ts`** — `Score` type (name, value 0–1, optional reason/metadata).
  `createScore()` with range validation. `aggregateScores()` for mean.
- **`report.ts`** — `buildReport()` from grouped results. Aligned ASCII table
  output.
- **`baseline.ts`** — `extractBaseline()` creates behavioral fingerprints:
  pass/fail, scores, tool call sequence, turn count, error phase. Stamped with
  git commit hash.
- **`diff.ts`** — `computeDiff()` full outer join on eval names. Classifies as
  improved/regressed/unchanged/new/removed. Tool call sequence changes without
  score movement count as regressions.
- **`inspect.ts`** — `formatInspect()` renders full conversation: per-trace
  messages, tool calls with args, token/duration stats.
- **`diagnose.ts`** — `diagnoseFailure()` sends failed result to
  `groq:openai/gpt-oss-120b` via AI SDK `generateObject`. Returns structured
  diagnosis: root cause, failure phase, problematic trace index, suggested fix,
  confidence.
- **`formatter.ts`** — Live run output. Compact one-line per eval with
  pass/fail, scores, duration, tokens. `--verbose` adds stack traces.

Utilities:

- **`llm-judge.ts`** — Semantic scorer via LLM for open-ended output.
- **`load-credentials.ts`** — Bootstrap API keys from `ATLAS_KEY` env var.
- **`setup-fake-credentials.ts`** — Populate env with format-correct but invalid
  credentials for routing tests (covers 20 integrations).
- **`test-helpers.ts`** — `createMockModel()` (full `LanguageModelV2`
  implementation with call recording), `createEvalContext()` shorthand. Inline
  implementation avoids pulling `ai/test` → `msw` dependency chain.

### `tools/evals/agents/` — Ported evals

All evals from both old packages ported to the `defineEval()` / `EvalRegistration[]` export pattern:

- **`small-llm/`** — 20 cases across Groq + Haiku providers. Progress
  extraction (tool invocations, research updates, web search status lines).
  Latency, relevance, and status-line scorers.
- **`research/`** — `webSearchAgent`. Positive cases (local news, product
  search, contact research) and failure handling (false premise correction,
  calendar access refusal). LLM judge + entity presence + citation scoring.
- **`email/`** — `emailAgent`. 6 suites: refusal (4), security (1), composition
  (5), sender validation (3), recipient domain restrictions (3), missing
  ATLAS_KEY (1). Mix of exact-match assertions and LLM judge scoring.
  `generateMockJWT()` for identity injection.
- **`email-gmail-classification/`** — Full planner→classify→MCP pipeline.
  Regression coverage for ATLAS-29X (Gmail vs SendGrid routing). 14 cases across
  bundled-email, gmail-mcp, mixed, and edge-case suites.
- **`data-analyst/`** — `dataAnalystAgent`. 11 cases against a 10K-row CSV→SQLite
  fixture. SQL structure inspection + numeric tolerance assertions against
  pre-computed ground truth.
- **`csv-contact-sampler/`** — `csvFilterSamplerAgent`. 3 cases with 1K-row
  generated fixture. Assertion-heavy: field-level verification, randomness
  check, empty-filter behavior.
- **`connect-mcp-server/`** — `extractAndHydrate()` classification function. 12
  cases: HTTP/stdio × auth variants + vague-input errors. LLM judge scored.

### Deleted

- `tools/evals-2/` — entire package (evals ported to `tools/evals/agents/`)
- `evalite` dependency removed from `@atlas/llm`, `@atlas/bundled-agents`,
  `@atlas/system`, `@atlas/workspace-builder`
- `knip.json` config (was evals-specific)

## Key Decisions

**Custom runner CLI, not Deno.test.** `Deno.test` couldn't support the
post-run analysis commands (report, baseline, diff, inspect, diagnose) and
required shelling out from `deno task`. The custom runner gives full control
over discovery, execution order, output formatting, and exit codes.

**Tracing lives in `@atlas/llm`, not `tools/evals`.** Production agents
already imported evalite's `wrapAISDKModel` — tracing needs to be importable
from a production package. Putting it in `@atlas/llm` made the evalite removal
a clean swap.

**`runEval()` is sugar, not a requirement.** The raw try/catch + writeEvalResult
pattern remains available for tests needing custom lifecycle control. Most evals
use `runEval()` for the boilerplate reduction.

**Assertions and scorers are separate concerns.** Assertions (pass/fail) use
`@std/assert`. Scorers produce numeric `Score` objects for trend analysis.
Scoring always runs if execution succeeded — even when assertion fails — so
trend data isn't lost on hard failures.

**`defineEval<T>()` preserves generics via existential-type cast.** TypeScript
can't express "there exists a T such that run/assert/score agree on it" in an
array. The builder preserves type safety within each registration, then widens
to `EvalConfig<unknown>` for the `EvalRegistration[]` export.

**Eval files export `evals: EvalRegistration[]`, not test functions.** The
runner owns the execution lifecycle. Eval files are pure data (case definitions +
callbacks), not test harness code.

**Tool call sequence changes are regressions.** In `diff.ts`, changed tool call
order with unchanged scores is classified as `regressed`. Behavioral changes
matter even when scores don't move.

**`diagnose` uses a cheap external model.** `groq:openai/gpt-oss-120b` for
failure diagnosis and LLM judge scoring — fast and cheap enough to run on every
failure without cost concerns.

**TraceEntry includes `modelId`.** Essential for debugging multi-model agents
where smallLLM classification and main generation produce different traces.

## Error Handling

`runEval()` captures errors with a `phase` discriminator:
- `"execution"` — agent threw (runtime error, API failure, timeout)
- `"assertion"` — test assertion failed
- `"scoring"` — scorer threshold violated

File-level import failures get a synthetic `phase: "import"` error result.

Agent returning `ok: false` is NOT an error — it's a valid result. Stack traces
are captured in the JSON output for debugging without re-running. `--verbose`
surfaces them in terminal output.

## Out of Scope

- **UI visualizer** — JSON files on disk, `inspect` command for transcripts
- **CI integration** — `diff --baseline` exits 1 on regressions (CI-ready) but
  no pipeline integration yet
- **Eval caching** — every run is fresh
- **Parallel execution** — evals run sequentially within `executeEvals()`
- **Vitest migration for eval runner** — harness unit tests use vitest, but eval
  execution uses the custom runner

## Test Coverage

**Harness unit tests** (`tools/evals/lib/*.test.ts`, 13 files, vitest):

- `scoring` — range validation, aggregation, boundary values
- `output` — write/read cycle, path sanitization, grouping, filtering, malformed
  file resilience, summary markdown
- `context` — hermetic isolation, unique IDs, stream/log capture, abort signal
- `registration` — via `run-eval` and `runner` tests
- `run-eval` — full lifecycle, phase-specific errors, scoring survives assertion
  failure
- `runner` — file import, batch execution, fail-fast, filter, error isolation
- `report` — row building, table formatting, JSON output
- `baseline` — fingerprint extraction, pass/fail detection, tool call collection
- `diff` — regression/improvement classification, score deltas, tool call
  changes, new/removed evals
- `inspect` — transcript rendering, multi-turn, tool calls, error banners
- `formatter` — compact line output, summary aggregation, verbose mode
- `diagnose` — prompt construction only (no LLM calls in tests)
- `test-helpers` — mock model spec compliance, stream chunk order

**Smoke tests** (`tools/evals/lib/smoke-*.test.ts`, 3 files):

Run against real `__output__/` data from a prior `evals run`. Validate the full
workflow without calling LLMs:

- Phase 1: file discovery, export contract, output schema, naming conventions,
  anti-`Deno.test` guard
- Phase 2: report table structure, failure filtering, inspect transcript for
  passing and failing evals
- Phase 3: baseline extraction, self-diff (all unchanged), simulated regression
  detection, diagnose prompt construction

**Tracing tests** (`packages/llm/src/tests/tracing.test.ts`):

- ALS scoping and isolation, nested scopes
- `wrapGenerate` and `wrapStream` capture (input/output/usage/timing/modelId)
- No-op behavior outside trace scope

**Testing patterns:** No `vi.mock` anywhere — all dependencies injected or
directly constructed. Filesystem fixtures via `beforeEach`/`afterEach` cleanup.
Smoke tests skip gracefully when prerequisites aren't met.

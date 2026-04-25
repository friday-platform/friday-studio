<!-- v5 - 2026-04-15 - Clean-room rewrite. Treats `packages/bundled-agents/src/web/` as non-existent; plan describes building it from zero on a fresh branch. Predecessors (v1-v4) framed as migration deltas; this one doesn't. -->

# Unified Web Agent — Clean-Room Build Plan

Branch: `agent-browser-for-real`. Target: 2026-03-XX.

## Problem Statement

The workspace planner sees four overlapping web capabilities — `web-search`, `browser`, Playwright MCP, and the `fetch` MCP tool — and must predict the right execution strategy before the task starts. This produces inefficient plans: search tasks routed to browser (slow), browser tasks routed to search (can't interact), fetch-able pages sent through full browser sessions.

Four interfaces with overlapping capabilities is a shallow-module problem (Ousterhout). Implementation details leak into the planner's decision space. The fix is a deep module: one interface ("do something on the web") hiding the complexity of choosing and combining tools internally.

## Solution

Build a new `web` bundled agent. The planner sees one capability ID. Internally the agent routes between three tools — `search`, `fetch`, `browse` — and can combine them inside a single task. `web-search`, `browser`, and Playwright MCP are retired in the same change.

## User Stories

1. As a workspace planner, I want a single "web" capability so I don't predict whether a task needs search, fetch, or browser interaction.
2. As a user asking "find the best-rated restaurant in SF and make a reservation," I want the agent to search, then browse the reservation form — without me specifying which tools to use.
3. As a user asking "what's the latest news about Rust 2026," I want a fast search-only response without spinning up a browser session.
4. As a user asking "log into my bank account and check my balance," I want the agent to go straight to browser interaction and use my already-logged-in Chrome (via auto-connect) without re-authenticating.
5. As a user asking "read the content at this URL," I want the agent to try a cheap fetch first and only escalate to browser if the page is JS-rendered or blocked.
6. As a user asking "research competitors and then sign up for their free trials," I want the agent to search, then browse multiple sites, combining tools fluidly.
7. As a workspace planner, I want the web agent's output schema to be simple (`{ response: string }`) so downstream agents can consume it without caring how the information was obtained.
8. As a developer, I want browser sessions to only start when actually needed so that pure search/fetch tasks don't pay the daemon-init overhead.
9. As a developer, I want to set `AGENT_BROWSER_AUTO_CONNECT=1` in my shell and have the agent attach to my running Chrome instead of spawning an isolated one — no code changes or config files to touch.
10. As a developer running evals, I want to test pure search, pure browser, and mixed search+browser scenarios against the unified agent.

## Architecture

Single `generateText` loop using `google:gemini-3.1-pro-preview` with three tools. The model decides per-step which tool to use based on heuristic guidelines in the system prompt — not strict escalation rules.

Safety net: `stopWhen: stepCountIs(300)` prevents runaway sessions. Prompt-level stuck detection ("2 failed attempts at the same action → stop and report") handles the common case.

```
┌─────────────────────────────────────────────────┐
│                 Workspace Planner               │
│         sees ONE capability: "web"              │
└──────────────────────┬──────────────────────────┘
                       │ prompt
                       ▼
┌─────────────────────────────────────────────────┐
│              Web Agent (deep module)            │
│         google:gemini-3.1-pro-preview           │
│         stopWhen: stepCountIs(300)              │
│                                                 │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐ │
│  │  search  │ │  fetch   │ │     browse      │ │
│  │          │ │          │ │                 │ │
│  │ Parallel │ │ HTTP GET │ │ agent-browser   │ │
│  │ API +    │ │ → md/txt │ │ CLI via daemon  │ │
│  │ Gemini   │ │          │ │                 │ │
│  │ Pro      │ │ No LLM   │ │ snapshot/click/ │ │
│  │ synthesis│ │ LLM      │ │ fill/navigate   │ │
│  │          │ │ judges   │ │                 │ │
│  │ Returns  │ │ content  │ │ Unique session  │ │
│  │ summary +│ │ quality  │ │ per invocation  │ │
│  │ sources  │ │          │ │ close in finally│ │
│  │ + creates│ │          │ │                 │ │
│  │ artifact │ │          │ │ AGENT_BROWSER_  │ │
│  │          │ │          │ │ AUTO_CONNECT=1  │ │
│  │          │ │          │ │ env passthrough │ │
│  └──────────┘ └──────────┘ └─────────────────┘ │
│                                                 │
│  Side channels: mutable arrays in handler       │
│  closure — search pushes artifactRefs +         │
│  outlineRefs                                    │
│                                                 │
│  Progress: tools emit data-tool-progress events │
│  via stream (search phases, daemon init)        │
│                                                 │
│  Output: { response: string }                   │
└─────────────────────────────────────────────────┘
```

## Module Boundaries

### `webAgent` (in `web/index.ts`)
- **Interface**: `createAgent<string, WebAgentResult>({ id: "web", handler, ... })` registered in `packages/bundled-agents/src/registry.ts`.
- **Hides**: three-tool routing, session lifecycle, artifact/outline ref propagation, daemon cleanup.
- **Trust contract**: caller sends a prompt; receives `{ response }` + artifact/outline refs attached via `ok(data, extras)`. Failures return `err(reason)` — no uncaught throws.

### `createBrowseTool` (in `web/tools/browse.ts`)
- **Interface**: `createBrowseTool(stream, sessionState, abortSignal) => Tool`. Plus `stopSession(sessionState): Promise<void>`.
- **Hides**: which CLI binary backs the tool (`agent-browser`), session naming, daemon lifecycle (auto-spawn on first command), `--auto-connect` env passthrough, command tokenization.
- **Trust contract**: the tool exposes one `command` string input and returns command output as a string. Errors are returned as tool output (not thrown) so the LLM can react. `stopSession` is idempotent and no-ops when `browse` was never called.

### `createFetchTool` (in `web/tools/fetch.ts`)
- **Interface**: `createFetchTool() => Tool`.
- **Hides**: HTTP client choice, HTML→markdown conversion (TurndownService), size/timeout enforcement.
- **Trust contract**: given a URL, returns string content or a descriptive error string. No progress events. Content quality judgment (empty/thin/JS-rendered) is deferred to the outer LLM.

### `createSearchTool` (in `web/tools/search.ts` + `search-execution.ts`)
- **Interface**: `createSearchTool(ctx, { artifactRefs, outlineRefs }) => Tool`.
- **Hides**: Parallel API client construction, query decomposition LLM call, multi-query search execution, synthesis LLM call, artifact POST, outline-ref construction.
- **Trust contract**: returns `{ summary, sources: Array<{url, title}> }` to the outer loop as stringified JSON. Side-effects artifact and outline refs through the closure-mutation arrays the handler passes in. If the pipeline fails internally, returns a descriptive error string — doesn't throw past the `execute` boundary.

### `getWebAgentPrompt` (in `web/prompts.ts`)
- **Interface**: `getWebAgentPrompt(): string`.
- **Hides**: skill file locations, which reference files are embedded, prompt section ordering.
- **Trust contract**: returns a complete system prompt suitable for `generateText`. Module-load-time failures (missing skill files) throw at import — fails fast in CI.

## Implementation Tasks

Ten tasks. Phase 0 is fully parallel. Phase 1 converges. Phases 2-3 are sequential.

### T1 — Package scaffold
- **Inputs**: None.
- **Outputs**: `packages/bundled-agents/src/web/index.ts` with `createAgent` call wired to a handler stub that returns `err("not implemented")`. Exports `webAgent`, `WebOutputSchema`, `WebAgentResult`. Added to `packages/bundled-agents/src/index.ts` barrel and `packages/bundled-agents/src/registry.ts` `bundledAgents` array.
- **AC**: `deno task typecheck` passes. Agent appears in registry. Handler returns `err(...)` when invoked (no crash).
- **References**: `@atlas/agent-sdk` `createAgent`, `ok`, `err`; existing simple bundled agent (e.g., `gh/`) as structural reference.

### T2 — CLI argument utilities
- **Inputs**: None.
- **Outputs**: `packages/bundled-agents/src/web/tools/agent-browser-utils.ts` with:
  - `parseCommandArgs(command: string): string[]` — single-char-by-char tokenizer handling `"…"` and `'…'` quotes (single-quote support is required for `eval 'document.querySelector("x")'` cases).
  - `formatExecError(error: unknown): string` — extracts stderr, signal/timeout info, exit code into a human-readable error string.
- **Tests**: `agent-browser-utils.test.ts` covering empty string, unquoted args, double-quoted arg containing spaces, single-quoted arg containing double quotes, adjacent quoted groups, timeout errors (`killed` property), non-zero exit, bare Error instances.
- **AC**: unit tests pass. No external dependencies — pure string logic.

### T3 — Fetch tool
- **Inputs**: None (standalone).
- **Outputs**: `packages/bundled-agents/src/web/tools/fetch.ts` exporting `createFetchTool() => Tool`.
  - Uses global `fetch()`.
  - Converts HTML→markdown via `TurndownService` (add `turndown` + `@types/turndown` to `packages/bundled-agents/package.json` if not already present).
  - 5 MB response size cap (reject past that).
  - 30 s timeout (via `AbortController`).
  - Input schema: `{ url: string.url(), format?: "markdown" | "text" }` — markdown default.
  - Returns string content or a prefixed error string (never throws past the tool boundary).
- **Tests**: `fetch.test.ts` — mock `global.fetch`, cover: 200 HTML → markdown, 200 text/plain → raw text, 404 → error string, timeout → error string, response > 5 MB → error string.
- **AC**: all tests pass. No cross-package imports.

### T4 — Prompt composition
- **Inputs**: skill reference files at `.claude/skills/agent-browser/references/{commands,snapshot-refs,session-management}.md` (check they exist at module-load resolution time).
- **Outputs**: `packages/bundled-agents/src/web/prompts.ts` exporting `getWebAgentPrompt(): string`.
  - Reads three skill files via `readFileSync(new URL("…", import.meta.url), "utf8")` at module load.
  - Composes the prompt in sections:
    1. **Role** — "You are a web agent. You complete tasks on the web."
    2. **Tool selection heuristics** (three tools): fetch first if URL, search for discovery, browse for interaction. Combine freely. One sentence per heuristic.
    3. **Browse tool preamble** — one paragraph: "Each `browse` call runs one `agent-browser` command. Session is handled by the orchestrator. Command reference follows."
    4. **`commands.md`** — embedded verbatim.
    5. **`snapshot-refs.md`** — embedded verbatim.
    6. **`session-management.md`** — embedded verbatim.
    7. **Stuck detection** — 2 failures on the same action → try something different; 3 different approaches all failed → report and stop; 3 consecutive errors → browser session unavailable, stop.
    8. **Efficiency** — don't over-browse, scoped snapshots over screenshots, extract URLs from link snapshots, don't over-wait.
    9. **Task completion** — summarize what was done.
- **Explicitly excluded**: no credential lookup guidance, no form-submit-button Steel workaround, no `authentication.md` embed.
- **AC**: `getWebAgentPrompt()` returns a non-empty string. Module-load throws with a clear message if any of the three skill files are missing. `deno task typecheck` passes.

### T5 — Browse tool (depends on T2)
- **Inputs**: `parseCommandArgs` + `formatExecError` from T2.
- **Outputs**: `packages/bundled-agents/src/web/tools/browse.ts` exporting:
  - `interface SessionState { sessionName: string; daemonStarted: boolean }`.
  - `createBrowseTool(stream: StreamEmitter | undefined, sessionState: SessionState, abortSignal?: AbortSignal) => Tool`.
  - `stopSession(sessionState: SessionState): Promise<void>`.
- **Behavior**:
  - Every call: `execFile("agent-browser", ["--session", sessionState.sessionName, ...parseCommandArgs(command)], { timeout: 30_000, signal: abortSignal })`. Environment is inherited by default — `AGENT_BROWSER_AUTO_CONNECT=1` flows to the subprocess automatically.
  - On first successful call: emit progress (`{ type: "data-tool-progress", data: { toolName: "Web", content: "Starting browser..." } }`) and set `sessionState.daemonStarted = true`.
  - On non-zero exit or timeout: return `formatExecError(error)` as the tool output string. Do not throw.
  - `stopSession` is a no-op when `!daemonStarted`; otherwise runs `execFile("agent-browser", ["--session", sessionState.sessionName, "close"], { timeout: 5_000 })` and swallows errors (daemon may already be dead).
- **Tests**: `browse.test.ts` — mock `execFile`. Cover: first call emits progress + sets flag; subsequent calls don't re-emit; successful command returns stdout; failed command returns `formatExecError` output; timeout returns "command timed out"; `stopSession` no-ops when daemon not started; `stopSession` swallows close errors.
- **AC**: all tests pass. No direct knowledge of agent-browser flags beyond `--session` and `close`.

### T6 — Search tool (depends on T1 for types)
- **Inputs**: `WebOutputSchema` type environment from T1; `@atlas/agent-sdk` refs (`ArtifactRef`, `OutlineRef`, `StreamEmitter`).
- **Outputs**: two files.
  - `packages/bundled-agents/src/web/tools/search-execution.ts` — Parallel API call with objective condensing (if objective > 4500 chars, condense via `smallLLM` from `@atlas/llm`). Builds `SourcePolicy` from analysis (include/excludeDomains, after_date from recencyDays). Calls `client.beta.search({ mode: "agentic", objective, search_queries, source_policy, max_results })`. Filters stale results client-side.
  - `packages/bundled-agents/src/web/tools/search.ts` exporting `createSearchTool(ctx, refs) => Tool`:
    - **Phase 1 — Query analysis**: `generateText` with `google:gemini-3.1-pro-preview`, `toolChoice: "required"`, two tools: `analyzeQuery` (returns `{ complexity, searchQueries, includeDomains?, excludeDomains?, recencyDays? }`) and `failQuery` (refuses unsearchable input). `temperature: 0.3`.
    - **Phase 2 — Execute**: call `executeSearch` with the analysis.
    - **Phase 3 — Synthesize**: `generateObject` with `google:gemini-3.1-pro-preview`, `temperature: 0.3`, `maxOutputTokens: 8192`, `experimental_repairText: repairJson`. Output schema `{ title, response, sources, summary }`.
    - **Phase 4 — Artifact creation**: POST `client.artifactsStorage.index.$post()` with `{ title, data: { type: "web-search", version: 1, data: { response, sources } }, summary, workspaceId, chatId }`. On success, push to `refs.artifactRefs` ([{ id, type: "web-search", summary }]) and `refs.outlineRefs` ([{ service: "internal", title, content: title, artifactId, artifactLabel: "View Report", type: "web-search" }]).
    - **Progress events**: "Analyzing query…" → "Searching N queries…" → "Synthesizing results…".
    - **Returns to outer loop**: stringified JSON `{ summary, sources: [{ url, title }] }`.
  - Requires env: `PARALLEL_API_KEY` OR `FRIDAY_GATEWAY_URL` + `ATLAS_KEY`. Declare in agent's `environment` config in T1's `createAgent` call (update in T7).
- **Tests**: `search.test.ts` — mock `ai` (`generateText`, `generateObject`), `@atlas/llm` (registry, traceModel), `@atlas/client/v2` artifactsStorage, `parallel-web` constructor, `./search-execution.ts` executeSearch. Cover: full-pipeline happy path (all four phases, refs pushed); analysis returns `failQuery` (tool returns refusal string, no refs pushed); search returns empty results (tool returns "no results" string); synthesis fails to parse JSON (repairJson handles it).
- **AC**: all tests pass. Dependencies (`parallel-web`, `ai`, `@atlas/llm`, `@atlas/client/v2`, `@atlas/agent-sdk`) are declared in `packages/bundled-agents/package.json`.

### T7 — Handler wiring (depends on T1, T3, T4, T5, T6)
- **Inputs**: All Phase 0-1 components.
- **Outputs**: Complete `packages/bundled-agents/src/web/index.ts` handler. Replaces the T1 stub.
- **Behavior**:
  ```typescript
  handler: async (prompt, { session, logger, stream, config, abortSignal }) => {
    logger.info("Starting web agent", { prompt: prompt.slice(0, 200) });

    const artifactRefs: ArtifactRef[] = [];
    const outlineRefs: OutlineRef[] = [];
    const sessionState: SessionState = {
      sessionName: `atlas-web-${crypto.randomUUID().slice(0, 8)}`,
      daemonStarted: false,
    };

    try {
      const result = await generateText({
        model: traceModel(registry.languageModel("google:gemini-3.1-pro-preview")),
        messages: [
          { role: "system", content: getWebAgentPrompt() },
          temporalGroundingMessage(),
          { role: "user", content: prompt },
        ],
        tools: {
          search: createSearchTool({ session, stream, logger, config, abortSignal }, { artifactRefs, outlineRefs }),
          fetch:  createFetchTool(),
          browse: createBrowseTool(stream, sessionState, abortSignal),
        },
        stopWhen: stepCountIs(300),
        maxRetries: 3,
        abortSignal,
      });

      return ok(
        { response: result.text || "Web task completed but no summary generated." },
        { artifactRefs, outlineRefs },
      );
    } catch (error) {
      logger.error("Web agent failed", { error });
      return err(stringifyError(error));
    } finally {
      await stopSession(sessionState);
    }
  }
  ```
- **Agent metadata** (in same `createAgent` call):
  - `description`: "Search the web, read pages, and interact with websites in a real browser. Combines multi-query research (with sourced report artifacts), URL reading, and browser automation (login, forms, clicks, JS-rendered content). USE FOR: web research, finding current information, reading JS-rendered pages, logging into sites, filling forms, completing multi-step web workflows, any task requiring both search and browser interaction."
  - `constraints`: "Requires `agent-browser` CLI for browser interaction and Parallel API access (`PARALLEL_API_KEY` or `FRIDAY_GATEWAY_URL`+`ATLAS_KEY`) for search. Set `AGENT_BROWSER_AUTO_CONNECT=1` to attach to a running Chrome; otherwise an isolated Chrome is spawned per invocation. Cannot bypass CAPTCHAs. For simple static URL reads, built-in webfetch suffices — use this agent when you need search synthesis, page interaction, or JS-rendered content."
  - `expertise.examples`: ["Research the latest developments in quantum computing and summarize key breakthroughs", "Read the content at https://example.com/docs and extract the API reference", "Find the best-rated restaurant in SF and make a reservation", "Extract the top 5 headlines from Hacker News"]
  - `environment`: declare env var dependencies for search (Parallel) and note auto-connect is opt-in.
- **AC**: `deno task typecheck` passes. Agent can be invoked end-to-end against a test prompt (smoke test via `deno task atlas prompt "ping"` or direct handler call in a scratch test).

### T8 — Retire predecessor agents + MCP entry
- **Inputs**: T7 complete (web agent is functional).
- **Outputs**:
  - Delete `packages/bundled-agents/src/web-search/` and its exports from `index.ts` + registry entry.
  - Delete `packages/bundled-agents/src/browser/` and its exports from `index.ts` + registry entry.
  - Remove `playwright` entry from `packages/core/src/mcp-registry/registry-consolidated.ts`.
  - Delete `tools/evals/agents/browser/` and `tools/evals/agents/research/`.
- **AC**: `deno task typecheck` passes. No dangling imports. The `bundledAgents` array in registry contains `webAgent` and no `webSearchAgent` or `browserAgent`.
- **Note**: do NOT add a backwards-compat re-export layer. Clean retirement — if anything outside this package imports `webSearchAgent` or `browserAgent`, fix the caller.

### T9 — Eval suite
- **Inputs**: T7, T8 complete.
- **Outputs**: `tools/evals/agents/web/web.eval.ts` exporting `evals: EvalRegistration[]`. ~15 cases across four categories.
  - **Pure search (5 cases)**: information retrieval, fact-checking, multi-source synthesis, entity coverage, recency-sensitive query. Score: `task-complete` (LLM judge), `synthesis-quality` (LLM judge on source attribution + factual accuracy + report structure), `tool-selection` (expected: `search`).
  - **Pure browser (4 cases)**: Wikipedia info extraction, Hacker News top-N headlines, static-site content extraction requiring JS render, form filling on a public sandbox (e.g., httpbin.org/forms/post). Score: `task-complete`, `step-efficiency` (minSteps / actualSteps), `tool-selection` (expected: `browse`), `snapshot-before-interact` (verify snapshot before click/fill/type in trace). No login cases for MVP.
  - **Mixed mode (3 cases)**: search → browse a found URL; fetch → (empty) → escalate to browse; search → fetch a source URL → summarize. Score: `task-complete`, `tool-selection` (verify correct sequence).
  - **Decision quality (3 cases)**: given a known-static URL, verify fetch used (not browse); given a JS-rendered SPA URL, verify browse used after fetch returns thin content; given a "log into X" task, verify browse used from step 1 (assumes auto-connect or documented failure). Score: `tool-selection`, `step-efficiency`.
  - LLM judge model: `groq:openai/gpt-oss-120b` (match existing `llmJudge` helper).
  - Extract traces via `extractToolCalls` pattern for `tool-selection` + `snapshot-before-interact` custom scores.
- **AC**: `deno task evals run -t tools/evals/agents/web/web.eval.ts` runs end-to-end without harness errors. All 15 cases produce scores (pass/fail is fine — baseline is what we're capturing).

### T10 — Baseline capture
- **Inputs**: T9 complete.
- **Outputs**:
  - Run `deno task evals run -t tools/evals/agents/web/web.eval.ts --tag baseline`.
  - Record results summary (pass rate, per-dimension averages, known-failing cases with reasons) in `docs/learnings/2026-03-XX-web-agent-baseline.md`.
- **AC**: baseline metrics exist on disk. Regressions in future runs can be diffed against this tag via `deno task evals compare --before baseline --after <new-tag>`.

### Dependency graph

```
T1  T2  T3  T4      ← Phase 0 (parallel)
     │
     ▼
     T5              ← Phase 1a (depends on T2)
                        T6 depends on T1's types but can overlap with T5
T1 ─▶ T6             ← Phase 1b (depends on T1)
│ │ │ │ │
▼ ▼ ▼ ▼ ▼
    T7              ← Phase 2 (handler wiring, needs T1/T3/T4/T5/T6)
     │
     ▼
    T8              ← Phase 3 (retirement)
     │
     ▼
    T9              ← Evals
     │
     ▼
    T10             ← Baseline
```

T1-T6 can be six workers concurrent. Max parallelism on Phase 0 + T5/T6 cuts wall time significantly.

## Testing Decisions

### What makes a good test

Tests verify external behavior — did the agent produce the right output? did the tool return the right payload? — not implementation details like the specific tool the model chose. Tool choice is a means, not an end. Scoring dimensions like `tool-selection` check for gross pathologies (fetch-able URL sent to browser), not fine-grained routing.

### Unit tests

- `agent-browser-utils.test.ts` (T2): tokenizer + error formatter.
- `fetch.test.ts` (T3): HTTP + markdown conversion.
- `browse.test.ts` (T5): `execFile` shape, progress emission, cleanup idempotence.
- `search.test.ts` (T6): pipeline phases mocked; ref-push side effect verified.
- Model: match the `gh/agent.test.ts` scaffolding pattern.

### Evals

- One file: `tools/evals/agents/web/web.eval.ts`.
- ~15 cases across pure-search, pure-browser, mixed, decision-quality.
- Score dimensions: `task-complete`, `synthesis-quality` (search only), `step-efficiency`, `tool-selection`, `snapshot-before-interact`.
- LLM judge: `groq:openai/gpt-oss-120b` via existing `llmJudge` helper.
- Baseline tag captured in T10 for future regression diffs.

### Synthesis-quality risk

`google:gemini-3.1-pro-preview` is used for research synthesis. The `synthesis-quality` dimension explicitly validates source attribution, factual accuracy, and report structure. If baseline runs show systemic quality issues, consider swapping synthesis-only to `anthropic:claude-sonnet-4-6` while keeping Pro for the outer loop. Log as a follow-up, don't block T10.

## Out of Scope

- **Cost optimization / model downgrade**: Gemini Pro everywhere for MVP.
- **Session/cookie persistence across invocations**: sessions are unique per invocation; each run starts clean unless `AGENT_BROWSER_AUTO_CONNECT=1` attaches to user's Chrome.
- **Parallel browsing**: one session per agent invocation.
- **Smart retry/caching on fetch**: stays dumb HTTP.
- **Streaming search results**: search returns complete report.
- **Agent-browser auth vault / state save/load**: not wired for MVP. Authenticated workflows rely on auto-connect to user's Chrome.
- **Content quality heuristics on fetch**: LLM judges; no threshold-based detection.
- **Credential lookup tool**: no `lookup_credential` tool, no `~/.atlas/web-credentials.json`. Auth path = auto-connect or fail.
- **Playwright / Steel integrations**: not built.
- **Per-workspace auto-connect config**: env var only. Per-workspace control is YAGNI for MVP.
- **Login-flow evals**: dropped from MVP because no reliable credential source exists without auto-connect + live Chrome in CI.

## Key Decisions

### Deep module over shallow routing
The planner was making bad decisions because it was exposed to implementation details. Absorbing search, fetch, and browser into one agent moves routing to where it belongs — inside the agent that understands the web.

### Single LLM loop over coordinator + sub-agents
One `generateText` loop with all tools. The `search` tool encapsulates its own LLM calls internally, so the outer loop doesn't need to be smart about search strategy.

### Gemini Pro everywhere
One model family simplifies dependencies. Pro is smart enough for routing and capable enough for browser interaction. `synthesis-quality` eval dimension validates the research use case.

### Heuristic guidelines over strict escalation
The prompt teaches rules of thumb, not rigid rules. Pro is smart enough for judgment calls.

### `agent-browser` as the browser backend
Native-Rust CLI with a daemon model. 100% command parity with the existing prompt surface (`open`, `snapshot -i`, `click @eN`, `fill`, `find role`, etc.). Auto-connect to a running Chrome via `AGENT_BROWSER_AUTO_CONNECT=1` is the MVP auth story.

### Env-only auto-connect passthrough
No wrapper code for auto-connect. `execFile` inherits env by default; `agent-browser` reads `AGENT_BROWSER_AUTO_CONNECT=1` natively. Workspace authors flip the env in their launch config. Per-workspace flags are YAGNI.

### Skill-sourced CLI reference embedded at module load
`prompts.ts` reads `commands.md`, `snapshot-refs.md`, `session-management.md` from `.claude/skills/agent-browser/references/` via `readFileSync` at module load. Prompt stays fresh when the skill updates. Failures throw at import time (fail fast in CI).

### Unique session name per invocation + close in finally
`atlas-web-<8 hex>` — zero state bleed across invocations, no concurrent-run collisions. `daemonStarted` flag makes `close` a no-op for pure search/fetch tasks.

### No credential lookup
No `lookup_credential` tool, no `~/.atlas/web-credentials.json`. Auth path is auto-connect to logged-in Chrome or the task fails cleanly. Cuts a whole tool, a file, a prompt section, and a config file dependency. If production needs programmatic credentials later, agent-browser's encrypted auth vault is a viable extension point — not MVP.

### Lazy daemon, `close` in finally
No explicit start — `agent-browser` auto-spawns its daemon on first command. `close` kills it. Pure search/fetch tasks never touch the daemon.

### Clean retirement, no compat shim
Old `web-search` and `browser` agents are removed outright in T8. No `compat.ts` re-exports. Consumers update imports.

### Planner description with negative routing
The `description` includes "for simple static URL reads, built-in webfetch suffices" — prevents over-routing trivial reads to the full web agent. The `constraints` field documents the `AGENT_BROWSER_AUTO_CONNECT` knob to the planner.

### Mutable closure for artifact + outline refs
Handler creates `artifactRefs[]` / `outlineRefs[]`. Search tool pushes during execution. Handler returns them in `ok(data, extras)`. Matches existing bundled-agent patterns; keeps ref propagation out of the `generateText` return path.

### Standalone fetch implementation
Self-contained HTTP GET + TurndownService, not a wrapper around the MCP fetch tool. Independent dependency graph, can evolve separately. Core logic is 30 lines.

### Consolidated eval directory
One `tools/evals/agents/web/` directory. Four eval categories in one suite file. Old `browser/` and `research/` eval directories deleted in T8.

### Tool-owned progress streaming
Each tool emits `data-tool-progress` events internally. Search: analyzing → searching → synthesizing. Browse: on daemon start. Fetch: silent (fast enough).

## Further Notes

The deep modules principle (Ousterhout): Unix file I/O has five functions hiding enormous complexity. The web agent has one interface to the planner hiding the complexity of choosing between search engines, HTTP fetchers, and browser drivers. The `search` tool is itself a deep module within — the outer LLM calls `search(objective)` and gets back a synthesized report with structured sources. It doesn't know or care about query decomposition, parallel search, or source synthesis.

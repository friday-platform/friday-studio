<!-- Migration plan - 2026-04-15 - Assumes branch already has the unified web agent with Steel backend. Describes the minimal delta to swap Steel → agent-browser. Intended to be executed by a loop on the `declaw` branch after the unified-agent work is copied over from `agent-browser-for-real`. -->

# Migration: Steel → agent-browser

Intended branch: `declaw` (after unified web agent is copied over from `agent-browser-for-real`).

## Starting State (assumed)

- `packages/bundled-agents/src/web/` exists with the unified web agent (id: `web`).
- Handler in `web/index.ts` wires four tools: `search`, `fetch`, `browse`, `lookup_credential`.
- `web/tools/browse.ts` shells out to `steel browser start` / `steel browser <cmd> --session <id>` / `steel browser stop --session <id>` via `execFile`.
- `web/tools/steel-utils.ts` holds `parseCommandArgs` + `formatExecError`.
- `web/tools/credential.ts` holds the credential-vault lookup tool.
- `web/prompts.ts` contains a hand-written Steel CLI reference (~170 lines), a credentials section, and a ~50-line "Form Submit Buttons (Known Issue)" section.
- `web/compat.ts` re-exports `webAgent` under legacy `browserAgent` / `webSearchAgent` names.
- `tools/evals/agents/web/web.eval.ts` includes login-flow cases that depend on `lookup_credential`.
- `packages/bundled-agents/src/browser/` and `/web-search/` are already deleted.
- `.claude/skills/agent-browser/` exists with `references/commands.md`, `references/snapshot-refs.md`, `references/session-management.md`, and others.

## Target State

- `browse.ts` shells out to `agent-browser --session <name> <cmd>` with lazy daemon spawn and `close` in `finally`.
- `AGENT_BROWSER_AUTO_CONNECT=1` env var flows through to the subprocess (no wrapper code).
- `prompts.ts` reads skill reference files at module load; three tools only; no credentials section; no form-submit-button workaround.
- `lookup_credential` tool, its tests, and its handler wiring are deleted.
- Agent description + constraints mention `agent-browser` and the `AGENT_BROWSER_AUTO_CONNECT` env var.
- Login-flow eval cases are removed.
- `compat.ts` remains unchanged (re-exports still valid).

## Non-Goals

- Replacing any part of the search or fetch tools.
- Introducing agent-browser's auth vault, state save/load, or `--profile` flags.
- Adding a workspace.yml config knob for auto-connect (env var only).
- Re-introducing `compat.ts` removal — legacy re-exports stay.

## Tasks

Ordered for a sequential loop. Parallelism is possible across D3/D5/D6, but sequential is simpler and each task is small.

### D1 — Rename `steel-utils.ts` → `agent-browser-utils.ts`

- **Files**:
  - Rename `packages/bundled-agents/src/web/tools/steel-utils.ts` → `agent-browser-utils.ts`.
  - Update the `./steel-utils.ts` import in `packages/bundled-agents/src/web/tools/browse.ts` to `./agent-browser-utils.ts`.
- **No content changes** to the utility functions themselves (`parseCommandArgs` + `formatExecError` are CLI-agnostic).
- **AC**: `deno task typecheck` passes. No references to `steel-utils` remain anywhere in the repo.

### D2 — Rewrite `browse.ts` for agent-browser

- **File**: `packages/bundled-agents/src/web/tools/browse.ts` — full rewrite.
- **Changes**:
  - `SessionState` shape changes to `{ sessionName: string; daemonStarted: boolean }`. `sessionName` is set by the handler (D4), not allocated inside `ensureSession`.
  - Delete the `ensureSession` function entirely — daemon auto-spawns on first `agent-browser` command.
  - `execute` invocation changes to `execFile("agent-browser", ["--session", sessionState.sessionName, ...parseCommandArgs(command)], { timeout: COMMAND_TIMEOUT_MS, signal: abortSignal })`.
  - On the first successful execution, emit `{ type: "data-tool-progress", data: { toolName: "Web", content: "Starting browser..." } }` and set `sessionState.daemonStarted = true`. Progress should fire once per invocation, not on every call.
  - `stopSession` renamed semantically (same name is fine): no-op if `!sessionState.daemonStarted`; otherwise `execFile("agent-browser", ["--session", sessionState.sessionName, "close"], { timeout: 5_000 })` with a `try { … } catch {}` swallow. Reset `daemonStarted = false` after close.
- **No code** reads or forwards `AGENT_BROWSER_AUTO_CONNECT` — env is inherited by `execFile` by default. `agent-browser` picks it up on its own.
- **Tests**: update `browse.test.ts` if it exists (re-point mocks to `agent-browser` argv shape, verify new progress semantics, verify `stopSession` no-op when daemon never started). If no test exists, add one matching the pattern in `packages/bundled-agents/src/gh/agent.test.ts` (mock `execFile`, verify argv and side effects).
- **AC**: `deno task typecheck` passes; unit tests pass; no `steel` string literal anywhere in `browse.ts`.

### D3 — Delete credential tool

- **Files**:
  - Delete `packages/bundled-agents/src/web/tools/credential.ts`.
  - Delete any `credential.test.ts` or test file exclusively covering `createCredentialTool`.
- **AC**: `deno task typecheck` fails (D4 fixes) or passes (if `index.ts` already updated). Do not attempt to pass typecheck on D3 alone — the wiring in `index.ts` will be stale until D4.

### D4 — Update `index.ts` handler, metadata, and session allocation

- **File**: `packages/bundled-agents/src/web/index.ts`.
- **Changes**:
  1. Remove the `createCredentialTool` import.
  2. Remove the `lookup_credential` entry from the `tools` object in the `generateText` call.
  3. Change `sessionState` initialization from `{ sessionId: null }` to `{ sessionName: \`atlas-web-${crypto.randomUUID().slice(0, 8)}\`, daemonStarted: false }`. Add `import { randomUUID } from "node:crypto"` at the top if not already imported.
  4. Update `description` to replace "Steel CLI" phrasing — new constraints value: "Requires `agent-browser` CLI for browser interaction and Parallel API access (`PARALLEL_API_KEY` or `FRIDAY_GATEWAY_URL`+`ATLAS_KEY`) for search. Set `AGENT_BROWSER_AUTO_CONNECT=1` to attach to a running Chrome; otherwise an isolated Chrome is spawned per invocation. Cannot bypass CAPTCHAs. For simple static URL reads, built-in webfetch suffices — use this agent when you need search synthesis, page interaction, or JS-rendered content."
  5. In `expertise.examples`, replace `"Log into my account on example.com and check the dashboard"` with `"Extract the top 5 headlines from Hacker News"`.
- **AC**: `deno task typecheck` passes across the whole workspace. No references to `createCredentialTool`, `CredentialTool`, or `web-credentials.json` remain in `src/web/`.

### D5 — Rewrite `prompts.ts` to embed skill references

- **File**: `packages/bundled-agents/src/web/prompts.ts` — full rewrite.
- **Module-load reads**:
  ```typescript
  import { readFileSync } from "node:fs";
  const SKILL_ROOT = new URL(
    "../../../../.claude/skills/agent-browser/references/",
    import.meta.url,
  );
  const commandsRef = readFileSync(new URL("commands.md", SKILL_ROOT), "utf8");
  const snapshotRef = readFileSync(new URL("snapshot-refs.md", SKILL_ROOT), "utf8");
  const sessionRef  = readFileSync(new URL("session-management.md", SKILL_ROOT), "utf8");
  ```
- **`getWebAgentPrompt()` returns a composed string**:
  1. Role — "You are a web agent. You complete tasks on the web."
  2. Tool selection heuristics (three tools: `search`, `fetch`, `browse`). Same heuristic content as today minus any `lookup_credential` mentions.
  3. Browse tool preamble — one paragraph explaining that each `browse` call runs one `agent-browser` command, session is handled by the orchestrator, and the command reference follows.
  4. `${commandsRef}` — embedded verbatim.
  5. `${snapshotRef}` — embedded verbatim.
  6. `${sessionRef}` — embedded verbatim.
  7. Stuck detection — keep verbatim from today's prompt.
  8. Efficiency tips — keep verbatim from today's prompt.
  9. Task completion — keep verbatim.
- **Drop entirely**:
  - The "# Credentials" section.
  - The "Form Submit Buttons (Known Issue)" section (roughly 50 lines of Steel-specific CDP-click workaround).
  - Any `steel` string anywhere in the prompt.
- **Keep**:
  - The overall role framing and tool-routing guidelines.
  - Stuck detection, efficiency, task completion sections.
- **AC**: `getWebAgentPrompt()` returns non-empty string. Module import throws with a clear message if any of the three skill files are missing. `deno task typecheck` passes. `grep -ri "lookup_credential\|credentials.json\|Form Submit Buttons" packages/bundled-agents/src/web/prompts.ts` returns nothing.

### D6 — Drop login-flow eval cases

- **File**: `tools/evals/agents/web/web.eval.ts`.
- **Changes**: remove all cases that require `lookup_credential` or that navigate a login form (e.g., any Craigslist login/posting cases ported from the old browser evals). Identify by: case input mentions "log in" / "log into" / "sign in" / requires credentials from the vault, OR scoring uses a `used-credentials` dimension.
- **Keep**: all pure-search, pure-browser-without-auth, mixed-mode, decision-quality cases.
- **AC**: `deno task evals list | grep web` shows only non-auth cases. `grep -rE "lookup_credential|login|sign in" tools/evals/agents/web/web.eval.ts` returns no case definitions.

### D7 — Typecheck + lint + build + smoke test

- **Commands**:
  ```bash
  deno task typecheck
  deno task lint
  deno task atlas daemon stop      # if running
  deno task atlas daemon start --detached
  deno task atlas prompt "Go to https://example.com and tell me the main heading"
  deno task atlas daemon stop
  ```
- **AC**: typecheck clean, lint clean, daemon starts, smoke prompt returns a plausible response naming "Example Domain" (the known content at example.com). If `agent-browser` is not installed on the machine, this task blocks — install via `npm i -g agent-browser && agent-browser install` and retry.

### D8 — Baseline eval run

- **Commands**:
  ```bash
  deno task evals run -t tools/evals/agents/web/web.eval.ts --tag declaw-agent-browser-baseline
  deno task evals report --tag declaw-agent-browser-baseline
  ```
- **Deliverable**: `docs/learnings/2026-04-XX-agent-browser-baseline.md` with:
  - Pass rate per category (search / browser / mixed / decision).
  - Per-dimension averages (`task-complete`, `synthesis-quality`, `step-efficiency`, `tool-selection`, `snapshot-before-interact`).
  - Any known-failing cases with root-cause notes.
- **AC**: eval run completes end-to-end (all cases produce scores; failures are fine to document). Baseline file exists and is committed.

## Dependency Graph

```
D1 ─▶ D2
        │
D3 ─▶ D4
        │
D5      │
        │
D6      │
 │ │ │ │
 ▼ ▼ ▼ ▼
    D7
     │
     ▼
    D8
```

A sequential loop runs D1→D2→D3→D4→D5→D6→D7→D8. A parallel-capable loop can run {D1→D2}, {D3→D4}, D5, D6 as four concurrent strands, converging at D7.

## File Inventory

| File | Action | Task |
|---|---|---|
| `packages/bundled-agents/src/web/tools/steel-utils.ts` | Rename to `agent-browser-utils.ts` | D1 |
| `packages/bundled-agents/src/web/tools/browse.ts` | Rewrite | D2 |
| `packages/bundled-agents/src/web/tools/browse.test.ts` | Update/add | D2 |
| `packages/bundled-agents/src/web/tools/credential.ts` | Delete | D3 |
| `packages/bundled-agents/src/web/tools/credential.test.ts` (if exists) | Delete | D3 |
| `packages/bundled-agents/src/web/index.ts` | Edit (imports, tool wiring, session init, description, constraints, examples) | D4 |
| `packages/bundled-agents/src/web/prompts.ts` | Rewrite | D5 |
| `packages/bundled-agents/src/web/compat.ts` | Unchanged | — |
| `tools/evals/agents/web/web.eval.ts` | Edit (drop login cases) | D6 |
| `docs/learnings/2026-04-XX-agent-browser-baseline.md` | Create | D8 |

## Locked Design Decisions (for loop reference)

These were settled in the v5 plan and must not drift during loop implementation:

1. **Auto-connect config surface**: env var `AGENT_BROWSER_AUTO_CONNECT=1` only. No wrapper code, no workspace.yml knob, no CLI flag propagation. `execFile` inherits env by default.
2. **Skill reference embedding**: `readFileSync` at module load in `prompts.ts`. Three files: `commands.md`, `snapshot-refs.md`, `session-management.md`. Not `authentication.md` (conflicts with our former credential flow) or `profiling/proxy/video` (YAGNI).
3. **Session naming**: unique per invocation via `crypto.randomUUID().slice(0, 8)` with `atlas-web-` prefix. Allocated in the handler at start, not lazily in the tool.
4. **Cleanup**: `close` called in `finally`; guarded by `daemonStarted` flag so pure search/fetch tasks don't emit a spurious `close`.
5. **Credential tool**: deleted outright. No `lookup_credential`, no `~/.atlas/web-credentials.json`. Auth path is auto-connect to logged-in Chrome, or the task fails cleanly.
6. **Form-submit workaround**: dropped from prompt. It was a Steel-specific CDP-click hack. Re-add only if agent-browser evals show the same pathology.
7. **Compat layer**: `compat.ts` stays. Legacy `browserAgent` / `webSearchAgent` re-exports remain valid.
8. **No Playwright / Steel cleanup**: already done on the source branch. Do not re-introduce and do not search for residual references outside `web/`.

## Risks

- **agent-browser not installed** on the execution host: D7 blocks. The loop should surface a clear installation prompt, not retry silently.
- **Skill file paths drift**: if `.claude/skills/agent-browser/references/` moves or renames a file, D5's `readFileSync` throws at module load and the whole bundled-agents package fails to import. This is intentional (fail fast), but the loop must not silently skip D5 on a read error.
- **Eval regressions on `synthesis-quality`**: D8 baseline may show a drop from the pre-migration baseline if the Sonnet→Gemini Pro synthesis already landed but was never measured. This is not a migration failure — note it in the baseline doc and leave as a follow-up.
- **Concurrent agent invocations on shared hosts**: unique session names per invocation (decision #3) mitigates. No additional work required.

## Out of Scope

- Porting any agent-browser advanced features (auth vault, `state save/load`, annotated screenshots, content boundaries, allowed domains, action policies).
- Adding a config-layer auto-connect toggle (atlas.yml / workspace.yml field).
- Removing `compat.ts` or retiring backwards-compat re-exports.
- Changing the search pipeline, fetch tool, prompt-routing heuristics, or step budget.
- Changing the LLM model (Gemini Pro stays).
- Playwright MCP entry cleanup (already done on source branch).

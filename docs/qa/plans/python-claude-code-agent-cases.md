# QA Plan: Python Claude Code Agent

**Context**: `docs/plans/2026-04-05-claude-code-python-agent-design.v4.md`
**Branch**: `yaml-custom-agents`
**Date**: 2026-04-06
**PR under test**: https://github.com/friday-platform/friday-studio/pull/2688

## Prerequisites

- [ ] Daemon running: `deno task atlas daemon start --detached`
- [ ] `ANTHROPIC_API_KEY` configured (env or Link credentials)
- [ ] `GH_TOKEN` configured with repo access to `friday-platform/friday-studio`
- [ ] Python claude-code agent built and installed:
  ```bash
  deno task atlas agent build packages/sdk-python/tests/fixtures/claude-code-agent/
  # Verify: ls ~/.atlas/agents/claude-code@1.0.0/
  ```
- [ ] Example workspaces created (see Cases 1-2 setup)

---

## Cases

### 1. Smoke: Minimal chat with Python claude-code agent

**Setup**: Create a minimal workspace at `examples/claude-code-smoke/workspace.yml`:
```yaml
version: '1.0'
workspace:
  name: Claude Code Smoke Test
  description: Minimal workspace for testing Python claude-code agent via chat.

agents:
  claude-code:
    type: user
    agent: claude-code
    description: Autonomous coding agent via Python WASM.
    prompt: You are a coding assistant.
    env:
      ANTHROPIC_API_KEY: from_environment
      GH_TOKEN: from_environment
```

Then load it:
```bash
deno task atlas workspace create examples/claude-code-smoke/workspace.yml
```

**Trigger**: Send a simple coding prompt via workspace chat:
```bash
deno task atlas prompt --workspace <workspace-id> "Write a Python function that checks if a string is a palindrome. Return the code only."
```

**Expect**:
- Chat completes without error
- Response contains a Python palindrome function
- Session shows `claude-code` agent was invoked
- An artifact is created in the library (Claude Code Output)

**If broken**:
- `deno task atlas logs --since 60s --level error,warn` — check for WASM execution errors
- `deno task atlas session list` → `deno task atlas session get <id>` — check agent blocks for error status
- Verify agent is installed: `ls ~/.atlas/agents/claude-code@1.0.0/metadata.json`
- Check `code-agent-executor` logs for "LLM" or "provider" errors

---

### 2. Smoke: Verify progress streaming (SSE events)

**Trigger**: Same workspace as Case 1. Open the chat in the web UI at
`http://localhost:1420/spaces/<workspace-id>/chat` and send:
```
Read the README.md in the friday-platform/friday-studio repo and summarize what the project does.
```

**Expect**:
- While Claude Code is working, the UI shows real-time progress updates (e.g. "Reading README.md", "Cloning repository")
- These are tool-level progress events from `handleClaudeCodeGenerate` (not just the 3 phase-level "Analyzing task" / "Starting Claude Code" / "Saving artifact" messages)
- Progress updates appear in the agent's activity area, not as chat messages

**If broken**:
- `deno task atlas logs --since 120s` — look for `data-tool-progress` events
- Check `streamEmitter` is wired: grep for `streamEmitter` in code-agent-executor.ts
- Verify `smallLLM()` is being called (it generates the progress text)
- If only 3 phase messages appear: the host's `handleClaudeCodeGenerate` may not be routing correctly — check model ID starts with `claude-code:`

---

### 3. Smoke: Provider options forwarding

**Trigger**: Same workspace as Case 1. Send a high-effort prompt:
```
Clone https://github.com/friday-platform/friday-studio and analyze the architecture of the packages/ directory. Identify the dependency graph between packages and suggest improvements.
```

**Expect**:
- Pre-processing phase classifies this as `effort: "high"`
- Model selection picks `claude-code:claude-opus-4-6` (with `claude-sonnet-4-6` fallback)
- The prompt triggers actual repo cloning and multi-file analysis
- Response shows detailed architectural analysis

**If broken**:
- `deno task atlas logs --since 300s` — look for model ID in LLM request logs
- Check if `provider_options` includes `effort`, `systemPrompt`, `fallbackModel`
- If model is always sonnet: pre-processing may have failed silently (check for `"effort": "high"` in logs)
- If clone fails: check `GH_TOKEN` is in env, and provider receives it in `provider_options.env`

---

### 4. Critical: Workspace skills loaded into Claude Code session

**Setup**: Create a workspace at `examples/claude-code-with-skills/workspace.yml` that
declares skills and uses the Python claude-code agent:
```yaml
version: '1.0'
workspace:
  name: Claude Code + Skills
  description: Tests that workspace skills are resolved and available to the Python claude-code agent.

skills:
  - name: "@tempest/pr-code-review"

agents:
  claude-code:
    type: user
    agent: claude-code
    description: Code reviewer with workspace skills.
    prompt: You are a code reviewer. Use your loaded skills to guide your review.
    env:
      ANTHROPIC_API_KEY: from_environment
      GH_TOKEN: from_environment
```

Load it:
```bash
deno task atlas workspace create examples/claude-code-with-skills/workspace.yml
```

**Trigger**:
```bash
deno task atlas prompt --workspace <workspace-id> "Review the changes in https://github.com/friday-platform/friday-studio/pull/2688 using your pr-code-review skill."
```

**Expect**:
- The agent receives `skills` in `ctx.config` containing the resolved `@tempest/pr-code-review` skill
- Claude Code session has `.claude/skills/pr-code-review/SKILL.md` available
- The model loads the skill via the Skill tool before reviewing
- Review output follows the skill's structured format (verdict, findings, etc.)
- Response quality is noticeably different from a generic "review this PR" prompt (skill-specific structure)

**If broken** (likely — see Known Gap below):
- Check `ctx.config` contents: add temporary logging in agent.py to dump `ctx.config.keys()`
- `runtime.ts` `executeCodeAgent()` — does it resolve workspace skills before passing config?
- If `ctx.config["skills"]` is `None`: the host isn't passing resolved skills to code agents
- If skills are passed but Claude Code doesn't use them: check if skills are materialized to disk (`.claude/skills/`)
- The claude-code provider needs skills on the filesystem at `{cwd}/.claude/skills/` — passing them as data in `provider_options` is insufficient

**Known Gap**: As of this branch, `runtime.ts` does NOT resolve workspace skills for
user-type agents. The `executeCodeAgent()` path passes only the per-agent config from
`workspace.agents[id]`, not workspace-level skills. The TS bundled agent works because
it receives skills directly from `buildAgentContext()` and writes them to disk. Fix
needed in `runtime.ts` to:
1. Resolve workspace skills when `agent.useWorkspaceSkills === true`
2. Materialize skills to a temp directory (Python WASM agents can't write to disk)
3. Pass skill metadata in `config.skills` AND set `cwd` to the materialized directory

---

### 5. Pipeline: PR review with Python claude-code agent (parity with TS)

**Setup**: Create `examples/pr-review-python/workspace.yml` — a copy of
`examples/pr-review-github/workspace.yml` with the claude-code agent changed to
`type: user`:

```yaml
# Key difference from pr-review-github:
agents:
  claude-code:
    type: user           # ← Changed from "atlas"
    agent: claude-code   # ← Now routes to Python WASM agent
    description: >-
      Reviews code in a cloned repository using the Python claude-code agent.
    prompt: >-
      You are Code Reviewer. Reviews the pull request diff in the already-cloned
      repository. Reads full changed files for context and produces a structured
      review report with file-level and line-level findings.
    env:
      ANTHROPIC_API_KEY: from_environment
      GH_TOKEN: from_environment
```

Load and verify:
```bash
deno task atlas workspace create examples/pr-review-python/workspace.yml
```

**Trigger**: Fire the review-pr signal:
```bash
deno task atlas signal trigger review-pr --workspace <workspace-id> --data '{"pr_url": "https://github.com/friday-platform/friday-studio/pull/2688"}'
```

**Expect**:
- FSM pipeline progresses: `idle` → `step_clone_repo` → `step_review_pr` → `step_post_review` → `completed`
- `gh` agent clones the repo successfully (step 1)
- Python `claude-code` agent receives `workDir` from clone output (step 2)
- Agent skips repo cloning (workDir reuse), passes `cwd` in provider_options
- Agent produces structured review output (verdict, summary, findings)
- `gh` agent posts inline review comments on the PR (step 3)
- Session completes with final state

**If broken**:
- `deno task atlas session watch <id>` — monitor FSM state transitions
- `deno task atlas logs --since 300s` — check per-step logs
- If stuck at `step_review_pr`: Python agent execution failed — check WASM errors
- If review output is unstructured: `outputType: code-review-result` schema may not be reaching the agent as `output_schema`
- If no comments posted: check `step_post_review` input — review output may be in wrong format (envelope wrapping issue)
- Compare with TS version: run same PR through `pr-review-github` workspace

---

### 6. Result envelope: Artifact refs flow back to session

**Trigger**: After Case 1 or 5 completes, inspect the session result.

```bash
deno task atlas session get <session-id>
```

**Expect**:
- Agent block result contains `artifactRefs` array with at least one entry
- Each artifact ref has `id`, `type`, `summary` fields
- Artifact is accessible: `curl http://localhost:8080/api/artifacts/<artifact-id>`
- In the UI, the session detail page shows a link to the artifact

**If broken**:
- Check agent.py `_create_artifact()` — is the endpoint correct? (`/api/v1/artifacts`)
- Check host envelope parsing — does `code-agent-executor.ts` extract `artifactRefs` from the JSON envelope?
- `deno task atlas logs --since 60s` — look for artifact creation errors (404, 500)
- If artifact is created but refs are missing: check bridge serialization (`_serialize_extras` camelCase conversion)

---

### 7. Error handling: Missing ANTHROPIC_API_KEY

**Setup**: Create a workspace identical to Case 1 but without `ANTHROPIC_API_KEY` in env:
```yaml
agents:
  claude-code:
    type: user
    agent: claude-code
    description: Agent without API key
    prompt: Test
    env:
      GH_TOKEN: from_environment
      # No ANTHROPIC_API_KEY
```

**Trigger**:
```bash
deno task atlas prompt --workspace <workspace-id> "Hello"
```

**Expect**:
- Agent returns error: "ANTHROPIC_API_KEY not set. Connect Anthropic in Link."
- Session shows agent block with error status (not a crash/timeout)
- Error is user-friendly, not a stack trace

**If broken**:
- If agent crashes instead of returning error: check `err()` result path in bridge
- If timeout instead of error: the check may not be running before the LLM call

---

### 8. Graceful degradation: Pre-processing failure

**Trigger**: Send a prompt that's adversarial for extraction (unusual format):
```bash
deno task atlas prompt --workspace <workspace-id> "🎵 Just vibin, but also please write me a haiku about rust programming 🦀"
```

**Expect**:
- Agent doesn't crash even if Haiku extraction fails
- Falls back to original prompt verbatim and `effort: "medium"` default
- Still produces a response (the haiku)

**If broken**:
- `deno task atlas logs --since 60s` — look for extraction errors
- If agent crashes: the try/except around `generate_object` may not be catching correctly

---

## Smoke Candidates

- **Case 1** (minimal chat) — fundamental "does it work" check, durable
- **Case 4** (workspace skills) — critical feature, high signal
- **Case 7** (missing API key) — error path validation, fast

## Known Issues to Track

1. **Workspace skills not wired for code agents** (Case 4) — `runtime.ts` doesn't
   resolve workspace skills for `executeCodeAgent()` path. Needs host-side fix:
   skill resolution + filesystem materialization. This is the blocking issue for
   parity with the TS bundled agent.

2. **Skill materialization** — Even after fixing skill resolution, the host must
   write skills to `.claude/skills/` on disk because: (a) Python WASM can't write
   to filesystem, (b) the claude-code provider expects skills on disk at `{cwd}/.claude/skills/`.

3. **`provider_options.skills` is a no-op** — The `ai-sdk-provider-claude-code` doesn't
   handle a `skills` key in provider options. Skills must be on disk. The Python agent's
   `provider_options["skills"] = skills` line is dead code until materialization is fixed.

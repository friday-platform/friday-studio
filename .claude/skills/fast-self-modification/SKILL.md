---
name: fast-self-modification
description: "Run FAST-on-FAST self-modification loops safely. Encodes the contracts, agent-type rules, concurrency guards, and failure-mode-to-fix mapping learned from running the OpenClaw parity plan against the atlas monorepo via FAST workspaces. Attach to any system workspace (workspace-improver, session-reflector, parity-plan-exec) that uses architect → coder → reviewer pipelines against on-disk source."
user-invocable: false
---

# FAST Self-Modification Loop

This skill encodes what you need to know to run FAST workspaces that
modify FAST itself — or any target repo — via an architect → coder →
reviewer FSM pipeline with data-contract gates.

The rules below come from real iterations of running the OpenClaw
parity plan. Each rule has an origin story and a structural fix.
They are not opinions; they are failure modes that will happen
deterministically if you skip them.

## Core principle

**Data contracts are the only stable way to force LLM-backed agents
to do the right thing.** Prompts drift across models, context
sizes, and prompt-engineer revisions. A required schema field that
cannot be produced without the agent having done the right thing is
the only reliable gate.

When an agent fails a contract, the failure is *diagnosable*. When
an agent satisfies a loose prompt with plausible-looking drift, the
failure is *invisible*. Prefer diagnosable failure over invisible
drift, every time.

## Five rules for self-modification pipelines

### Rule 1: Evidence-of-reading beats instructions-to-read

SKILL.md or prompt text that says "read the plan first" will be
ignored by approximately 100% of LLM-backed agents on the first
try. The structural fix is to require verbatim citations in the
output contract:

```yaml
documentTypes:
  design-memo-result:
    type: object
    properties:
      plan_citations:
        type: array
        minItems: 1
        items:
          type: object
          properties:
            file: { type: string }
            line_start: { type: integer }
            line_end: { type: integer }
            verbatim: { type: string }
          required: [file, verbatim]
```

The architect cannot return a valid memo without populating this
field. If the architect can't read the file, it returns a placeholder
citation — which is a legible diagnostic, not silent drift.

**Origin:** Run 1 of the parity plan had a prompt that said "read
the plan." The architect invented plausible-looking interfaces from
keywords in the task brief. The reviewer approved them by comparing
files to the (wrong) memo. 8 interface drift points, all critical.
Fixed by adding required `plan_citations`.

### Rule 2: Review against the source of truth, not the intermediate artifact

Reviewer agents that compare the coder's output to the architect's
memo will rubber-stamp drift if the memo is wrong. The reviewer
must read the source of truth directly.

Reviewer contract must require a `plan_line` (or equivalent source
citation) on every finding:

```yaml
review-result:
  properties:
    findings:
      items:
        properties:
          plan_line:
            type: string
            description: Required citation — e.g. "parity-plan.md:582-634"
        required: [severity, description, plan_line]
```

A finding without a citation is invalid. The data contract rejects
the reviewer's output if it didn't do its job.

**Origin:** Run 1's reviewer APPROVED fundamentally wrong interfaces
because it cross-referenced files to the (wrong) memo. Fixed by
requiring `plan_line` on every finding + pointing the reviewer
prompt at the source document, not the memo.

### Rule 3: LLM bundled agents have no filesystem access

`type: llm` in `workspace.yml` gets you a conversation-wrapper agent
with `ctx.llm` but **no fs tools** and **no skill content injection
into its system prompt**. If your step needs to read files, read
skills as reference material, or cross-reference on-disk content,
use `type: atlas` with `agent: claude-code` — the bundled Claude
Code agent, which runs inside a sandbox with real fs/shell access.

| Need | Agent type | Notes |
|---|---|---|
| Structured output from inline prompt content only | `type: llm` | Fast, cheap, no fs, no skill content |
| Read files, run deno check, multi-turn code work | `type: atlas, agent: claude-code` | Has fs/shell/tools, expensive |
| Cross-reference on-disk files against a spec (reviewer) | `type: atlas, agent: claude-code` | **Mandatory** — llm type will return "I need to read the file first" |
| Decide task design from inline plan excerpts (architect) | `type: llm` | Works if excerpts fit in ~10KB prompt |

**Origin:** Run 2's architect returned `plan_citations: [{verbatim: "placeholder — skill must be loaded first"}]` — the LLM agent knew it was supposed to have context but couldn't reach it. Fixed by embedding plan excerpts directly in the architect's prompt field. Run 3's reviewer returned BLOCK with `"I need to read the actual plan file and the coder's written files"` — same failure mode. Fixed by switching reviewer to `type: atlas, agent: claude-code`.

### Rule 4: Embed reference material into the prompt, don't rely on skill injection

For `type: llm` agents, the workspace-level `skills:` declaration
does **not** auto-inject skill content into the agent's system
prompt. The skill file is uploaded and resolved, but the agent
can't see it. To give an LLM agent reference material, put it
directly in the `agents.<id>.config.prompt` field.

This sounds wasteful (the prompt can be 7KB+) but works reliably
and is within token budget for modern sonnet/opus models. A 7KB
architect prompt with embedded TypeScript interface declarations
runs fine and produces correct verbatim citations.

For `type: atlas, agent: claude-code` agents, the skill mechanism
does work — the skill is written to the claude-code sandbox and
the agent can read it from there. Use skills for claude-code; use
embedded prompt content for llm.

**Origin:** Run 2 had a published `@tempest/parity-plan-context`
skill referencing the plan. The architect couldn't see it. Fixed
by moving the skill's reference content into the architect's
`config.prompt` field directly. Size jumped to 7KB; no issues.

### Rule 5: Concurrent sessions on the same workspace race

Signal POSTs that time out or are retried can spawn multiple FSM
executions on the same workspace. An autonomous loop firing triggers
without a concurrency guard WILL produce overlapping runs that
write to the same files and persist incompatible states.

Mitigation (until FSM-level guards exist): before each trigger,
query `GET /api/sessions?workspaceId=<id>&limit=5` and reject if any
session is `status: active`. Or sequence triggers through a queue
that enforces one-at-a-time per workspace.

Long-term fix: FSM `idle → trigger` transition should guard on
"no active session on this workspace+job" and either queue, reject,
or kill the prior session.

**Origin:** Run 1 accidentally fired two signals 2 minutes apart
because the first HTTP POST was blocking on FSM completion and I
retried. Both sessions executed concurrently, both wrote the same
files. A human noticed; an autonomous loop wouldn't.

## Agent-type decision tree

```
Does the step need to read files from the mounted repo?
├── YES → type: atlas, agent: claude-code
└── NO
    ├── Does the step need to cross-reference a spec?
    │   ├── YES, and the spec fits in <10KB → type: llm with embedded prompt
    │   └── YES, spec is bigger → type: atlas, agent: claude-code
    └── Is it pure structured output from the task input?
        └── type: llm, inline prompt
```

## FSM shape for self-modification pipelines

A reusable pipeline shape. States in order:

1. **`idle`** — awaits trigger signal, cleans per-run state
2. **`step_research`** — architect produces design memo with
   required `plan_citations`. Data contract rejects empty or
   placeholder citations. Guard: `plan_citations.length >= 1`.
3. **`step_implement`** — coder writes files per memo.
   `deno check` and `deno lint` must pass. Output includes
   `files_written`, `deno_check_passed`, `deno_lint_passed`.
4. **`step_review`** — reviewer (must be claude-code) reads files +
   spec, emits verdict + findings with required `plan_line`
   citations. Verdict is one of `APPROVE | NEEDS_CHANGES | BLOCK`.
5. **`completed`** — final state if APPROVE. Otherwise the loop
   emits the findings as-is to the caller for next-iteration input.

Add a `step_reflect` between review and completed once reflector
patterns stabilize. The reflector captures drift → contract-fix
mappings into the workspace's memory corpus for future tasks.

## Data contracts (copy into your workspace.yml)

### Design memo contract

```yaml
design-memo-result:
  type: object
  properties:
    plan_citations:
      type: array
      minItems: 1
      description: REQUIRED. Verbatim quotes from the source spec.
      items:
        type: object
        properties:
          file: { type: string }
          line_start: { type: integer }
          line_end: { type: integer }
          verbatim: { type: string }
        required: [file, verbatim]
    files_to_create:
      type: array
      items:
        type: object
        properties:
          path: { type: string }
          purpose: { type: string }
          key_types:
            type: array
            items: { type: string }
        required: [path, purpose]
    files_to_modify:
      type: array
      items:
        type: object
        properties:
          path: { type: string }
          changes: { type: string }
    tests_needed:
      type: array
      items: { type: string }
    integration_notes: { type: string }
  required:
    - plan_citations
    - files_to_create
    - integration_notes
```

### Coder result contract

```yaml
coder-result:
  type: object
  properties:
    files_written:
      type: array
      items:
        type: object
        properties:
          path: { type: string }
          lines_added: { type: integer }
          lines_removed: { type: integer }
        required: [path]
    tests_added:
      type: array
      items: { type: string }
    deno_check_passed: { type: boolean }
    deno_lint_passed: { type: boolean }
    summary: { type: string }
  required:
    - files_written
    - deno_check_passed
    - summary
```

### Review verdict contract (with required citations)

```yaml
review-result:
  type: object
  properties:
    verdict:
      type: string
      enum: [APPROVE, NEEDS_CHANGES, BLOCK]
    findings:
      type: array
      items:
        type: object
        properties:
          severity:
            type: string
            enum: [CRITICAL, WARNING, SUGGESTION]
          file: { type: string }
          line: { type: integer }
          description: { type: string }
          plan_line:
            type: string
            description: REQUIRED. Source citation like "parity-plan.md:582-634".
        required: [severity, description, plan_line]
    summary: { type: string }
  required:
    - verdict
    - summary
```

## Operational setup

### Docker mount

Any workspace that modifies source must have the target repo
mounted into the daemon container. Use a `docker-compose.override.yml`
so the tracked `docker-compose.yml` stays clean:

```yaml
services:
  platform:
    volumes:
      - /absolute/host/path/to/target-repo:/workspace/target:rw
```

Recreate after adding: `docker compose up -d --force-recreate`.

Verify: `docker compose exec platform ls /workspace/target`.

### Workspace lifecycle

- **Create:** `POST /api/workspaces/create` with `{config: {...}}`.
  Returns a generated workspace ID like `artisan_almond`.
- **Update:** `POST /api/workspaces/:id/update` with
  `{config: {...}, backup: false}`. Preserves the workspace ID.
  Writes the new workspace.yml, destroys the runtime, reloads
  on next signal. **Use this for iteration — do not delete and
  recreate.**
- **Delete:** `DELETE /api/workspaces/:id` as last resort.
  Changes the ID and drops in-flight sessions.

### Skill upload (CRITICAL)

When uploading a skill via the daemon API, the `skillMd` form
field MUST be sent via curl's `=<file` syntax (text-from-file),
NOT via `=$VAR` (shell-interpolated):

```bash
# WRONG — shell expansion truncates multi-KB content + mangles special chars
SKILL_MD=$(cat skill/SKILL.md)
curl -F "skillMd=$SKILL_MD" ...

# WRONG — @file uploads as binary multipart, daemon can't parse string field
curl -F "skillMd=@skill/SKILL.md" ...

# RIGHT — read file as text into form field
curl -F "skillMd=<skill/SKILL.md" ...
```

Symptom of using the wrong form: skill publishes successfully
(returns `version: 1` etc.) but the `instructions` field in the
GET response is truncated to the first ~500 chars. The daemon's
`parseSkillMd` works correctly; the loss happens at the curl
client side.

Skill description has a hard `.max(1024)` constraint in
`SkillFrontmatterSchema` — long descriptions will fail upload
with a Zod validation error. Keep descriptions under 1024 chars.

### Triggering and observing

### Triggering and observing

- **Trigger:** `POST /api/workspaces/:id/signals/:signal` with
  `{payload: {...}}`. Blocks until FSM completes (can be minutes).
  Use `run_in_background` for anything beyond a few seconds.
- **Poll sessions:** `GET /api/sessions?workspaceId=:id&limit=N` —
  returns newest-first. Each session has `sessionId`, `status`,
  `agentBlocks[].toolCalls[-1].args` with the structured output
  from each step's `complete` tool call.
- **Live logs:** `docker compose logs --since=5m platform | grep <sessionId>`.
  Look for `Executing agent`, `Starting SDK query`, `Using clone`,
  and any `level: error` or `level: warn`.

### The diagnostic polling pattern

```bash
curl -s http://localhost:18080/api/sessions/<sessionId> | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('session:', d.get('status'))
for block in d.get('agentBlocks', []):
    print(f'  step {block.get(\"stepNumber\")} ({block.get(\"stateId\")}): {block.get(\"status\")}')
    for tc in block.get('toolCalls', []):
        if tc.get('toolName') == 'complete':
            print('   ', json.dumps(tc.get('args', {}))[:200])
"
```

The key insight: structured agent output lives at
`agentBlocks[N].toolCalls[-1].args` where the last tool call is
always `complete`. Internal tool calls (fs_read, fs_write, bash)
made by claude-code don't appear in this list — they're inside
the sandbox and only the final `complete` surfaces.

## Failure-mode → structural-fix mapping

When you hit these symptoms, apply these fixes. Do not
prompt-engineer your way out.

| Symptom | Root cause | Structural fix |
|---|---|---|
| Architect invents plausible but wrong interfaces | Agent never read the spec | Required `plan_citations` field with minItems >= 1 |
| Reviewer rubber-stamps drifted output | Reviewer compared to memo, not spec | Required `plan_line` on findings + reviewer prompt points at source |
| LLM agent returns `"placeholder"` in plan_citations | `type: llm` can't read workspace skills | Embed reference content in `agents.X.config.prompt` |
| Reviewer says "I need to read the file first" | `type: llm` has no fs tools | Switch reviewer to `type: atlas, agent: claude-code` |
| Two runs producing the same files | Concurrent sessions on same workspace | Pre-check for active sessions; queue triggers |
| Wrong files get written | Coder's workDir is wrong | Set `workDir` to the mounted repo path in `prepare_implement` |
| Daemon doesn't see config changes | Using DELETE + create dance | Use `POST /:id/update` instead (preserves ID) |
| Architect output exceeds context budget | Reference material doesn't fit | Split tasks into smaller briefs with narrower citation ranges |
| Coder rewrites files that were correct | Brief didn't scope the change tightly | Use `target_files` in trigger payload + "do not invent files not in memo" in coder prompt |
| Reflector reads "empty" SKILL.md and proposes bootstrap content | Skill upload via `-F "skillMd=$VAR"` truncated content at publish time | Use `-F "skillMd=<file"` syntax (text-from-file), not shell-interpolated. Verify post-upload via `GET /api/skills/@ns/name` and check `instructions` length matches the source file. |
| Architect's structured output is in `block.toolCalls[-1].args` for LLM-type but `block.output` for claude-code-type | Two different agent return paths | Polling scripts must check both paths; default to `block.output` for `type: atlas, agent: claude-code` agents |
| Quick fix tasks waste 10+ min on architect for a 2-char diff | Generalized workspace uses claude-code architect with `effort: high` even for trivial changes | For single-file fixes, use a "quick-fix" signal path that skips architect, runs coder with inline instructions, and reviewer on just that file. Triggered when `target_files.length === 1` AND brief contains "fix" or "remove". |
| Global skills leak into every claude-code sandbox | FAST has only a global skill tier; workspace-level `skills:` declaration doesn't gate visibility | Until per-workspace skill scoping ships (Phase 3 FridayHub trust model), expect every published skill to appear in every claude-code agent's context. Keep the global skill list small and curated. |

## What to do with this skill's output

The reflector's job (Phase 5 of the parity plan) is to run this
loop, observe failures, and propose edits to this SKILL.md file.
Versioned via `SkillAdapter.update` with rollback on regression.

Until the reflector is running, a human operator is the reflector —
observe the loop, notice when a failure mode isn't in the table
above, and append a new row. Every row in the failure-mode table
should trace back to a real iteration that exposed it.

## When to revisit the rules

- You're seeing a failure mode not in the table above → append a row
- A rule stops holding (e.g. LLM agents gain fs access) → note the
  change and which phase enabled it; don't delete history
- The autonomous reflector starts proposing edits → human reviews
  the proposed diff, accepts or rejects, records the decision in
  the skill's own memory corpus

This skill is meta: it teaches the system how to improve itself
without human intervention. It must itself be improved, deliberately,
by humans reviewing its diffs — until reflector confidence scores
justify auto-apply.
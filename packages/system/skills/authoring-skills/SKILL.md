---
name: authoring-skills
description: Authors new agent skills that follow the Anthropic + agentskills.io specification. Use when the user asks to create, draft, review, or refactor a skill, write a SKILL.md file, lay out reference files, or bundle scripts. Covers frontmatter rules, 500-line / 5000-token body budgets, one-level-deep reference layout, progressive disclosure, gotchas sections, control calibration, the evaluation-first authoring loop, and the lint gate before publish.
---

# Authoring skills

A skill is a bundle of instructions loaded into an agent's context window on demand. This skill covers how to write one that is concise, discoverable, calibrated to its task, and testable.

Copy this checklist into the response when starting a skill:

```
Skill authoring:
- [ ] 1. Capture real expertise (hands-on task or project artifacts — not LLM synthesis)
- [ ] 2. Write frontmatter: `name` (gerund form) + `description` (3rd person, what + when)
- [ ] 3. Draft SKILL.md body — gotchas first, then workflow, then references
- [ ] 4. Extract overflow into references/ (one level deep from SKILL.md)
- [ ] 5. Bundle scripts only when the agent would reinvent the logic each run
- [ ] 6. Write ≥3 evaluation cases, baseline without the skill, then with
- [ ] 7. Run scripts/lint_skill.py and address every error
- [ ] 8. Test with a fresh agent instance (Claude-A / Claude-B loop)
```

## 1. Start from real expertise

Skills generated from LLM general knowledge come out vague ("handle errors appropriately", "follow best practices"). Useful skills are grounded in project-specific material.

Two paths:

**Extract from a hands-on task.** Complete a real task with the agent, correcting as you go. Then distil the reusable pattern. Pay attention to: the sequence of steps that actually worked, the corrections you had to make, the input/output shapes, and the project-specific context you had to supply.

**Synthesise from project artifacts.** Feed internal docs, runbooks, API specs, code review comments, version history, and postmortems into the draft. Real incident reports outperform any "best practices" blog post because they capture *your* schemas, failure modes, and conventions.

## 2. Frontmatter

Full field spec: `references/frontmatter.md`.

Quick rules:

- `name`: lowercase, hyphens, ≤64 chars, gerund-form preferred (`processing-pdfs`, `creating-workspaces`). Never contains `anthropic` or `claude`.
- `description`: ≤1024 chars, **third person**, answers **what** + **when**. This field alone drives skill discovery — every other token in SKILL.md is invisible to the router.

Good:

```yaml
description: Extracts text and tables from PDF files, fills forms, and merges documents. Use when working with PDFs or when the user mentions forms or document extraction.
```

Bad:

```yaml
description: I can help with PDFs.         # first person, no trigger
description: Does stuff with files.        # meaningless
```

## 3. Body

Default assumption: the agent is already smart. Include only what it would otherwise get wrong.

**Budgets** (enforced by `scripts/lint_skill.py`):

- ≤500 lines, ≤5000 tokens in SKILL.md → warning.
- ≤800 lines, ≤8000 tokens → error.

Move overflow to `references/<topic>.md`, one level deep. Never chain references through nested files — Claude partial-reads nested content and drops information.

Recommended section order (adapt for the task):

1. **Heading + one-paragraph summary.**
2. **Progress checklist** in a fenced code block — the agent copies and checks off.
3. **Gotchas** — the highest-value section in most skills. Concrete corrections to mistakes the agent would make without being told. See `references/patterns.md`.
4. **Workflow** — ordered steps with validation gates. See `references/patterns.md` for the validation loop and plan-validate-execute patterns.
5. **Output templates** when the format is prescribed.
6. **Reference pointers** — each says *which* file and *when* to load it. "See `references/api-errors.md` if the API returns a non-200 status" is useful; "see references/ for details" is not.

## 4. Calibrate control

Match specificity to fragility. Most skills mix all three levels — calibrate each section independently. See `references/control-calibration.md`.

| Task profile | Freedom | Form |
|---|---|---|
| Many valid paths, context-dependent | **High** | Describe intent and success criteria |
| Preferred pattern, some variation fine | **Medium** | Pseudocode or parameterised script |
| Fragile, must-sequence, error-prone | **Low** | Exact command, "do not modify" |

Provide defaults, not menus. Pick one tool, mention a single fallback, then stop.

## 5. Use patterns, not prose

A reusable structure beats a paragraph of description. Pattern library in `references/patterns.md`:

- **Gotchas** — concrete environment-specific facts.
- **Template** — concrete input/output example; agents pattern-match on structure.
- **Checklist** inside a fenced code block — the agent copies and checks off as it progresses.
- **Validation loop** — do → validate → fix → repeat.
- **Plan-validate-execute** — for batch or destructive operations.
- **Examples** — ≥3 input/output pairs when output style matters.

## 6. Bundle scripts only when reusable

When the agent reinvents the same logic across runs, write a script once and put it in `scripts/`. See `references/scripts.md`.

Scripts must:

- Handle error conditions explicitly — do not punt to the agent.
- Justify every constant ("3 retries balances reliability vs latency" — not `RETRIES = 5` with no comment).
- Use forward slashes in all paths.
- Declare dependencies. Do not assume packages are installed.

State whether the agent should **execute** the script (usually) or **read** it as reference (rarely).

## 7. Evaluate before polishing

Write evals *before* writing extensive documentation. See `references/evaluation.md`.

1. Run target tasks **without** the skill. Document specific failures.
2. Write ≥3 evaluation cases that capture the gap.
3. Baseline score without the skill.
4. Write the minimal skill that closes the gap.
5. Rerun. **Read execution traces, not just final outputs** — wasted exploration reveals vague instructions; ignored references reveal weak triggers.
6. Iterate: add to gotchas when the agent makes a correctable mistake; cut sections the agent never uses.

The **Claude-A / Claude-B loop** is the core iteration pattern: Claude A helps you refine the skill, Claude B (a fresh instance with the skill loaded) performs real tasks, and observations from Claude B drive the next revision.

## Gotchas

- **`name` contains `anthropic` or `claude`** — rejected by the validator. Use a task-based gerund instead.
- **First-person description** (`I can …`, `You can …`) — the description goes into the router system prompt; mixed person breaks discovery. Third person only.
- **Nested references** — Claude partial-reads with `head -100` when files are linked from other linked files. Keep reference depth = 1 from SKILL.md.
- **Reference file >100 lines without a table of contents** — partial-reads miss later sections. Add a `## Contents` list at the top.
- **Time-sensitive prose** (`before August 2025`) — goes stale. Put superseded info in a collapsed `<details>` block labelled "Old patterns".
- **Offering multiple options as equals** (`you can use pypdf, pdfplumber, PyMuPDF, or pdf2image`) — agent spends context choosing. Pick one default plus one fallback; stop there.
- **Inconsistent terminology** — one term per concept throughout. Do not mix "field"/"box"/"element" or "extract"/"pull"/"get".
- **Skill under 20 lines** — likely redundant with the base model. Confirm via eval before shipping.
- **Explaining general concepts** — "A PDF is a portable document format…". The agent knows. Cut it.
- **Workspace-specific configuration** — does not belong in a skill. Put it in `workspace.yml`.

## When NOT to write a skill

- The task is one-off → write it in the prompt.
- The base model already handles it → confirm via eval.
- The content is environment config → `workspace.yml` or `friday.yml`.
- The content is a single function → a bundled script is enough; no skill wrapper needed.

## Lint before publish

```bash
python scripts/lint_skill.py path/to/skill/
```

Errors (fail publish): frontmatter schema violation, body >800 lines or >8000 tokens, broken reference links, backslash paths, first-person description, reserved name substrings, reference depth >1.

Warnings (informational): body >500 lines or >5000 tokens, description missing "Use when …" clause, time-sensitive phrasing, reference file >100 lines without a table of contents.

## References

- `references/frontmatter.md` — field-by-field spec, good/bad description examples.
- `references/control-calibration.md` — high/medium/low freedom with concrete samples.
- `references/patterns.md` — gotchas, templates, checklists, validation loops, plan-validate-execute.
- `references/scripts.md` — when to bundle, error handling, constant justification, dependency declaration.
- `references/evaluation.md` — eval-first workflow, Claude-A / Claude-B loop, what to watch for in traces.
- `references/anti-patterns.md` — full list of what to avoid.

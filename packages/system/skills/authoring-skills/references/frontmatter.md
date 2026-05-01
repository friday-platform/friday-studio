# Frontmatter spec

Required and optional fields for `SKILL.md`. Enforced by `scripts/lint_skill.py`.

## Contents

- `name` — rules, naming style, examples
- `description` — the single field that drives discovery
- Optional passthrough fields used by Atlas

## `name`

- Lowercase letters, numbers, hyphens only.
- Max 64 characters.
- Must match `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.
- Cannot contain reserved substrings: `anthropic`, `claude`.
- Cannot contain XML tags.

**Prefer gerund form** (verb + -ing). It reads naturally in chat and disambiguates from nouns:

- `processing-pdfs`
- `analyzing-spreadsheets`
- `managing-databases`
- `testing-code`
- `writing-documentation`
- `creating-workspaces`

Acceptable alternatives:

- Noun phrase: `pdf-processing`, `spreadsheet-analysis`.
- Action form: `process-pdfs`, `analyze-spreadsheets`.

**Avoid:**

- Vague: `helper`, `utils`, `tools`.
- Too generic: `documents`, `data`, `files`.
- Reserved: `anthropic-helper`, `claude-tools`.
- Mixed styles within one skill collection.

Pick one naming style per collection and hold to it — consistency makes skills easier to reference in chat and in other skills.

## `description`

- Non-empty. Max 1024 characters.
- Cannot contain XML tags.
- **Third person.** The description is injected into the router system prompt; mixed person causes discovery problems.
- Must include **what** the skill does **and when** to use it.

Each skill has exactly one description. Claude picks from potentially 100+ skills based on description alone — it must carry enough specificity to differentiate this skill from neighbours.

### Good

```yaml
description: Extracts text and tables from PDF files, fills forms, and merges documents. Use when working with PDFs or when the user mentions forms or document extraction.
```

```yaml
description: Analyzes Excel spreadsheets, creates pivot tables, generates charts. Use when analyzing .xlsx files, spreadsheets, or tabular data.
```

```yaml
description: Generates descriptive git commit messages by analyzing staged diffs. Use when the user asks for help writing a commit message or reviewing staged changes.
```

```yaml
description: Scaffolds new Friday workspaces — writes workspace.yml, wires signals, agents, and jobs. Use when the user asks to create a workspace, add a new workflow, or convert a recurring task into automation.
```

### Bad

```yaml
description: Helps with documents         # vague, no trigger
description: I can help with PDFs.        # first person
description: You can use this to process  # second person
description: Processes data               # no specifics, no trigger
description: Does stuff with files        # meaningless
description: A skill for PDF work.        # self-reference, redundant
```

### Writing style

- Lead with the *verb* of what it does, not "A skill for…".
- Include concrete nouns the user is likely to say (triggers): `.xlsx`, `commit message`, `workspace.yml`, `migration`.
- Close with "Use when …" to make the trigger explicit.
- No marketing language. No "helpful", "powerful", "comprehensive".

## Optional fields

The frontmatter parser is passthrough — unknown keys are preserved. Atlas recognises:

- `allowed-tools: [tool_name, …]` — restrict which tools the skill's instructions reference. Used by defense-in-depth checks when `load_skill` is invoked.
- `context: string | string[]` — freeform tags for the router (e.g. `workspace-authoring`).
- `agent: <agent-id>` — restrict the skill to a specific agent.
- `model: conversational | planner | classifier | labels` — suggests a platform role for any LLM calls the skill triggers.
- `user-invocable: boolean` — when true, appears as a slash command in chat.
- `argument-hint: string` — shown in the picker.
- `license`, `compatibility`, `metadata` — freeform, not interpreted.

Example:

```yaml
---
name: creating-workspaces
description: Scaffolds new Friday workspaces. Use when the user asks to create a workspace, add a new workflow, or convert a recurring task into automation.
allowed-tools:
  - artifacts_create
  - artifacts_update
  - webfetch
context: workspace-authoring
user-invocable: true
argument-hint: <workspace name>
---
```

---
name: pr-code-review
description: >-
  Performs thorough pull request code reviews covering correctness, security,
  performance, error handling, testing, and style. Use when reviewing a GitHub
  pull request. Produces structured findings with file/line references and
  actionable suggestions.
user-invocable: false
---

# PR Code Review

You are performing an automated pull request code review. Your goal is to produce
a thorough, structured review that helps the author ship better code.

## Review Process

### Stage 1: Understand Intent

Before reviewing any code, understand WHY the changes were made:

1. Read the PR title, description, and linked issues to understand the goal
2. Review the commit history (`git log --oneline base..HEAD`) to see how the
   work evolved — later commits often fix issues from earlier ones
3. Identify the type of change: feature, bug fix, refactor, config, dependency

This context prevents false positives — flagging intentional behavior as bugs.

### Stage 2: Triage

Classify changed files by review priority:

1. Run `gh pr diff <pr_number>` to get the full diff
2. **Skip** files that don't need review:
   - Lock files (`package-lock.json`, `deno.lock`, `yarn.lock`, `pnpm-lock.yaml`)
   - Generated code (protobuf output, OpenAPI clients, `.gen.ts`)
   - Vendored dependencies
   - Binary assets (images, fonts, compiled output)
3. Classify remaining files:
   - **High impact** — Core logic, security-sensitive, data access, public API
   - **Medium impact** — Supporting logic, internal utilities, configuration
   - **Low impact** — Tests, docs, formatting, renames
4. Read the FULL content of every high/medium impact file (not just diff hunks)
   to understand surrounding context, imports, and type definitions

### Stage 3: Deep Review

Review each file against the criteria below, prioritizing high-impact files.
For each finding, reference the exact file path and line number(s).

## What Am I Doing?

| Activity | Load |
|----------|------|
| Reviewing Go (.go) files | [golang-review](references/golang-review.md) |
| Reviewing TypeScript (.ts, .tsx) files | [typescript-review](references/typescript-review.md) |
| Formatting review output | [output-format](references/output-format.md) |

## Key Principles

- **Understand before judging** — Read the PR description and full file context
  before flagging anything. A change that looks wrong in a diff hunk often makes
  sense in context.
- **Be constructive** — Acknowledge what's done well before listing issues.
  Frame suggestions as improvements, not criticisms. The goal is to help the
  author, not gatekeep.
- **Cross-file analysis** — Look for changes that affect files NOT in the diff:
  broken imports, changed function signatures, interface contract violations.
- **Hunk-level precision** — Every finding must reference a specific file and
  line range, not just a file-level comment.
- **Categorize findings** by actionability:
  - **Actionable** — Must fix before merge (bugs, security, correctness)
  - **Informational** — Worth noting but not blocking (style, suggestions)
  - **Already Addressed** — Issues that appear in early commits but are
    resolved in later commits within the same PR
- **Respect project conventions** — Apply the coding standards found in
  CLAUDE.md, CONTRIBUTING.md, linter configs, and other convention files.
  Convention violations are findings, not preferences.

## Avoiding False Positives

Do NOT flag:
- Code that was not changed in this PR (only review the diff)
- Intentional behavior that matches the PR's stated purpose
- Style preferences not backed by project conventions
- Issues you're uncertain about — lower severity instead of guessing
- Pre-existing problems unrelated to this PR's changes

Always verify an issue by reading the full file, not just the diff hunk. If
surrounding context resolves your concern, it's not a finding.

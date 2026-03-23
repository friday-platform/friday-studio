# QA Plan: Inline PR Review Comments

**Context**: `examples/pr-review/` — switched from single body comment to inline
PR comments via `gh api`, with GitHub suggestion blocks and fallback for
non-diff lines.
**Branch**: `feature/pr-review-example`
**Date**: 2026-03-16

## Prerequisites

- Daemon running (`deno task atlas daemon start --detached`)
- GitHub token configured (check `GET /link/v1/credentials` for `github` provider)
- Anthropic API key configured (check `GET /link/v1/credentials` for `anthropic` provider)
- Test PR: `https://github.com/tempestteam/gsm-init/pull/190`

## Cases

### 1. Full pipeline produces inline comments on PR

**Trigger**: Run the full pipeline:
```bash
cd examples/pr-review && ./run-cli.sh https://github.com/tempestteam/gsm-init/pull/190
```
Wait for session to complete (watch for `data-session-finish` with `status: completed`).

**Expect**:
- Pipeline completes without errors (all FSM states transition: idle → step_clone_repo → step_review_pr → step_post_review → completed)
- Individual inline comments appear on the PR at specific file:line positions in the diff view
- Each inline comment has the format: `**SEVERITY** — Title`, `**Category:**`, description
- A summary review comment appears on the PR with verdict, summary, and finding counts

**If broken**:
- `deno task atlas logs --level error,warn --since 5m` for daemon errors
- Check `prepare_post_review` output: `deno task atlas session list` → get session ID → `deno task atlas session get <id>` to inspect document state
- If clone step fails: check GitHub token validity via `curl -H "Authorization: token $(gh auth token)" https://api.github.com/user`
- If review step fails: check Anthropic key, look for `complete` tool output in session transcript

### 2. Inline comments land on correct file:line positions

**Trigger**: After case 1 completes, open `https://github.com/tempestteam/gsm-init/pull/190` in the browser. Navigate to the "Files changed" tab.

**Expect**:
- Each inline comment is positioned at the exact file and line referenced in the finding
- Comments appear on the RIGHT side of the diff (new code, not old code)
- Multi-line comments (those with `start_line`) visually span the correct line range
- No comments appear on lines outside the diff (those should be in the summary)

**If broken**:
- Check `post-review-output` in session results for `posted_comments` vs `failed_comments` counts
- If `failed_comments > 0`, the fallback logic should have put them in the summary comment — check the summary body
- 422 errors in daemon logs indicate lines not in the diff — `gh api repos/tempestteam/gsm-init/pulls/190/files` shows valid diff ranges

### 3. Suggestion blocks render "Apply suggestion" button

**Trigger**: On the PR's "Files changed" tab, look for inline comments that contain code suggestions.

**Expect**:
- Comments with suggestions show a ` ```suggestion ``` ` fenced block
- GitHub renders an **"Apply suggestion"** button on those comments
- The suggestion code is syntactically complete and makes sense as a replacement for the commented line range
- Clicking "Apply suggestion" (don't actually commit) shows a preview of the correct replacement

**If broken**:
- Check the raw comment body via `gh api repos/tempestteam/gsm-init/pulls/190/comments --jq '.[].body'`
- Verify the suggestion fence is ` ```suggestion ``` ` (not ` ```typescript ``` ` or other language tag)
- If suggestions are missing: check `review-output` document — `findings[].suggestion` should be populated for at least some findings
- `buildCommentBody` in `packages/bundled-agents/src/gh/agent.ts:202` wraps the suggestion

### 4. Fallback: non-diff line findings appear in summary

**Trigger**: This tests the fallback path. If case 1 didn't naturally produce any failed inline comments, verify the fallback logic by checking the summary comment.

Alternative manual trigger: temporarily modify a finding's line number in `prepare_post_review` to a line outside the diff (e.g., line 1 of a file that wasn't changed), re-run the pipeline, and check results.

**Expect**:
- The summary review comment contains a tally: `> N findings: X inline, Y in summary (outside diff range)`
- Failed inline comments appear as `<details>` blocks in the summary body with severity, file:line, category, description, and suggestion
- The summary still ends with `*Automated review by Friday*`

**If broken**:
- Check `post-review-output` data for `failed_comments` count
- If `failed_comments: 0`, the LLM produced line numbers all within the diff (good!) — this case is a pass-by-absence
- Inspect the summary body via `gh api repos/tempestteam/gsm-init/pulls/190/reviews --jq '.[-1].body'`

### 5. Structured review output via `complete` tool

**Trigger**: After case 1 completes, inspect the `review-output` document from the session.

```bash
deno task atlas session get <session-id>
```

Look at the `review-output` result.

**Expect**:
- Output is structured JSON with `verdict`, `summary`, and `findings` array (not a markdown string)
- `verdict` is one of: `APPROVE`, `REQUEST_CHANGES`, `COMMENT`
- Each finding has required fields: `severity`, `category`, `file`, `line`, `title`, `description`
- `line` values are positive integers corresponding to actual file lines
- `start_line` (when present) is less than `line`

**If broken**:
- If output is a markdown string instead of JSON: the `complete` tool wasn't injected — check that `outputType: code-review-result` is set on the agent action and the schema has actual properties (not empty `properties: {}`)
- If `complete` tool is missing from claude-code's tool list: check `fsm-engine.ts:978-1010` — `hasDefinedSchema()` must return true
- If findings array is empty but the PR has issues: check the prompt in workspace.yml — the agent may not understand the JSON output format

### 6. Head SHA propagation (clone → post-review)

**Trigger**: After case 1 completes, inspect the session documents.

**Expect**:
- `clone-output` document contains `data.head_sha` — a 40-character hex SHA
- `post-review-output` input (the `gh-operation` doc) has `commit_id` matching that SHA
- Inline comments posted to GitHub reference this exact commit

**If broken**:
- If `head_sha` is empty/missing: check that `headRefOid` is in the `gh pr view --json` fields list (`agent.ts:285`)
- If `commit_id` is empty string: `prepare_post_review` falls back to `''` when head_sha is missing — check `clone-output` data
- Verify via `gh api repos/tempestteam/gsm-init/pulls/190 --jq '.head.sha'` that the SHA matches

### 7. Pipeline resilience: review with zero findings

**Trigger**: If the test PR produces zero findings (APPROVE verdict), verify the pipeline still completes cleanly.

Alternatively, find/use a very clean PR that would produce no findings.

**Expect**:
- Pipeline completes: idle → step_clone_repo → step_review_pr → step_post_review → completed
- Summary comment is posted with `APPROVE` verdict and `> 0 findings` tally
- No inline comments are posted (nothing to post)
- `post-review-output` shows `posted_comments: 0, failed_comments: 0`

**If broken**:
- Empty findings array should not cause errors in the `for` loop
- Check that the summary is still posted even with zero findings

## Smoke Candidates

- **Case 1** (full pipeline E2E) — covers the entire happy path end-to-end; durable because it exercises every FSM state transition
- **Case 5** (structured output) — verifies the `complete` tool injection contract; catches schema/prompt regressions

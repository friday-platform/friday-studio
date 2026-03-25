# GitHub CLI Review Patterns

## Inline PR Comments via `gh api`

`gh pr review` does not support inline comments. Use the GitHub REST API via
`gh api` to post comments at specific file:line positions in the diff.

### Single-line comment

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
  -f body="Comment text" \
  -f path="src/foo.ts" \
  -f commit_id="abc123def456" \
  -F line=42 \
  -f side="RIGHT"
```

### Multi-line comment (spans start_line..line)

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
  -f body="Comment text" \
  -f path="src/foo.ts" \
  -f commit_id="abc123def456" \
  -F start_line=40 \
  -f start_side="RIGHT" \
  -F line=45 \
  -f side="RIGHT"
```

### GitHub Suggestion Blocks

When the comment body contains a fenced ` ```suggestion ``` ` block, GitHub
renders an **"Apply suggestion"** button that lets the author merge the fix in
one click:

```markdown
**WARNING** — Potential null dereference

The `user` object may be undefined here.

\`\`\`suggestion
const name = user?.name ?? "anonymous";
\`\`\`
```

The suggestion replaces the **entire line range** of the comment (single line
or `start_line..line`). Must be syntactically complete code.

### Requirements

- `commit_id` is the HEAD SHA of the PR branch (`headRefOid` from PR metadata).
- Lines must be within the diff (including ~3 lines of context around hunks).
- Returns 422 if the line is not in the diff — handle gracefully by collecting
  the finding into the summary comment as fallback.

## Posting the Summary Review

Use `gh pr review --comment` for the summary body (verdict, summary, and any
findings that couldn't be posted inline):

```bash
gh pr review <pr_number> --repo <owner>/<repo> --comment --body-file /tmp/review-body.md
```

### Summary body format

The summary is a condensed overview, not the full review. Most findings appear
as inline comments. The summary contains:

```markdown
## Code Review

**Verdict:** REQUEST_CHANGES

### Summary

2-3 sentence assessment.

---

> 5 findings: 4 inline, 1 in summary (outside diff range)

<details>
<summary><b>WARNING</b> · <code>path/to/file.ts:15</code> — Missing validation</summary>

**Category:** security

Description of the issue.

**Suggestion:**
```
concrete fix
```

</details>

---

*Automated review by Friday*
```

Only findings that failed to post inline (422 errors) appear in the summary
body. If all findings posted successfully, the summary has no `<details>` blocks.

## Checking for Existing Reviews

Before posting, check for duplicates:

```bash
gh pr view <pr_number> --repo <owner>/<repo> --json reviews --jq '.reviews[] | select(.body | test("Automated review by Friday")) | .url'
```

Comment-type reviews cannot be deleted or dismissed via the GitHub API.

## Known Gotchas

- **Self-approval error**: `gh pr review --approve` fails if the token owner is
  the PR author. Always use `--comment` to avoid this.
- **Duplicate reviews**: If `--approve` or `--request-changes` fails after
  posting the body, gh has already posted a review. A retry creates a duplicate.
  Always check for existing reviews before posting.
- **Body length**: GitHub has a 65536 character limit on review bodies. For very
  large reviews, truncate findings by severity (drop nitpicks first).
- **422 on inline comments**: The line must be in the diff. If not, the API
  returns 422. Collect these into the summary body as fallback.
- **commit_id required**: Inline comments require the exact HEAD commit SHA.
  Using a stale SHA after force-push will fail.

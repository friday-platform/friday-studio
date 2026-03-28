# PR Code Review

Automated pull request code review using [FAST](https://platform.hellofriday.ai/docs/) (Friday Agent Studio & Toolkit). Accepts a GitHub pull request URL, clones
the repository, performs a thorough code review with Claude Code, and posts
structured inline comments back on the pull request.

## Pipeline

```
Signal: review-pr { pr_url }
         |
    step_clone_repo        GitHub agent clones repo, checks out pull request branch, reads conventions
         |
    step_review_pr         Claude Code reads full diff + changed files, reviews against 6 criteria
         |
    step_post_review       GitHub agent formats findings as inline comments, posts review
         |
      completed
```

Each step runs as an isolated agent. The review step re-clones the repository
because agents don't share a filesystem.

## Quick start

### 1. Set up credentials

Add your API keys to the `.env` file next to your `docker-compose.yml`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
GH_TOKEN=ghp_...
```

The `GH_TOKEN` needs `repo` scope for private repos, or just public repo access
for public ones.

### 2. Start FAST

```bash
docker compose up
```

Wait for the startup banner, then open the Studio at **http://localhost:5200**.

### 3. Publish the skill

The pull request review space uses the `@tempest/pr-code-review` skill. Publish it before
loading the space.

**Via the Studio:** Click **Skills** in the sidebar, then drag the `skill/`
folder onto the drop zone.

**Via the API:**

```bash
tar czf /tmp/pr-code-review.tar.gz -C pr-review-github/skill .
curl -X POST http://localhost:8080/api/skills/@tempest/pr-code-review/upload \
  -F "archive=@/tmp/pr-code-review.tar.gz" \
  -F "skillMd=$(cat pr-review-github/skill/SKILL.md)"
```

### 4. Load the space

**Via the Studio:** Click **Add Space** in the sidebar and drop `workspace.yml`
onto the drop zone.

**Via the API:**

```bash
CONFIG=$(python3 -c "import yaml,json; print(json.dumps(yaml.safe_load(open('pr-review-github/workspace.yml'))))")
curl -s -X POST http://localhost:8080/api/workspaces/create \
  -H 'Content-Type: application/json' \
  -d "{\"config\":$CONFIG,\"workspaceName\":\"PR Review (GitHub)\"}"
```

Note the `id` in the response — you'll use it to trigger jobs.

### 5. Trigger a review

**Via the Studio:** Navigate to the space, click **Run** on the PR Review job,
and enter the pull request URL.

**Via the API:**

```bash
curl -X POST http://localhost:8080/api/workspaces/<workspace-id>/signals/review-pr \
  -H 'Content-Type: application/json' \
  -d '{"payload":{"pr_url":"https://github.com/owner/repo/pull/123"}}'
```

**With SSE streaming:**

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<workspace-id>/signals/review-pr \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"payload":{"pr_url":"https://github.com/owner/repo/pull/123"}}'
```

### 6. Connect a GitHub webhook (optional)

Instead of triggering manually, you can have GitHub send webhooks automatically
when pull requests are opened.

1. Open the space in the Studio and find the **Signals** section — copy the
   webhook URL and secret for the `review-pr` signal
2. Go to your GitHub repo **Settings → Webhooks → Add webhook**
3. Fill in:
   - **Payload URL:** the webhook URL from the Studio
     (e.g. `https://...trycloudflare.com/hook/github/<workspace-id>/review-pr`)
   - **Content type:** select **`application/json`** (required)
   - **Secret:** the secret from the Studio
   - **Events:** select **Let me select individual events** → check
     **Pull requests**
4. Click **Add webhook**

Now opening a pull request in that repo will automatically trigger a review.

### 7. Watch it run

Open the space in the Studio to see real-time progress — each step shows its
status, the agent running, and data flowing between steps.

## How it works

### Architecture

Each step is an isolated Claude Code agent with `GH_TOKEN` and
`ANTHROPIC_API_KEY` in its environment. Data flows between steps via
`context.setResult()` / `context.results[]` (session-scoped key-value store).

### Data flow

```
HTTP signal { pr_url: "https://github.com/owner/repo/pull/123" }
  |
  v
prepare_clone(context, event)
  - Parses event.data.pr_url -> owner, repo, pr_number, clone_url
  - Persists via context.setResult('pr-details', {...})
  - Returns { task, config } for the GitHub agent
  |
  v
GitHub agent (step_clone_repo)
  - Clones repo, checks out pull request branch
  - Reads README, CLAUDE.md, CONTRIBUTING.md, CODEOWNERS, linter configs
  - Fetches pull request metadata via gh pr view
  - Outputs pull request metadata + conventions to clone-output
  |
  v
prepare_review(context, event)
  - Reads context.results['pr-details'] and context.results['clone-output']
  - Passes clone_url, pr metadata, conventions to the reviewer
  |
  v
Claude Code (step_review_pr)
  - Clones repo + checks out pull request branch (agents are isolated)
  - Reads full diff via gh pr diff
  - Reads FULL content of every changed file for context
  - Analyzes against: correctness, security, performance,
    error handling, testing, style & conventions
  - Outputs structured: SUMMARY, VERDICT, FINDINGS
  |
  v
prepare_post_review(context, event)
  - Reads context.results['pr-details'] and context.results['review-output']
  - Passes owner, repo, pr_number, clone_url, and review text to the agent
  |
  v
GitHub agent (step_post_review)
  - Formats findings as inline review comments
  - Posts via: gh pr review <number> --repo owner/repo --comment --body-file review.md
  - Verifies the posted review
```

### Review criteria

| Category | What it catches |
|---|---|
| Correctness | Logic errors, off-by-one, null/undefined, race conditions |
| Security | Injection, auth bypass, secrets in code, OWASP Top 10 |
| Performance | N+1 queries, blocking I/O, unbounded loops, missing indexes |
| Error handling | Swallowed errors, missing validation, leaked internals |
| Testing | Missing coverage, untested edge cases, brittle mocks |
| Style | Convention violations, dead code, naming inconsistencies |

### Review output format

```
SUMMARY: 2-3 sentence overall assessment.

VERDICT: APPROVE | REQUEST_CHANGES | COMMENT

FINDINGS:
1.
- file: path/to/file.ts
- line: 42
- severity: critical | warning | suggestion | nitpick
- description: What's wrong
- suggestion: How to fix it
```

## Troubleshooting

| Issue | Fix |
|---|---|
| Signal returns 400 "expected string, received undefined" | Wrap data in `"payload"` for curl: `{"payload":{"pr_url":"..."}}` |
| "Please connect your github account" | `GH_TOKEN` not in `.env`. Add it and restart: `docker compose restart` |
| `gh` CLI returns 404 / auth error in agent | Token expired or wrong scope. Update `GH_TOKEN` in `.env` and restart |
| SSE stream shows no events | Ensure `-N` flag and `Accept: text/event-stream` header in curl |
| Review agent says "clone directory not found" | Expected — agents are isolated and clone independently |

## Re-loading after workspace.yml edits

**Via the Studio:** Delete the space and re-add it with the updated
`workspace.yml`.

**Via the API:**

```bash
curl -s -X DELETE http://localhost:8080/api/workspaces/<workspace-id>

CONFIG=$(python3 -c "import yaml,json; print(json.dumps(yaml.safe_load(open('pr-review-github/workspace.yml'))))")
curl -s -X POST http://localhost:8080/api/workspaces/create \
  -H 'Content-Type: application/json' \
  -d "{\"config\":$CONFIG,\"workspaceName\":\"PR Review (GitHub)\"}"
```

## Timing

Expect ~8-10 minutes for a full review of a medium-sized pull request (~40 files):
- Step 1 (clone + conventions): ~2 min
- Step 2 (review): ~2-3 min
- Step 3 (format + post): ~2-3 min

## Learn more

- [Quick start](https://platform.hellofriday.ai/docs/getting-started/quickstart) — get FAST running with Docker
- [Agents](https://platform.hellofriday.ai/docs/core-concepts/agents) — built-in and custom agents
- [Jobs](https://platform.hellofriday.ai/docs/core-concepts/jobs) — how workflows orchestrate agents step by step
- [Skills](https://platform.hellofriday.ai/docs/core-concepts/skills) — structured instruction sets for consistent agent output
- [Studio](https://platform.hellofriday.ai/docs/tools/studio) — manage spaces, watch executions, test agents

# PR Code Review Pipeline

Automated pull request code review using Atlas. Accepts a GitHub PR URL, clones
the repository, performs a thorough code review with Claude Code, and posts
structured review comments back on the PR via the `gh` CLI.

## Pipeline

```
Signal: review-pr { pr_url }
         |
    step_clone_repo        Claude Code clones repo, checks out PR, reads conventions
         |
    step_review_pr         Claude Code clones repo, reads full diff + files, reviews against 6 criteria
         |
    step_post_review       Claude Code clones repo, formats review, posts via gh pr review
         |
      completed
```

Each step runs as an isolated Claude Code agent. Steps 2 and 3 re-clone the
repository because agents don't share a filesystem.

## Quick Start

### 1. Set up credentials

Agent env vars resolve in order: **`~/.atlas/.env`** → **repo-root `.env`** →
**Link credentials**.

```bash
# Ensure gh CLI is authenticated (needs repo scope)
gh auth status

# Add both keys to ~/.atlas/.env (loaded by daemon on startup)
echo "GH_TOKEN=$(gh auth token)" >> ~/.atlas/.env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> ~/.atlas/.env

# Verify
grep -E 'GH_TOKEN|ANTHROPIC_API_KEY' ~/.atlas/.env
```

Alternatively, if you're running Link (`deno task dev` or `dev:demo`) and have
connected your Anthropic and GitHub accounts there, both keys resolve
automatically via Link and you can skip the `.env` setup.

### 2. Start the daemon

```bash
deno task dev:demo
```

Wait until you see the daemon is listening on port 8080.

### 3. Register the workspace

**CLI:**

```bash
deno task atlas workspace add examples/pr-review --json
```

**curl:**

```bash
curl -s -X POST http://localhost:8080/api/workspaces/add \
  -H "Content-Type: application/json" \
  -d '{"path":"'"$(pwd)/examples/pr-review"'"}'
```

Note the workspace `id` in the response (e.g., `juicy_falafel`). You'll use it
in the next step.

### 4. Trigger a review

Replace `<WORKSPACE_ID>` with the ID from step 3, and the PR URL with your
target PR.

**CLI (streaming):**

```bash
deno task atlas signal trigger review-pr \
  --workspace <WORKSPACE_ID> \
  --stream \
  --data '{"pr_url":"https://github.com/owner/repo/pull/123"}'
```

**curl (streaming):**

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/signals/review-pr \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"payload":{"pr_url":"https://github.com/owner/repo/pull/123"}}'
```

You'll see SSE events stream in real time as each step starts and completes:

```
data: {"type":"data-fsm-action-execution","data":{"actionType":"code","actionId":"prepare_clone","status":"completed",...}}
data: {"type":"data-fsm-action-execution","data":{"actionType":"agent","actionId":"claude-code","state":"step_clone_repo","status":"started",...}}
data: {"type":"data-tool-progress","data":{"toolName":"Claude Code","content":"Reading CLAUDE.md"}}
...
data: {"type":"data-fsm-state-transition","data":{"fromState":"step_clone_repo","toState":"step_review_pr",...}}
...
data: {"type":"job-complete","data":{"success":true,"status":"completed"}}
data: [DONE]
```

**Without streaming** (blocks until done, returns final result):

```bash
# CLI
deno task atlas signal trigger review-pr \
  --workspace <WORKSPACE_ID> \
  --data '{"pr_url":"https://github.com/owner/repo/pull/123"}'

# curl
curl -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/signals/review-pr \
  -H "Content-Type: application/json" \
  -d '{"payload":{"pr_url":"https://github.com/owner/repo/pull/123"}}'
```

### 5. Monitor progress (alternative)

If you prefer polling instead of SSE:

```bash
# List sessions for the workspace
deno task atlas session list --workspace <WORKSPACE_ID>

# Get session details (use the session ID from above)
deno task atlas session get <SESSION_ID>
# or: curl -s http://localhost:8080/api/sessions/<SESSION_ID> | python3 -m json.tool

# Tail daemon logs
deno task atlas logs --since 5m --human
```

### 6. View the review output from logs

```bash
deno task atlas logs --since 15m | grep "Agent execution result" | python3 -c "
import sys, json
for i, line in enumerate(sys.stdin):
    d = json.loads(line.strip())
    result = json.loads(d['context']['result'])
    data = result.get('data', {})
    if isinstance(data, str): data = json.loads(data)
    response = data.get('response', '')
    if response:
        print(f'=== Step {i+1} Output ===')
        print(response)
        print()
"
```

## How It Works

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
  - Returns { task, config } for the Claude Code agent
  |
  v
Claude Code (step_clone_repo)
  - Clones repo, checks out PR branch
  - Reads README, CLAUDE.md, CONTRIBUTING.md, CODEOWNERS, linter configs
  - Fetches PR metadata via gh pr view
  - Outputs PR metadata + conventions to clone-output
  |
  v
prepare_review(context, event)
  - Reads context.results['pr-details'] and context.results['clone-output']
  - Passes clone_url, pr metadata, conventions to the reviewer
  |
  v
Claude Code (step_review_pr)
  - Clones repo + checks out PR branch (agents are isolated)
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
Claude Code (step_post_review)
  - Clones repo for gh CLI context
  - Formats findings as markdown
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
| Signal returns 400 "expected string, received undefined" | Wrap data in `"payload"` for curl: `{"payload":{"pr_url":"..."}}`. CLI `--data` wraps automatically. |
| "Please connect your github account" | `GH_TOKEN` not in daemon env. Add to `~/.atlas/.env` and restart daemon |
| `gh` CLI returns 404 / auth error in agent | Token expired — run `echo "GH_TOKEN=$(gh auth token)" >> ~/.atlas/.env`, restart daemon |
| Worker "No such file or directory" | Daemon running from stale worktree. `kill -9 $(lsof -ti :8080)` and restart |
| Workspace add fails with config validation | HTTP signals require `config.path` — already set in workspace.yml |
| SSE stream shows no events | curl: ensure `-N` flag and `Accept: text/event-stream` header. CLI: use `--stream` flag. |
| Review agent says "clone directory not found" | Expected — agents are isolated. The review agent clones independently |

## Re-registering after workspace.yml edits

**CLI:**

```bash
deno task atlas workspace remove <WORKSPACE_ID> --yes
deno task atlas workspace add examples/pr-review --json
```

**curl:**

```bash
curl -s -X DELETE http://localhost:8080/api/workspaces/<WORKSPACE_ID>
curl -s -X POST http://localhost:8080/api/workspaces/add \
  -H "Content-Type: application/json" \
  -d '{"path":"'"$(pwd)/examples/pr-review"'"}'
```

## Timing

Expect ~8-10 minutes for a full review of a medium-sized PR (~40 files):
- Step 1 (clone + conventions): ~2 min
- Step 2 (review): ~2-3 min
- Step 3 (format + post): ~2-3 min

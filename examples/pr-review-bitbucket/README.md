# PR Code Review (Bitbucket)

Automated pull request code review for Bitbucket Cloud using [FAST](https://platform.hellofriday.ai/docs/) (Friday Agent Studio & Toolkit). Accepts a Bitbucket pull request
URL, clones the repository, performs a thorough code review with Claude Code, and
posts structured inline comments back on the pull request.

## Pipeline

```
Signal: review-pr { pr_url }
         |
    step_clone_repo        Bitbucket agent clones repo, checks out pull request branch, reads conventions
         |
    step_review_pr         Claude Code reads full diff + changed files, reviews against 6 criteria
         |
    step_post_review       Bitbucket agent formats findings as inline comments, posts review
         |
      completed
```

Also supports a **continue-review** signal that picks up where the last review
left off — responds to author replies on existing threads and reviews new
changes.

## Required credentials

```bash
ANTHROPIC_API_KEY=sk-ant-...
BITBUCKET_EMAIL=your-email
BITBUCKET_TOKEN=your-app-password
```

The Bitbucket app password needs `repository:read`, `repository:write`, and
`pullrequest:write` permissions.

## Quick start

1. Add credentials to your `.env` and start FAST with `docker compose up`
2. Publish the `@tempest/pr-code-review` skill via the Studio (drag the `skill/`
   folder) or API
3. Load the space via the Studio (drag `workspace.yml`) or API:

```bash
CONFIG=$(python3 -c "import yaml,json; print(json.dumps(yaml.safe_load(open('pr-review-bitbucket/workspace.yml'))))")
curl -s -X POST http://localhost:8080/api/workspaces/create \
  -H 'Content-Type: application/json' \
  -d "{\"config\":$CONFIG,\"workspaceName\":\"PR Review (Bitbucket)\"}"
```

4. Trigger a review:

```bash
curl -X POST http://localhost:8080/api/workspaces/<workspace-id>/signals/review-pr \
  -H 'Content-Type: application/json' \
  -d '{"payload":{"pr_url":"https://bitbucket.org/workspace/repo/pull-requests/123"}}'
```

5. Open the Studio at **http://localhost:5200** to watch the execution.

## Connect a Bitbucket webhook (optional)

Instead of triggering manually, you can have Bitbucket send webhooks
automatically when pull requests are created.

1. Open the space in the Studio and find the **Signals** section — copy the
   webhook URL and secret for the `review-pr` signal
2. Go to your Bitbucket repo **Settings → Webhooks → Add webhook**
   (e.g. `https://bitbucket.org/insanelygreatteam/google_workspace_mcp/admin/webhooks`)
3. Fill in:
   - **Title:** `Friday`
   - **URL:** the webhook URL from the Studio
     (e.g. `https://...trycloudflare.com/hook/bitbucket/<workspace-id>/review-pr`)
   - **Secret:** the secret from the Studio
   - **Triggers:** select **Pull Request → Created**
     (optionally also **Updated** for re-reviews on push)
4. Click **Save**

Now creating a pull request in that repo will automatically trigger a review.

## Review criteria

| Category | What it catches |
|---|---|
| Correctness | Logic errors, off-by-one, null/undefined, race conditions |
| Security | Injection, auth bypass, secrets in code, OWASP Top 10 |
| Performance | N+1 queries, blocking I/O, unbounded loops, missing indexes |
| Error handling | Swallowed errors, missing validation, leaked internals |
| Testing | Missing coverage, untested edge cases, brittle mocks |
| Style | Convention violations, dead code, naming inconsistencies |

## Learn more

- [Quick start](https://platform.hellofriday.ai/docs/getting-started/quickstart) — get FAST running with Docker
- [Agents](https://platform.hellofriday.ai/docs/core-concepts/agents) — built-in and custom agents
- [Jobs](https://platform.hellofriday.ai/docs/core-concepts/jobs) — how workflows orchestrate agents step by step
- [Skills](https://platform.hellofriday.ai/docs/core-concepts/skills) — structured instruction sets for consistent agent output
- [Studio](https://platform.hellofriday.ai/docs/tools/studio) — manage spaces, watch executions, test agents

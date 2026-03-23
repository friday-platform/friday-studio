# Friday Developer Platform — Quickstart

Get your Friday distribution running locally with Docker Compose, load a space,
and run your first agentic workflow.

## What you're getting

The Friday developer platform is a configuration-driven agentic orchestration
runtime. Think of it like Kubernetes, but for agentic workloads. You define
**spaces** composed of three building blocks:

- **Signals** — how external events kick off your jobs (webhooks, cron, Slack,
  etc.)
- **Agents** — built-in or custom agents that execute operations (Bitbucket,
  Jira, Claude Code, etc.)
- **Jobs** — workflows composed of agents, tools, skills, and data contracts
  that run step by step

Everything is driven by a single `workspace.yml` configuration file. That makes
it versionable, shareable, and repeatable.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose v2+
- An [Anthropic API key](https://console.anthropic.com/) (powers the Claude
  Code agent)
- A [Bitbucket app password](https://support.atlassian.com/bitbucket-cloud/docs/create-an-app-password/)
  with `repository:read`, `repository:write`, and `pullrequest:write`
  permissions
- A [Jira API token](https://id.atlassian.com/manage-profile/security/api-tokens)
  (for the Jira bug fix example)
- Optionally, a [GitHub personal access token](https://github.com/settings/tokens)
  (for the GitHub PR review example)

## 1. Create your `.env` file

Create a `.env` file with your API keys:

```bash
# Required for all examples — powers the Claude Code agent
ANTHROPIC_API_KEY=sk-ant-...

# Required for the Bitbucket examples
BITBUCKET_USERNAME=your-username
BITBUCKET_TOKEN=your-app-password

# Required for the Jira bug fix example
JIRA_HOST=your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_TOKEN=your-api-token

# Optional — only needed for the GitHub PR review example
GH_TOKEN=ghp_...
```

Only set the keys for the examples you plan to run. `ANTHROPIC_API_KEY` is
always required.

## 2. Create `docker-compose.yml`

Create a `docker-compose.yml` in the same directory as your `.env` file:

```yaml
services:
  platform:
    image: FIXME  # replace with registry URL, e.g. ghcr.io/tempestteam/atlas-platform:latest
    ports:
      - "8080:8080"  # Platform API
      - "3100:3100"  # Link (credential service)
      - "5200:5200"  # Friday Playground
      - "7681:7681"  # Terminal
    env_file:
      - .env
    volumes:
      - friday-data:/data/atlas
      - link-data:/data/link
    restart: unless-stopped

volumes:
  friday-data:
  link-data:
```

## 3. Start the platform

```bash
docker compose up
```

Wait for the startup banner:

```
================================================================
  Friday Platform is ready!

  Friday Playground:   http://localhost:5200
  Daemon API:          http://localhost:8080
================================================================
```

Open **http://localhost:5200** in your browser.

## 4. Add an example space

Your Friday distribution comes with three example spaces you can try right away.
Each one is a `workspace.yml` that defines a complete agentic workflow — agents,
jobs, signals, and data contracts all in one file.

### Available examples

| Example | What it does | Required `.env` keys |
| ------- | ------------ | -------------------- |
| [Bitbucket PR Code Review](../examples/pr-review-bitbucket/workspace.yml) | Clones a Bitbucket repo, reviews the PR diff with Claude Code, posts inline comments back on the PR | `ANTHROPIC_API_KEY`, `BITBUCKET_USERNAME`, `BITBUCKET_TOKEN` |
| [Jira Bug Fix](../examples/jira-bugfix-bitbucket/workspace.yml) | Reads a Jira bug ticket, clones the Bitbucket repo, implements the fix with Claude Code, opens a PR, and comments on the Jira ticket with the PR link | `ANTHROPIC_API_KEY`, `BITBUCKET_USERNAME`, `BITBUCKET_TOKEN`, `JIRA_HOST`, `JIRA_EMAIL`, `JIRA_TOKEN` |
| [Jira Labeled Bug Fix](../examples/jira-bugfix-labeled/workspace.yml) | Searches a Jira project for tickets labeled `ai-fix`, picks the highest-priority one, claims it, implements the fix, creates a PR, and transitions the ticket to Done | `ANTHROPIC_API_KEY`, `BITBUCKET_USERNAME`, `BITBUCKET_TOKEN`, `JIRA_HOST`, `JIRA_EMAIL`, `JIRA_TOKEN` |
| [GitHub PR Code Review](../examples/pr-review/workspace.yml) | Same as the Bitbucket review, but for GitHub PRs | `ANTHROPIC_API_KEY`, `GH_TOKEN` |

### Load via the UI

1. Open **http://localhost:5200** and click **Add Space** in the sidebar
2. **Drag and drop** a `workspace.yml` onto the drop zone, or click
   **Browse files** to select it

![Add space drop zone](images/add-space.png)

3. The space loads and you're taken to its dashboard

![Space dashboard](images/space-dashboard.png)

### Load via the API

You can also load one of the bundled examples directly from the container:

```bash
curl -s http://localhost:8080/api/workspaces \
  -H 'Content-Type: application/json' \
  -d '{"source": "file", "path": "/app/examples/pr-review-bitbucket/workspace.yml"}'
```

Replace the path with the example you want:
- `/app/examples/pr-review-bitbucket/workspace.yml`
- `/app/examples/jira-bugfix-bitbucket/workspace.yml`
- `/app/examples/jira-bugfix-labeled/workspace.yml`
- `/app/examples/pr-review/workspace.yml`

## 5. Trigger a job

Once a space is loaded, kick off a job by sending a signal. Signals are how
external events reach your Friday jobs — in this case, an HTTP webhook.

Replace `<workspace-id>` with the ID returned from step 4.

### Bitbucket PR Review

```bash
curl -X POST http://localhost:8080/api/workspaces/<workspace-id>/signals/review-pr \
  -H 'Content-Type: application/json' \
  -d '{
    "payload": {
      "pr_url": "https://bitbucket.org/workspace/repo/pull-requests/123"
    }
  }'
```

### Jira Bug Fix (specific ticket)

```bash
curl -X POST http://localhost:8080/api/workspaces/<workspace-id>/signals/fix-bug \
  -H 'Content-Type: application/json' \
  -d '{
    "payload": {
      "issue_key": "PROJ-123",
      "repo_url": "https://bitbucket.org/workspace/repo"
    }
  }'
```

### Jira Labeled Bug Fix (auto-pick from backlog)

Searches for tickets with the `ai-fix` label in "To Do" status, picks the
highest-priority one, and runs the full fix pipeline.

```bash
curl -X POST http://localhost:8080/api/workspaces/<workspace-id>/signals/process-labeled-bugs \
  -H 'Content-Type: application/json' \
  -d '{
    "payload": {
      "project_key": "PROJ",
      "repo_url": "https://bitbucket.org/workspace/repo"
    }
  }'
```

### GitHub PR Review

```bash
curl -X POST http://localhost:8080/api/workspaces/<workspace-id>/signals/review-pr \
  -H 'Content-Type: application/json' \
  -d '{
    "payload": {
      "pr_url": "https://github.com/owner/repo/pull/123"
    }
  }'
```

## 6. Watch it run

After triggering a signal:

1. Open the playground at **http://localhost:5200**
2. Click into your space
3. You'll see the execution summary — each step of the workflow is called out
   with its status (succeeded, running, failed)
4. Click a session to see real-time progress as each agent step executes

![Execution summary](images/execution-summary.png)

For the Jira bug fix example, you'll see five steps: the Jira agent reads the
ticket, the Bitbucket agent clones the repo, Claude Code implements the fix,
the Bitbucket agent creates a PR, and the Jira agent comments on the ticket with
the PR link.

## 7. Connect external webhooks

The platform includes a webhook tunnel that creates a public URL via
Cloudflare, so GitHub or Bitbucket can send webhooks directly to your
Friday instance — even when running locally.

The tunnel starts automatically. Check the startup logs for the public URL:

```
docker compose logs | grep "Public URL"
```

Or open any space in the playground — each HTTP signal shows the webhook URL
for your configured providers (GitHub, Bitbucket). Click the URL to see the
setup dialog with the webhook secret.

### Register the webhook

1. Open your space in the playground
2. Find the signal you want to trigger (e.g. `review-pr`)
3. Click the webhook URL line (e.g. "Bitbucket https://...trycloudflare.com/...")
4. Copy the **Webhook URL** and **Secret** from the dialog
5. In your GitHub or Bitbucket repo settings, add a webhook:
   - **URL**: paste the webhook URL
   - **Secret**: paste the secret
   - **Events**: select "Pull requests" (or the relevant event)

Now when a PR is opened in your repo, the webhook fires → tunnel receives it
→ transforms the payload → triggers the signal → your pipeline runs.

### Webhook URL format

```
https://{tunnel-domain}/hook/{provider}/{workspaceId}/{signalId}
```

The `{provider}` determines how the webhook payload is transformed:
- `github` — extracts `pr_url` from GitHub PR events
- `bitbucket` — extracts `pr_url` from Bitbucket PR events
- `jira` — extracts `issue_key`, `project_key` from Jira issue events
- `raw` — forwards the payload as-is (no transformation)

## Stopping the platform

```bash
docker compose down
```

Data persists across restarts in Docker volumes. To start fresh:

```bash
docker compose down -v
```

## Troubleshooting

**Container fails to start:** Check that Docker has at least 4 GB of memory
allocated.

**`ANTHROPIC_API_KEY` errors:** Verify your key is set in `.env` and the
container was restarted after adding it (`docker compose down && docker compose up`).

**Bitbucket/Jira/GitHub auth failures:** Make sure the corresponding tokens in
`.env` have the right permissions:
- **Bitbucket:** App password with `repository:read`, `repository:write`, and
  `pullrequest:write`
- **Jira:** API token from https://id.atlassian.com/manage-profile/security/api-tokens
- **GitHub:** `repo` scope for private repos, or just public repo access

**Logs:** View service logs with:

```bash
docker compose logs -f
```

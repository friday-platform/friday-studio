# Jira Bug Fix (Bitbucket)

End-to-end bug fix pipeline built with [FAST](https://platform.hellofriday.ai/docs/) (Friday Agent Studio & Toolkit). Reads a Jira bug ticket, clones the Bitbucket repo,
implements the fix with Claude Code, opens a pull request, and comments on the Jira ticket
with the link.

## Pipeline

```
Signal: fix-bug { issue_key, repo_url }
         |
    step_read_ticket       Jira agent reads the bug ticket details
         |
    step_clone_repo        Bitbucket agent clones the repository
         |
    step_implement_fix     Claude Code creates a branch, implements the fix, commits
         |
    step_push_branch       Bitbucket agent pushes the feature branch
         |
    step_create_pr         Bitbucket agent opens a pull request with the fix
         |
    step_update_ticket     Jira agent comments on the ticket with the pull request link
         |
      completed
```

The pipeline verifies the ticket has a `bug` label before proceeding.

## Required credentials

```bash
ANTHROPIC_API_KEY=sk-ant-...
BITBUCKET_USERNAME=your-username
BITBUCKET_TOKEN=your-app-password
JIRA_SITE=your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=your-api-token
```

## Quick start

1. Add credentials to your `.env` and start FAST with `docker compose up`
2. Load the space via the Studio (drag `workspace.yml`) or API:

```bash
CONFIG=$(python3 -c "import yaml,json; print(json.dumps(yaml.safe_load(open('jira-bugfix-bitbucket/workspace.yml'))))")
curl -s -X POST http://localhost:8080/api/workspaces/create \
  -H 'Content-Type: application/json' \
  -d "{\"config\":$CONFIG,\"workspaceName\":\"Jira Bug Fix (Bitbucket)\"}"
```

3. Trigger a bug fix:

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

4. Open the Studio at **http://localhost:5200** to watch the execution.

## What happens

1. **Jira agent** reads the ticket — summary, description, labels, priority
2. **Bitbucket agent** clones the repo to an isolated workspace
3. **Claude Code** creates a `fix/<issue-key>` branch, explores the codebase,
   implements the fix, adds tests if applicable, and commits
4. **Bitbucket agent** pushes the branch and opens a pull request
5. **Jira agent** comments on the ticket with a link to the pull request

A human reviews the pull request before merging — because ultimately, a person is
responsible for what gets shipped.

## Connect a Jira webhook (optional)

Instead of triggering manually, you can have Jira send webhooks when issues are
created or updated.

1. Open the space in the Studio and find the **Signals** section — copy the
   webhook URL and secret for the `fix-bug` signal
2. Go to **https://insanelygreatteam.atlassian.net/plugins/servlet/webhooks**
3. Click **Create a WebHook**
4. Fill in:
   - **Name:** `Friday`
   - **URL:** the webhook URL from the Studio
     (e.g. `https://...trycloudflare.com/hook/jira/<workspace-id>/fix-bug`)
   - **Secret:** the secret from the Studio
     (Jira signs payloads with HMAC via the `X-Hub-Signature` header)
   - **Events:** check **Issue → created** and/or **Issue → updated**
5. Click **Save**

Now when a Jira bug ticket is created or updated, the pipeline triggers
automatically — reads the ticket, clones the repo, implements the fix, and opens
a pull request.

## Learn more

- [Quick start](https://platform.hellofriday.ai/docs/getting-started/quickstart) — get FAST running with Docker
- [Agents](https://platform.hellofriday.ai/docs/core-concepts/agents) — built-in and custom agents
- [Jobs](https://platform.hellofriday.ai/docs/core-concepts/jobs) — how workflows orchestrate agents step by step
- [Signals](https://platform.hellofriday.ai/docs/core-concepts/signals) — how external events trigger jobs
- [Studio](https://platform.hellofriday.ai/docs/tools/studio) — manage spaces, watch executions, test agents

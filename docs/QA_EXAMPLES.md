# Friday Examples — QA Checklist

Repeatable end-to-end verification for all example workspaces.
Run this after any changes to workspace config, bundled agents, or credential
resolution.

## Prerequisites

### 1. Start the platform
- [ ] Run `docker compose up --build -d`
- [ ] Wait for the startup banner in `docker compose logs`
- [ ] Open **http://localhost:5200** — playground loads with sidebar visible

### 2. Configure credentials
- [ ] Create a `.env` file with valid credentials:
  - `ANTHROPIC_API_KEY` — required for all examples
  - `GH_TOKEN` — GitHub PAT (for GitHub PR review)
  - `BITBUCKET_USERNAME` — Bitbucket email (for Bitbucket examples)
  - `BITBUCKET_TOKEN` — Bitbucket app password
  - `JIRA_SITE` — Atlassian hostname (e.g. `acme.atlassian.net`)
  - `JIRA_EMAIL` — Jira account email
  - `JIRA_API_TOKEN` — Jira API token

### 3. Publish the PR code review skill
- [ ] Click **Skills** in the sidebar
- [ ] Drag the `pr-review/skill/` folder onto the drop zone (includes
      `SKILL.md` + `references/` directory)
- [ ] Verify `@tempest/pr-code-review` appears in the skill catalog

### 4. Load all example workspaces
For each workspace.yml (`pr-review`, `pr-review-bitbucket`,
`jira-bugfix-bitbucket`, `jira-bugfix-labeled`):
- [ ] Click **Add Space** in the sidebar
- [ ] Drag the `workspace.yml` file onto the drop zone, or click
      **Browse files** to select it
- [ ] Verify the workspace appears in the sidebar

### 5. Verify integrations
For each workspace:
- [ ] Click into the workspace in the sidebar
- [ ] Check the **Integrations** section — all env vars should show green
      dots with "env var" labels
- [ ] If any show red, the `.env` is missing that credential

---

## Test 1: GitHub PR Code Review

### Trigger via UI
- [ ] Click **PR Code Review Pipeline** in the sidebar
- [ ] Click **Run** on the "PR Code Review" job
- [ ] Enter a GitHub pull request URL (e.g.
      `https://github.com/owner/repo/pull/123`)
- [ ] Click **Run**

### Verify execution
- [ ] Session appears in **Recent Runs** with status indicator
- [ ] Pipeline steps show: `step_clone_repo` → `step_review_pr` →
      `step_post_review`
- [ ] All steps complete with green checkmarks
- [ ] Click **View all runs** → click the session to see step details

### Verify result
- [ ] Open the GitHub PR in a browser
- [ ] Review comments are posted (inline or as a review)

---

## Test 2: Bitbucket PR Code Review

### Trigger via UI
- [ ] Click **PR Code Review Pipeline (Bitbucket)** in the sidebar
- [ ] Click **Run** on the "PR Code Review" job
- [ ] Enter a Bitbucket pull request URL (e.g.
      `https://bitbucket.org/workspace/repo/pull-requests/37`)
- [ ] Click **Run**

### Verify execution
- [ ] 3 steps complete: `step_clone_repo` → `step_review_pr` →
      `step_post_review`
- [ ] Status: **Complete** (green)

### Verify result
- [ ] Open the Bitbucket PR in a browser
- [ ] Inline review comments are posted

---

## Test 3: Jira Bug Fix

### Prerequisites
- [ ] Jira ticket exists in target project with `bug` label
  (create one if needed via Jira UI or API)

### Trigger via UI
- [ ] Click **Jira Bug Fix Pipeline (Bitbucket)** in the sidebar
- [ ] Click **Run** on the "Jira Bug Fix" job
- [ ] Enter the Jira issue key (e.g. `DEV-6`)
- [ ] Enter the Bitbucket repo URL (e.g.
      `https://bitbucket.org/workspace/repo`)
- [ ] Click **Run**

### Verify execution
- [ ] 6 steps complete: read ticket → clone → implement fix → push →
      create PR → comment on ticket
- [ ] Status: **Complete** (green)

### Verify result
- [ ] Open Bitbucket — new PR exists with branch `fix/<issue-key>`
- [ ] Open Jira ticket — comment with PR link added

---

## Test 4: Jira Labeled Bug Fix

### Prerequisites
- [ ] Jira ticket exists in target project with `ai-fix` label in
      "To Do" status (create one if needed)

### Trigger via UI
- [ ] Click **Jira Labeled Bug Fix Pipeline** in the sidebar
- [ ] Click **Run** on the "Labeled Bug Fix" job
- [ ] Enter the Jira project key (e.g. `DEV`)
- [ ] Enter the Bitbucket repo URL
- [ ] Click **Run**

### Verify execution
- [ ] 8 steps complete: search → claim → clone → implement → push →
      create PR → comment → transition
- [ ] Status: **Complete** (green)

### Verify result
- [ ] Open Bitbucket — new PR exists
- [ ] Open Jira — ticket transitioned to Done with PR link comment

---

## Test 5: Webhook Integration

For each workspace, test that external webhooks trigger pipelines:

### Setup
- [ ] Open the workspace in the playground
- [ ] Find the **Signals** section — each signal shows the webhook URL
      (e.g. `https://...trycloudflare.com/hook/bitbucket/<id>/review-pr`)

### Configure webhook
- [ ] **GitHub:** Repo Settings → Webhooks → Add webhook
  - URL: the tunnel webhook URL
  - Content type: `application/json`
  - Secret: from the playground
  - Events: Pull requests
- [ ] **Bitbucket:** Repo Settings → Webhooks → Add webhook
  - URL: the tunnel webhook URL
  - Secret: from the playground
  - Events: Pull Request — Created
- [ ] **Jira:** Project Settings → Webhooks → Add webhook
  - URL: the tunnel webhook URL
  - Secret: from the playground
  - Events: Issue updated

### Trigger
- [ ] Perform the real action (open a PR, update a ticket)
- [ ] Verify the pipeline starts automatically in the playground

---

## Teardown

- [ ] Remove webhooks from GitHub/Bitbucket/Jira settings
- [ ] Delete test Jira tickets if created for testing
- [ ] Stop Docker: `docker compose down`
- [ ] To reset all data: `docker compose down -v`

# Friday Examples — QA Checklist

Repeatable end-to-end verification for all example workspaces.
Run this after any changes to workspace config, bundled agents, or credential
resolution.

## Prerequisites

### 1. Start the platform
- [ ] Run `docker compose up --build -d`
- [ ] Wait for the startup banner in `docker compose logs`
- [ ] Open **http://localhost:5200** — Studio loads with sidebar visible

### 2. Configure credentials
- [ ] Create a `.env` file with valid credentials:
  - `ANTHROPIC_API_KEY` — required for all examples
  - `GH_TOKEN` — GitHub PAT (for GitHub PR review)
  - `BITBUCKET_EMAIL` — Atlassian account email (for Bitbucket examples)
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

Test that external webhooks trigger pipelines automatically.

### 5a. Find the webhook URL and secret

1. Open the Studio at **http://localhost:5200**
2. Click into your space in the sidebar
3. Look at the **Signals** section — each signal shows:
   - The full webhook URL (e.g. `https://...trycloudflare.com/hook/bitbucket/<workspace-id>/review-pr`)
   - The webhook secret (click to reveal/copy)

The URL format is:

```
https://{tunnel-domain}/hook/{provider}/{workspaceId}/{signalId}
```

Where `{provider}` is `github`, `bitbucket`, `jira`, or `raw`.

### 5b. Configure Bitbucket webhook

1. Go to your repo settings:
   **https://bitbucket.org/your-org/your-repo/admin/webhooks**
2. Click **Add webhook**
3. Fill in:
   - **Title:** `Friday`
   - **URL:** paste the webhook URL from the Studio
     (use the `bitbucket` provider URL, e.g.
     `https://...trycloudflare.com/hook/bitbucket/<workspace-id>/review-pr`)
   - **Secret:** paste the secret from the Studio
   - **Triggers:** select **Pull Request → Created**
     (optionally also **Updated** for re-reviews on push)
4. Click **Save**

- [ ] Webhook created and shows as active in Bitbucket settings

**Test it:**
- [ ] Open a new pull request in the repo (or use an existing one:
      [PR #40](https://bitbucket.org/your-org/your-repo/pull-requests/40),
      [PR #41](https://bitbucket.org/your-org/your-repo/pull-requests/41),
      [PR #42](https://bitbucket.org/your-org/your-repo/pull-requests/42))
- [ ] Verify the pipeline starts automatically in the Studio
- [ ] Verify review comments appear on the pull request

### 5c. Configure GitHub webhook

1. Go to your repo settings:
   **https://github.com/{owner}/{repo}/settings/hooks**
2. Click **Add webhook**
3. Fill in:
   - **Payload URL:** paste the webhook URL from the Studio
     (use the `github` provider URL, e.g.
     `https://...trycloudflare.com/hook/github/<workspace-id>/review-pr`)
   - **Content type:** select **`application/json`**
     (required — the default `application/x-www-form-urlencoded` will not work)
   - **Secret:** paste the secret from the Studio
   - **Which events:** select **Let me select individual events** →
     check **Pull requests**
4. Click **Add webhook**

- [ ] Webhook created and shows green checkmark after first ping

**Test it:**
- [ ] Open a new pull request in the repo
- [ ] Verify the pipeline starts automatically in the Studio
- [ ] Verify review comments appear on the pull request

### 5d. Configure Jira webhook

1. Go to Jira webhook settings:
   **https://your-team.atlassian.net/plugins/servlet/webhooks**
2. Click **Create a WebHook**
3. Fill in:
   - **Name:** `Friday`
   - **URL:** paste the webhook URL from the Studio
     (use the `jira` provider URL, e.g.
     `https://...trycloudflare.com/hook/jira/<workspace-id>/fix-bug`)
   - **Secret:** paste the secret from the Studio
     (Jira signs payloads with HMAC via the `X-Hub-Signature` header)
   - **Events:** check **Issue → updated**
     (triggers when labels like `ai-fix` are added)
4. Click **Save**

- [ ] Webhook created and shows as active in Jira settings

**Test it:**
Use one of the pre-created test tickets:
- [DEV-8](https://your-team.atlassian.net/browse/DEV-8) — calendar cache bug (High)
- [DEV-9](https://your-team.atlassian.net/browse/DEV-9) — filename truncation (Medium)
- [DEV-10](https://your-team.atlassian.net/browse/DEV-10) — email validation (Medium)

All three have the `ai-fix` and `bug` labels and are in "To Do" status.

- [ ] Update a ticket (e.g. change priority or add a comment) to fire the webhook
- [ ] Verify the pipeline starts automatically in the Studio
- [ ] Verify the fix branch and pull request are created in Bitbucket
- [ ] Verify the Jira ticket is updated with the pull request link

### 5e. Verify webhook delivery

If a webhook doesn't trigger a pipeline:

**Bitbucket:** Go to repo **Settings → Webhooks** → click the webhook →
**View requests** to see delivery history and response codes.

**GitHub:** Go to repo **Settings → Webhooks** → click the webhook →
**Recent Deliveries** tab to inspect payloads and responses.

**Jira:** Webhook delivery logs are not available in the UI. Check the
Friday platform logs: `docker compose logs -f | grep webhook`

---

## Teardown

- [ ] Remove webhooks from GitHub/Bitbucket/Jira settings
- [ ] Delete test Jira tickets if created for testing
- [ ] Stop Docker: `docker compose down`
- [ ] To reset all data: `docker compose down -v`

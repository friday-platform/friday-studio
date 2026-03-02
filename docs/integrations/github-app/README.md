# GitHub MCP Server — GitHub App Permissions

Reference for configuring a GitHub App to work with the
[GitHub MCP Server](https://github.com/github/github-mcp-server). Maps each
tool to the exact GitHub App permission it needs.

```
MCP Tool → GitHub API Endpoint → Required GitHub App Permission
```

---

## Quick Start: Permission Presets

### Minimal (Read-Only)

| Category       | Permission    | Level |
| -------------- | ------------- | ----- |
| **Repository** | Contents      | Read  |
| **Repository** | Issues        | Read  |
| **Repository** | Pull requests | Read  |
| **Repository** | Metadata      | Read *(auto-granted)* |

Enables: `repos` (read), `issues` (read), `pull_requests` (read), `context`
(default ON), plus `git` (requires `--toolsets` to enable)

### Standard Development

| Category         | Permission    | Level |
| ---------------- | ------------- | ----- |
| **Repository**   | Contents      | Write |
| **Repository**   | Issues        | Write |
| **Repository**   | Pull requests | Write |
| **Repository**   | Metadata      | Read *(auto-granted)* |
| **Organization** | Members       | Read  |

Enables: `repos`, `issues`, `pull_requests`, `users`, `context` (default ON),
plus `git`, `labels` (require `--toolsets` to enable)

### Full Access

| Category         | Permission                     | Level |
| ---------------- | ------------------------------ | ----- |
| **Repository**   | Contents                       | Write |
| **Repository**   | Issues                         | Write |
| **Repository**   | Pull requests                  | Write |
| **Repository**   | Actions                        | Write |
| **Repository**   | Administration                 | Write |
| **Repository**   | Commit statuses                | Read  |
| **Repository**   | Checks                         | Read  |
| **Repository**   | Code scanning alerts           | Read  |
| **Repository**   | Secret scanning alerts         | Read  |
| **Repository**   | Dependabot alerts              | Read  |
| **Repository**   | Discussions                    | Read  |
| **Repository**   | Repository security advisories | Write |
| **Organization** | Members                        | Read  |
| **Organization** | Projects                       | Write |
| **Account**      | Starring                       | Write |
| **Account**      | Gists                          | Write |

> Account permissions only work with User Access Tokens (UAT), not installation
> tokens. Notifications only work with classic PATs — no GitHub App equivalent.

---

## Tool → Permission Matrix

### Context (`context`) — Default: ON

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `get_me` | R | *(any valid token)* | — |
| `get_teams` | R | Organization: Members | Read |
| `get_team_members` | R | Organization: Members | Read |

### Repos (`repos`) — Default: ON

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `search_repositories` | R | *(none — scoped by token)* | — |
| `get_file_contents` | R | Contents | Read |
| `list_commits` | R | Contents | Read |
| `search_code` | R | *(none — scoped by token)* | — |
| `get_commit` | R | Contents | Read |
| `list_branches` | R | Contents | Read |
| `list_tags` | R | Metadata | Read |
| `get_tag` | R | Contents | Read |
| `list_releases` | R | Contents | Read |
| `get_latest_release` | R | Contents | Read |
| `get_release_by_tag` | R | Contents | Read |
| `create_or_update_file` | W | Contents | Write |
| `create_repository` | W | Administration | Write |
| `fork_repository` | W | Administration (Write) + Contents (Read) | Write |
| `create_branch` | W | Contents | Write |
| `push_files` | W | Contents | Write |
| `delete_file` | W | Contents | Write |

### Git (`git`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `get_repository_tree` | R | Contents | Read |

### Issues (`issues`) — Default: ON

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `issue_read` | R | Issues | Read |
| `search_issues` | R | *(none — scoped by token)* | — |
| `list_issues` | R | Issues | Read |
| `list_issue_types` | R | Organization: Issue types | Read |
| `issue_write` | W | Issues | Write |
| `add_issue_comment` | W | Issues | Write |
| `sub_issue_write` | W | Issues | Write |

### Pull Requests (`pull_requests`) — Default: ON

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `pull_request_read` | R | Pull requests | Read |
| `pull_request_read` (get_status) | R | Pull requests + Commit statuses | Read |
| `pull_request_read` (get_check_runs) | R | Pull requests + Checks | Read |
| `list_pull_requests` | R | Pull requests | Read |
| `search_pull_requests` | R | *(none — scoped by token)* | — |
| `create_pull_request` | W | Pull requests | Write |
| `update_pull_request` | W | Pull requests | Write |
| `merge_pull_request` | W | Contents | Write |
| `update_pull_request_branch` | W | Pull requests | Write |
| `pull_request_review_write` | W | Pull requests | Write |
| `add_comment_to_pending_review` | W | Pull requests | Write |
| `add_reply_to_pull_request_comment` | W | Pull requests | Write |

### Users (`users`) — Default: ON

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `search_users` | R | *(none — scoped by token)* | — |

### Organizations (`orgs`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `search_orgs` | R | *(none — scoped by token)* | — |

### Copilot (`copilot`) — Default: ON

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `assign_copilot_to_issue` | W | Issues + Pull requests + Contents + Actions (Write) + Metadata (Read) | Write + Read |
| `request_copilot_review` | W | Pull requests | Write |

### Actions (`actions`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `actions_list` | R | Actions | Read |
| `actions_get` | R | Actions | Read |
| `actions_run_trigger` | W | Actions | Write |
| `get_job_logs` | R | Actions | Read |

### Code Security (`code_security`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `get_code_scanning_alert` | R | Code scanning alerts | Read |
| `list_code_scanning_alerts` | R | Code scanning alerts | Read |

### Secret Protection (`secret_protection`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `get_secret_scanning_alert` | R | Secret scanning alerts | Read |
| `list_secret_scanning_alerts` | R | Secret scanning alerts | Read |

### Dependabot (`dependabot`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `get_dependabot_alert` | R | Dependabot alerts | Read |
| `list_dependabot_alerts` | R | Dependabot alerts | Read |

### Discussions (`discussions`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `list_discussions` | R | Discussions | Read |
| `get_discussion` | R | Discussions | Read |
| `get_discussion_comments` | R | Discussions | Read |
| `list_discussion_categories` | R | Discussions | Read |

> "Discussions" is not listed on the
> [official permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).
> It may exist in the App settings UI but is undocumented.

### Notifications (`notifications`) — Default: OFF

| Tool | R/W | Token Requirement |
| ---- | --- | ----------------- |
| `list_notifications` | R | Classic PAT only (`notifications` or `repo` scope) |
| `get_notification_details` | R | Classic PAT only (`notifications` or `repo` scope) |
| `dismiss_notification` | W | Classic PAT only (`notifications` or `repo` scope) |
| `mark_all_notifications_read` | W | Classic PAT only (`notifications` or `repo` scope) |
| `manage_notification_subscription` | W | Classic PAT only (`notifications` or `repo` scope) |
| `manage_repository_notification_subscription` | W | Classic PAT only (`notifications` or `repo` scope) |

> **No GitHub App permission equivalent.** These endpoints only work with
> classic Personal Access Tokens.

### Gists (`gists`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `list_gists` | R | *(none)* | — |
| `get_gist` | R | *(none)* | — |
| `create_gist` | W | Account: Gists | Write |
| `update_gist` | W | Account: Gists | Write |

> Write tools require a User Access Token (UAT) — not installation tokens.

### Security Advisories (`security_advisories`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `list_global_security_advisories` | R | *(none — public data)* | — |
| `get_global_security_advisory` | R | *(none — public data)* | — |
| `list_repository_security_advisories` | R | Repository security advisories | Read |
| `list_org_repository_security_advisories` | R | Repository security advisories | **Write** |

> Org-level listing requires Write, not Read. GitHub API quirk.

### Projects (`projects`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `projects_list` | R | Organization: Projects | Read |
| `projects_get` | R | Organization: Projects | Read |
| `projects_write` | W | Organization: Projects | Write |

> User-owned projects (`/users/`) have no GitHub App permission — classic PAT
> only.

### Stargazers (`stargazers`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `list_starred_repositories` | R | Account: Starring | Read |
| `star_repository` | W | Account: Starring (Write) + Metadata (Read) | Write + Read |
| `unstar_repository` | W | Account: Starring (Write) + Metadata (Read) | Write + Read |

> Requires User Access Token (UAT) — not installation tokens.

### Labels (`labels`) — Default: OFF

| Tool | R/W | Permission | Level |
| ---- | --- | ---------- | ----- |
| `get_label` | R | Issues | Read |
| `list_label` | R | Issues | Read |
| `label_write` | W | Issues | Write |

---

## Key Caveats

1. **Metadata is auto-granted** — any repository permission includes Metadata:
   Read
2. **Write implies Read** — no need to set both
3. **Search endpoints need no specific permission** — results are scoped by
   token access
4. **Installation tokens (IAT)** cannot use account-level permissions (starring,
   gists, notifications)
5. **User tokens (UAT)** can use account permissions but still can't do
   notifications
6. **`merge_pull_request` needs Contents: Write**, not Pull requests: Write
7. **Workflow files** (`.github/workflows/`) may need additional Workflows: Write
   permission
8. **`--read-only` flag** disables all write tools regardless of token
   permissions

---

## Token Types

| Token | Use Case | Account Permissions? |
| ----- | -------- | -------------------- |
| **Installation Access Token (IAT)** | Bot/automated operations | No |
| **User Access Token (UAT)** | User-initiated via GitHub App OAuth | Yes |
| **Classic PAT** | Direct user auth (only option for notifications) | Yes |

> **Note**: Three additional toolsets exist but are omitted from this reference:
> `dynamic` (meta-toolset that discovers others at runtime), `copilot_spaces`
> and `github_support_docs_search` (remote/hosted mode only).

---

## See Also

- [GitHub MCP Server](https://github.com/github/github-mcp-server)
- [GitHub App Permissions Reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)

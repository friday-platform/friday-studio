# Friday Analytics

We track user behavior to understand how people use Atlas and where they get stuck. This data helps us answer questions like "Are users getting value from Atlas?" and "Where do we lose people?"

## Activation Funnel

Our north star metric is **activation rate** - users who successfully execute at least one job. A successful job means Atlas actually did useful work for them.

```
              THE ACTIVATION FUNNEL (illustration)

    Signed Up          ████████████████████  100%
         ↓
    Profile Done       ███████████████████
         ↓
    Created Workspace  █████████████████
         ↓
    Executed Job       ██████████████
         ↓
    Job Succeeded      █████████████         ← ACTIVATED
```

Each drop-off represents users who got stuck or lost interest. Check the dashboard for real numbers.

## What We Track

| Event                    | What It Means                             | Journey Phase            |
|--------------------------|-------------------------------------------|--------------------------|
| `user.signed_up`         | New account created                       | Getting Started          |
| `user.profile_completed` | Filled out profile                        | Getting Started          |
| `user.logged_in`         | Returned to Atlas                         | Getting Started          |
| `conversation.started`   | Started chatting with Atlas               | Getting Started          |
| `workspace.created`      | Created a workspace                       | Set Up                   |
| `session.started`        | Job began executing                       | Execution & Monitoring   |
| `session.completed`      | Job finished successfully ← **ACTIVATED** | Execution & Monitoring   |
| `session.failed`         | Job hit an error                          | Execution & Monitoring   |
| `artifact.created`       | Saved a file or output                    | Execution & Monitoring   |
| `gist.created`           | Shared results via gist                   | Execution & Monitoring   |

*Note: Code uses "session" internally, but this maps to "job" in user-facing language.*

## The Dashboard

**[Open Dashboard](https://tempestteam.grafana.net/d/c89e9e3c-71af-4d62-87cf-a2745b85a8f8)** (login with Google OAuth)

### Top Row: Key Numbers

- **Total Signups** - How many people created accounts (volume)
- **Activated Users** - How many successfully executed a job (quality)
- **Activation Rate** - Signups → Activated conversion (efficiency)
- **Job Success Rate** - Are jobs working? (reliability)
- **Median Time to Activation** - How fast do users get value? (friction)
- **Total Artifacts / Gists** - Output volume (engagement depth)

### Funnel Charts

Shows where users drop off, broken down by weekly signup cohort. Look for:

- **Steep drops** = friction points to investigate
- **Improving trend** = recent changes are helping
- **Cohort variation** = external factors or feature changes

### Time to Milestone

How long it takes users to reach each step. Look for:

- **Long times early** = onboarding friction
- **Long times late** = complexity in advanced features
- **Getting faster** = UX improvements working

### Job Outcomes

Success vs failure rates over time. Look for:

- **Declining success** = regressions or new failure modes
- **Cohort patterns** = new users vs experienced users behave differently

## Reading the Data: Common Questions

### "Why is activation rate dropping?"

1. Open the funnel chart
2. Compare recent cohorts to older ones
3. Find where the biggest drop-off increase is
4. That's your friction point to investigate

### "Are jobs getting more reliable?"

1. Check job success rate trend
2. Look at failed jobs count
3. Cross-reference with recent deploys

### "Are users sticking around?"

1. Check usage per user table
2. Look at jobs per user and active days
3. Higher numbers = more engagement

### "Is onboarding too slow?"

1. Check time to first conversation
2. If >1 hour, setup might be confusing
3. Check time to first job for workspace friction

## Data Access

### Grafana (Visual)

Best for: Quick checks, sharing screenshots, trends

[Open Dashboard](https://tempestteam.grafana.net/d/c89e9e3c-71af-4d62-87cf-a2745b85a8f8)

### BigQuery (Raw Data)

Best for: Custom analysis, deep dives, exports

**Table:** `tempest-production.friday_analytics.analytics_events`

```
+---------------------+----------------------+--------------------------------------+-----------------+--------------------+--------------------------------------+-----------------------+------------------------------------------+-------------+----------+
|      timestamp      |      event_name      |               event_id               |     user_id     |    workspace_id    |              session_id              |    conversation_id    |                 job_name                 | environment | metadata |
+---------------------+----------------------+--------------------------------------+-----------------+--------------------+--------------------------------------+-----------------------+------------------------------------------+-------------+----------+
| 2026-01-17 00:01:21 | artifact.created     | 77a1d70a-4e4f-446c-87ab-f6881d68ef76 | d401m99q1relnrg |                    |                                      |                       |                                          | production  |          |
| 2026-01-16 20:40:33 | conversation.started | 6b52752b-440f-4f12-a890-0c354dc48563 | 2k946k19mpydppp | atlas-conversation |                                      | GxnTz-NY2nLfQ8EN5Zapj |                                          | production  |          |
| 2026-01-16 20:41:08 | job.defined          | 719ad643-827e-4b91-8c2d-d9bdfe3a35ec | 2k946k19mpydppp | chewy_carrot       |                                      |                       | weekly-coding-models-research-and-report | production  |          |
| 2026-01-16 20:43:15 | session.completed    | a01e494b-d49d-461b-89f5-3e052ae39339 | 2k946k19mpydppp | atlas-conversation | 9bb62da3-852c-4d33-aae1-603b8b8a7f20 |                       | workspace                                | production  |          |
| 2026-01-16 20:40:34 | session.started      | 89be3180-fcdd-4300-8e93-875cd5f2f845 | 2k946k19mpydppp | atlas-conversation | 9bb62da3-852c-4d33-aae1-603b8b8a7f20 |                       | workspace                                | production  |          |
| 2026-01-16 20:35:48 | user.logged_in       | d6ae3036-5d6a-469f-8c9a-b41a0f1747e4 | 2k946k19mpydppp |                    |                                      |                       |                                          | production  |          |
+---------------------+----------------------+--------------------------------------+-----------------+--------------------+--------------------------------------+-----------------------+------------------------------------------+-------------+----------+
```

**Pre-built views:**

| View | Use For |
|------|---------|
| `overall_summary` | Current totals for reporting |
| `activation_funnel_by_cohort` | Weekly funnel breakdown |
| `time_to_activation_by_cohort` | Speed analysis |
| `session_success_by_cohort` | Job reliability trends |
| `usage_summary_by_cohort` | Engagement depth |

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Atlas     │     │    OTel     │     │  BigQuery   │     │   Grafana   │
│  Services   │ ──▶ │  Collector  │ ──▶ │   Tables    │ ──▶ │  Dashboard  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
     emit              transform           store              visualize
```

Events tagged with `log.type=analytics` flow automatically to BigQuery. Only production events appear in dashboards.

## For Engineers: Adding Events

See the [analytics skill](../.claude/skills/analytics/SKILL.md) for step-by-step instructions on adding new events, updating BigQuery views, and modifying the dashboard.

Quick version:
1. Add constant to `packages/analytics/src/types.ts` and `pkg/analytics/analytics.go`
2. Emit from the relevant service
3. Update BigQuery views if it's a dashboard metric
4. Update this README if it's user-facing

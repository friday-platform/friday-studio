# Analytics Dashboard Setup

## Quick Start

1. Run the SQL in `activation_metrics.sql` to create BigQuery views
2. In Looker Studio, add BigQuery data source → select views
3. Build charts using the structure below

## BigQuery Views

| View | Purpose | Use For |
|------|---------|---------|
| `user_cohorts` | Base cohort assignment | Join key |
| `user_funnel_events` | First event per user | User-level analysis |
| `activation_funnel_by_cohort` | Funnel conversion rates | Funnel chart |
| `time_to_activation_by_cohort` | Time to milestones | Time series |
| `session_success_by_cohort` | Success/failure rates | Success rate chart |
| `user_usage_metrics` | Per-user activity | User table |
| `usage_summary_by_cohort` | Aggregated usage | Usage charts |
| `overall_summary` | High-level KPIs | Scorecards |

## Dashboard Structure

### Page 1: Activation Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  SCORECARDS (from overall_summary)                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Total    │ │ Activated│ │ Activation│ │ Total   │ │ Median   │  │
│  │ Signups  │ │ Users    │ │ Rate %   │ │ Sessions│ │ Time(hrs)│  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│  FUNNEL CHART (from activation_funnel_by_cohort)                   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Signup → Conversation → Workspace → Run Triggered → Success │   │
│  │ 100%      85%            62%         48%            41%     │   │
│  └─────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  COHORT TABLE (from activation_funnel_by_cohort)                   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Cohort Week │ Signups │ % Conv │ % Workspace │ % Activated │   │
│  │ 2026-01-13  │    52   │  84%   │     58%     │     38%     │   │
│  │ 2026-01-06  │    47   │  87%   │     64%     │     45%     │   │
│  │ ...         │   ...   │  ...   │     ...     │     ...     │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Page 2: Time to Activation

```
┌─────────────────────────────────────────────────────────────────────┐
│  LINE CHART: Time to First Success by Cohort                       │
│  (from time_to_activation_by_cohort)                               │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │     ^                                                       │   │
│  │ hrs │    ╱╲                                                │   │
│  │     │   ╱  ╲___╱╲                                          │   │
│  │     │  ╱         ╲____                                     │   │
│  │     └──────────────────────────────────────────────────▶   │   │
│  │       Week 1   Week 2   Week 3   Week 4   Week 5          │   │
│  └─────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  BAR CHART: Avg Hours to Each Milestone                            │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ First Conversation  ████ 0.5 hrs                           │   │
│  │ First Workspace     ████████ 2.1 hrs                       │   │
│  │ First Run           ████████████ 4.8 hrs                   │   │
│  │ First Success       ████████████████ 6.2 hrs               │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Page 3: Session Success Rate

```
┌─────────────────────────────────────────────────────────────────────┐
│  STACKED BAR: Session Outcomes by Cohort                           │
│  (from session_success_by_cohort)                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Week 5 │████████████████████░░░░│ 82% success              │   │
│  │ Week 4 │███████████████████░░░░░│ 78% success              │   │
│  │ Week 3 │████████████████████░░░░│ 81% success              │   │
│  │        └────────────────────────────────────────────────▶  │   │
│  │         ████ Success  ░░░░ Failed                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  TABLE: Session Metrics by Cohort                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Cohort │ Total │ Success │ Failed │ Incomplete │ Rate %   │   │
│  │ Jan 13 │  124  │   102   │   18   │     4      │  82.3%   │   │
│  │ Jan 06 │  156  │   122   │   28   │     6      │  78.2%   │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Page 4: Usage Metrics

```
┌─────────────────────────────────────────────────────────────────────┐
│  LINE CHART: Usage Trends by Cohort                                │
│  (from usage_summary_by_cohort)                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Metrics: Avg sessions/user, Avg workspaces/user             │   │
│  │     ^                                                       │   │
│  │     │      ___                                              │   │
│  │     │   __╱   ╲__                                           │   │
│  │     │  ╱         ╲___                                       │   │
│  │     └──────────────────────────────────────────────────▶   │   │
│  └─────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  TABLE: User Activity (from user_usage_metrics)                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ User ID │ Cohort │ Convos │ Workspaces │ Sessions │ Days   │   │
│  │ abc123  │ Jan 13 │    5   │     2      │    12    │   4    │   │
│  │ def456  │ Jan 13 │    3   │     1      │     8    │   3    │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Looker Studio Setup Steps

### 1. Create BigQuery Views

```bash
# Run in BigQuery console or via bq command
bq query --use_legacy_sql=false < activation_metrics.sql
```

### 2. Create Looker Studio Report

1. Go to https://lookerstudio.google.com
2. Click **Create** → **Report**
3. Add data source: **BigQuery**
4. Select project: `tempest-production`
5. Select dataset: `friday_analytics`
6. Add each view as a separate data source

### 3. Build Charts

For each chart type:

| Chart | Data Source | Dimension | Metrics |
|-------|-------------|-----------|---------|
| Funnel | `activation_funnel_by_cohort` | - | total_signups, users_with_conversation, users_with_workspace, users_with_session_started, users_with_session_completed |
| Cohort Table | `activation_funnel_by_cohort` | cohort_week | pct_conversation, pct_workspace, pct_session_completed |
| Time to Activation | `time_to_activation_by_cohort` | cohort_week | avg_hours_to_first_success |
| Success Rate | `session_success_by_cohort` | cohort_week | success_rate_pct, failure_rate_pct |
| Usage | `usage_summary_by_cohort` | cohort_week | avg_sessions_per_user, avg_workspaces_per_user |
| Scorecards | `overall_summary` | - | total_signups, activated_users, overall_activation_rate_pct |

### 4. Add Date Filter

Add a date range control that filters by `cohort_week` to let users select specific cohorts.

## Calculated Fields (Optional)

If you need custom calculations in Looker Studio:

```
// Week-over-week change
WoW_Change = (Current - Previous) / Previous * 100

// Activation rate
Activation_Rate = users_with_session_completed / total_signups * 100
```

-- ============================================================================
-- ACTIVATION METRICS DASHBOARD - BigQuery Views
-- Data source: tempest-production.friday_analytics.analytics_events
-- ============================================================================

-- ----------------------------------------------------------------------------
-- VIEW 1: User Cohorts (weekly)
-- Base view that assigns users to their signup week cohort
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.user_cohorts` AS
SELECT
  user_id,
  MIN(timestamp) AS signup_timestamp,
  DATE_TRUNC(MIN(timestamp), WEEK(MONDAY)) AS cohort_week
FROM `tempest-production.friday_analytics.analytics_events`
WHERE event_name = 'user.signed_up'
  AND environment = 'production'
GROUP BY user_id;

-- ----------------------------------------------------------------------------
-- VIEW 2: User Funnel Events
-- First occurrence of each funnel event per user
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.user_funnel_events` AS
WITH first_events AS (
  SELECT
    user_id,
    event_name,
    MIN(timestamp) AS first_event_timestamp
  FROM `tempest-production.friday_analytics.analytics_events`
  WHERE environment = 'production'
    AND event_name IN (
      'user.signed_up',
      'conversation.started',
      'workspace.created',
      'session.started',
      'session.completed'
    )
  GROUP BY user_id, event_name
)
SELECT
  c.user_id,
  c.cohort_week,
  c.signup_timestamp,
  -- Funnel timestamps
  MAX(CASE WHEN f.event_name = 'conversation.started' THEN f.first_event_timestamp END) AS first_conversation_at,
  MAX(CASE WHEN f.event_name = 'workspace.created' THEN f.first_event_timestamp END) AS first_workspace_at,
  MAX(CASE WHEN f.event_name = 'session.started' THEN f.first_event_timestamp END) AS first_session_started_at,
  MAX(CASE WHEN f.event_name = 'session.completed' THEN f.first_event_timestamp END) AS first_session_completed_at,
  -- Funnel flags
  MAX(CASE WHEN f.event_name = 'conversation.started' THEN 1 ELSE 0 END) AS has_conversation,
  MAX(CASE WHEN f.event_name = 'workspace.created' THEN 1 ELSE 0 END) AS has_workspace,
  MAX(CASE WHEN f.event_name = 'session.started' THEN 1 ELSE 0 END) AS has_session_started,
  MAX(CASE WHEN f.event_name = 'session.completed' THEN 1 ELSE 0 END) AS has_session_completed
FROM `tempest-production.friday_analytics.user_cohorts` c
LEFT JOIN first_events f ON c.user_id = f.user_id
GROUP BY c.user_id, c.cohort_week, c.signup_timestamp;

-- ----------------------------------------------------------------------------
-- VIEW 3: Activation Funnel by Cohort
-- Weekly cohort funnel metrics (for bar/funnel charts)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.activation_funnel_by_cohort` AS
SELECT
  cohort_week,
  -- Counts
  COUNT(DISTINCT user_id) AS total_signups,
  COUNTIF(has_conversation = 1) AS users_with_conversation,
  COUNTIF(has_workspace = 1) AS users_with_workspace,
  COUNTIF(has_session_started = 1) AS users_with_session_started,
  COUNTIF(has_session_completed = 1) AS users_with_session_completed,
  -- Percentages (conversion rates)
  ROUND(100.0 * COUNTIF(has_conversation = 1) / COUNT(DISTINCT user_id), 1) AS pct_conversation,
  ROUND(100.0 * COUNTIF(has_workspace = 1) / COUNT(DISTINCT user_id), 1) AS pct_workspace,
  ROUND(100.0 * COUNTIF(has_session_started = 1) / COUNT(DISTINCT user_id), 1) AS pct_session_started,
  ROUND(100.0 * COUNTIF(has_session_completed = 1) / COUNT(DISTINCT user_id), 1) AS pct_session_completed
FROM `tempest-production.friday_analytics.user_funnel_events`
GROUP BY cohort_week
ORDER BY cohort_week DESC;

-- ----------------------------------------------------------------------------
-- VIEW 4: Time to Activation by Cohort
-- Average time from signup to each milestone
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.time_to_activation_by_cohort` AS
SELECT
  cohort_week,
  COUNT(DISTINCT user_id) AS total_users,
  -- Average time to first event (in hours)
  ROUND(AVG(TIMESTAMP_DIFF(first_conversation_at, signup_timestamp, MINUTE)) / 60.0, 1) AS avg_hours_to_conversation,
  ROUND(AVG(TIMESTAMP_DIFF(first_workspace_at, signup_timestamp, MINUTE)) / 60.0, 1) AS avg_hours_to_workspace,
  ROUND(AVG(TIMESTAMP_DIFF(first_session_started_at, signup_timestamp, MINUTE)) / 60.0, 1) AS avg_hours_to_first_run,
  ROUND(AVG(TIMESTAMP_DIFF(first_session_completed_at, signup_timestamp, MINUTE)) / 60.0, 1) AS avg_hours_to_first_success,
  -- Median time (using APPROX_QUANTILES)
  ROUND(APPROX_QUANTILES(TIMESTAMP_DIFF(first_session_completed_at, signup_timestamp, MINUTE), 100)[OFFSET(50)] / 60.0, 1) AS median_hours_to_first_success
FROM `tempest-production.friday_analytics.user_funnel_events`
WHERE first_session_completed_at IS NOT NULL
GROUP BY cohort_week
ORDER BY cohort_week DESC;

-- ----------------------------------------------------------------------------
-- VIEW 5: Session Success Rate by Cohort
-- % of successful jobs from total jobs
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.session_success_by_cohort` AS
WITH session_outcomes AS (
  SELECT
    e.user_id,
    c.cohort_week,
    e.session_id,
    MAX(CASE WHEN e.event_name = 'session.started' THEN 1 ELSE 0 END) AS was_started,
    MAX(CASE WHEN e.event_name = 'session.completed' THEN 1 ELSE 0 END) AS was_completed,
    MAX(CASE WHEN e.event_name = 'session.failed' THEN 1 ELSE 0 END) AS was_failed
  FROM `tempest-production.friday_analytics.analytics_events` e
  JOIN `tempest-production.friday_analytics.user_cohorts` c ON e.user_id = c.user_id
  WHERE e.environment = 'production'
    AND e.event_name IN ('session.started', 'session.completed', 'session.failed')
    AND e.session_id IS NOT NULL
  GROUP BY e.user_id, c.cohort_week, e.session_id
)
SELECT
  cohort_week,
  COUNT(DISTINCT session_id) AS total_sessions,
  COUNTIF(was_completed = 1) AS successful_sessions,
  COUNTIF(was_failed = 1) AS failed_sessions,
  COUNTIF(was_started = 1 AND was_completed = 0 AND was_failed = 0) AS incomplete_sessions,
  ROUND(100.0 * COUNTIF(was_completed = 1) / NULLIF(COUNT(DISTINCT session_id), 0), 1) AS success_rate_pct,
  ROUND(100.0 * COUNTIF(was_failed = 1) / NULLIF(COUNT(DISTINCT session_id), 0), 1) AS failure_rate_pct
FROM session_outcomes
GROUP BY cohort_week
ORDER BY cohort_week DESC;

-- ----------------------------------------------------------------------------
-- VIEW 6: Usage Metrics by User
-- Per-user activity counts (for usage analysis)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.user_usage_metrics` AS
SELECT
  c.user_id,
  c.cohort_week,
  c.signup_timestamp,
  COUNTIF(e.event_name = 'conversation.started') AS conversation_count,
  COUNTIF(e.event_name = 'workspace.created') AS workspace_count,
  COUNTIF(e.event_name = 'session.started') AS session_started_count,
  COUNTIF(e.event_name = 'session.completed') AS session_completed_count,
  COUNTIF(e.event_name = 'session.failed') AS session_failed_count,
  COUNT(DISTINCT e.workspace_id) AS unique_workspaces,
  COUNT(DISTINCT DATE(e.timestamp)) AS active_days
FROM `tempest-production.friday_analytics.user_cohorts` c
LEFT JOIN `tempest-production.friday_analytics.analytics_events` e
  ON c.user_id = e.user_id AND e.environment = 'production'
GROUP BY c.user_id, c.cohort_week, c.signup_timestamp;

-- ----------------------------------------------------------------------------
-- VIEW 7: Usage Summary by Cohort
-- Aggregated usage metrics per cohort (for cohort comparison)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.usage_summary_by_cohort` AS
SELECT
  cohort_week,
  COUNT(DISTINCT user_id) AS total_users,
  -- Totals
  SUM(conversation_count) AS total_conversations,
  SUM(workspace_count) AS total_workspaces,
  SUM(session_started_count) AS total_sessions_started,
  SUM(session_completed_count) AS total_sessions_completed,
  -- Averages per user
  ROUND(AVG(conversation_count), 1) AS avg_conversations_per_user,
  ROUND(AVG(workspace_count), 1) AS avg_workspaces_per_user,
  ROUND(AVG(session_started_count), 1) AS avg_sessions_per_user,
  ROUND(AVG(active_days), 1) AS avg_active_days_per_user
FROM `tempest-production.friday_analytics.user_usage_metrics`
GROUP BY cohort_week
ORDER BY cohort_week DESC;

-- ----------------------------------------------------------------------------
-- VIEW 8: Overall Summary (Scorecard metrics)
-- High-level KPIs for dashboard scorecards
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.overall_summary` AS
SELECT
  -- User counts
  (SELECT COUNT(DISTINCT user_id) FROM `tempest-production.friday_analytics.user_cohorts`) AS total_signups,
  (SELECT COUNTIF(has_session_completed = 1) FROM `tempest-production.friday_analytics.user_funnel_events`) AS activated_users,
  -- Conversion rate
  ROUND(100.0 *
    (SELECT COUNTIF(has_session_completed = 1) FROM `tempest-production.friday_analytics.user_funnel_events`) /
    NULLIF((SELECT COUNT(DISTINCT user_id) FROM `tempest-production.friday_analytics.user_cohorts`), 0)
  , 1) AS overall_activation_rate_pct,
  -- Session metrics
  (SELECT COUNT(DISTINCT session_id) FROM `tempest-production.friday_analytics.analytics_events`
   WHERE event_name = 'session.started' AND environment = 'production') AS total_sessions,
  (SELECT COUNT(DISTINCT session_id) FROM `tempest-production.friday_analytics.analytics_events`
   WHERE event_name = 'session.completed' AND environment = 'production') AS successful_sessions,
  -- Time to activation (median)
  (SELECT ROUND(APPROX_QUANTILES(TIMESTAMP_DIFF(first_session_completed_at, signup_timestamp, MINUTE), 100)[OFFSET(50)] / 60.0, 1)
   FROM `tempest-production.friday_analytics.user_funnel_events`
   WHERE first_session_completed_at IS NOT NULL) AS median_hours_to_activation;

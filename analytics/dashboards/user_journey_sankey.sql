-- ============================================================================
-- USER JOURNEY SANKEY - BigQuery Views
-- Computes event transitions for Sankey diagram visualization
--
-- Data sources:
--   - tempest-production.friday_analytics.analytics_events (server-side, available now)
--   - tempest-production.analytics_518878521.events_* (GA4 export, accumulating)
--
-- Usage:
--   1. Run this file to create the views
--   2. Query `user_journey_transitions` for Sankey data (source, target, weight)
--   3. Query `user_journey_transitions_ga4` once GA4 data accumulates
--   4. Query `user_journey_transitions_combined` for the full picture
-- ============================================================================

-- ----------------------------------------------------------------------------
-- VIEW 1: Server-side event transitions
-- Uses OTEL backend events (available now)
-- Shows: login → conversation → workspace → session → completion flow
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.user_journey_transitions` AS
WITH with_prev AS (
  SELECT
    user_id,
    event_name,
    timestamp,
    LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) AS prev_ts
  FROM `tempest-production.friday_analytics.analytics_events`
  WHERE environment = 'production'
    AND user_id IS NOT NULL
    AND user_id != ''
    AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
),
-- Session windows: events within 30 min of each other = same session
with_session AS (
  SELECT
    user_id,
    event_name,
    timestamp,
    SUM(CASE
      WHEN TIMESTAMP_DIFF(timestamp, prev_ts, MINUTE) > 30 OR prev_ts IS NULL
      THEN 1 ELSE 0
    END) OVER (PARTITION BY user_id ORDER BY timestamp) AS session_window
  FROM with_prev
),
ordered_events AS (
  SELECT
    user_id,
    session_window,
    event_name,
    LEAD(event_name) OVER (PARTITION BY user_id, session_window ORDER BY timestamp) AS next_event
  FROM with_session
)
SELECT
  event_name AS source,
  next_event AS target,
  COUNT(*) AS weight,
  COUNT(DISTINCT user_id) AS unique_users
FROM ordered_events
WHERE next_event IS NOT NULL
GROUP BY source, target
ORDER BY weight DESC;


-- ----------------------------------------------------------------------------
-- VIEW 2: GA4 client-side event transitions
-- Uses GA4 BigQuery export (accumulating - will have data within 24-48h)
-- Shows: all UI clicks and navigation patterns
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.user_journey_transitions_ga4` AS
WITH ga4_events AS (
  SELECT
    COALESCE(user_id, user_pseudo_id) AS effective_user_id,
    event_name,
    TIMESTAMP_MICROS(event_timestamp) AS event_ts,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS ga_session_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'section') AS section,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'source') AS source_param
  FROM `tempest-production.analytics_518878521.events_*`
  WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
    -- Exclude noise events that don't represent meaningful user actions
    AND event_name NOT IN ('user_engagement', 'scroll', 'first_visit')
),
-- Enrich event names with context parameters for more meaningful nodes
enriched_events AS (
  SELECT
    effective_user_id,
    ga_session_id,
    event_ts,
    CASE
      -- Navigation clicks: include which section
      WHEN event_name = 'nav_click' AND section IS NOT NULL
        THEN CONCAT('nav_click:', section)
      -- New chat: include source
      WHEN event_name = 'new_chat_click' AND source_param IS NOT NULL
        THEN CONCAT('new_chat_click:', source_param)
      -- Page views: simplify to path segments
      WHEN event_name = 'page_view' AND page_location IS NOT NULL
        THEN CONCAT('page:', REGEXP_EXTRACT(page_location, r'https?://[^/]+(\/[^?#]*)'))
      ELSE event_name
    END AS event_label
  FROM ga4_events
  WHERE effective_user_id IS NOT NULL
),
ordered AS (
  SELECT
    effective_user_id,
    ga_session_id,
    event_label,
    event_ts,
    LEAD(event_label) OVER (
      PARTITION BY effective_user_id, ga_session_id
      ORDER BY event_ts
    ) AS next_event
  FROM enriched_events
)
SELECT
  event_label AS source,
  next_event AS target,
  COUNT(*) AS weight,
  COUNT(DISTINCT effective_user_id) AS unique_users
FROM ordered
WHERE next_event IS NOT NULL
  -- Filter out self-transitions (same event repeated)
  AND event_label != next_event
GROUP BY source, target
HAVING weight >= 2  -- Only show transitions that happen more than once
ORDER BY weight DESC;


-- ----------------------------------------------------------------------------
-- VIEW 3: Combined transitions (GA4 + server-side)
-- Joins both sources on user_id for the complete picture
-- GA4 provides UI interaction granularity, server-side provides backend milestones
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.user_journey_transitions_combined` AS
WITH
-- Server-side events
server_events AS (
  SELECT
    user_id AS effective_user_id,
    CONCAT('srv:', event_name) AS event_label,
    timestamp AS event_ts
  FROM `tempest-production.friday_analytics.analytics_events`
  WHERE environment = 'production'
    AND user_id IS NOT NULL
    AND user_id != ''
    AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
),
-- GA4 events (matched by user_id only, not pseudo_id, for accurate join)
ga4_events AS (
  SELECT
    user_id AS effective_user_id,
    CASE
      WHEN event_name = 'nav_click'
        THEN CONCAT('ui:', event_name, ':',
          COALESCE((SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'section'), ''))
      WHEN event_name = 'page_view'
        THEN CONCAT('ui:page:',
          COALESCE(REGEXP_EXTRACT(
            (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location'),
            r'https?://[^/]+(\/[^?#]*)'
          ), '/'))
      ELSE CONCAT('ui:', event_name)
    END AS event_label,
    TIMESTAMP_MICROS(event_timestamp) AS event_ts
  FROM `tempest-production.analytics_518878521.events_*`
  WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
    AND user_id IS NOT NULL
    AND event_name NOT IN ('user_engagement', 'scroll', 'first_visit')
),
-- Union both sources
all_events AS (
  SELECT * FROM server_events
  UNION ALL
  SELECT * FROM ga4_events
),
-- First compute previous timestamp (can't nest window functions in BigQuery)
with_prev AS (
  SELECT
    effective_user_id,
    event_label,
    event_ts,
    LAG(event_ts) OVER (PARTITION BY effective_user_id ORDER BY event_ts) AS prev_ts
  FROM all_events
),
-- Session windowing (30 min gap = new session)
sessioned AS (
  SELECT
    effective_user_id,
    event_label,
    event_ts,
    SUM(CASE
      WHEN TIMESTAMP_DIFF(event_ts, prev_ts, MINUTE) > 30 OR prev_ts IS NULL
      THEN 1 ELSE 0
    END) OVER (PARTITION BY effective_user_id ORDER BY event_ts) AS session_window
  FROM with_prev
),
ordered AS (
  SELECT
    effective_user_id,
    session_window,
    event_label,
    event_ts,
    LEAD(event_label) OVER (
      PARTITION BY effective_user_id, session_window
      ORDER BY event_ts
    ) AS next_event
  FROM sessioned
)
SELECT
  event_label AS source,
  next_event AS target,
  COUNT(*) AS weight,
  COUNT(DISTINCT effective_user_id) AS unique_users
FROM ordered
WHERE next_event IS NOT NULL
  AND event_label != next_event
GROUP BY source, target
HAVING weight >= 2
ORDER BY weight DESC;


-- ----------------------------------------------------------------------------
-- VIEW 4: Step-limited transitions (for cleaner Sankey at specific depths)
-- Shows first N steps per user session, useful for "what happens after login"
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `tempest-production.friday_analytics.user_journey_first_steps` AS
WITH with_prev AS (
  SELECT
    user_id,
    event_name,
    timestamp,
    LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) AS prev_ts
  FROM `tempest-production.friday_analytics.analytics_events`
  WHERE environment = 'production'
    AND user_id IS NOT NULL
    AND user_id != ''
    AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
),
with_session AS (
  SELECT
    user_id,
    event_name,
    timestamp,
    SUM(CASE
      WHEN TIMESTAMP_DIFF(timestamp, prev_ts, MINUTE) > 30 OR prev_ts IS NULL
      THEN 1 ELSE 0
    END) OVER (PARTITION BY user_id ORDER BY timestamp) AS session_window
  FROM with_prev
),
with_step AS (
  SELECT
    user_id,
    session_window,
    event_name,
    ROW_NUMBER() OVER (PARTITION BY user_id, session_window ORDER BY timestamp) AS step_num
  FROM with_session
)
SELECT
  step_num AS step,
  event_name AS source,
  LEAD(event_name) OVER (PARTITION BY user_id, session_window ORDER BY step_num) AS target,
  user_id,
  session_window
FROM with_step
WHERE step_num <= 10;  -- First 10 steps per session

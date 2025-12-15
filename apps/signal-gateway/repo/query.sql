-- Signal Gateway routing queries for Slack
-- Read-only access for event routing

-- Get user ID by Slack team ID
-- name: GetUserIDByTeam :one
SELECT user_id FROM public.platform_route
WHERE team_id = $1;

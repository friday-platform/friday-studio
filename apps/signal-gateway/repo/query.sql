-- Signal Gateway routing queries for Slack
-- Read-only access for event routing

-- name: GetWebhookSecret :one
SELECT signing_secret, user_id FROM public.slack_app_webhook
WHERE app_id = $1;

-- Remove system workspace sessions from the activity feed.
-- The original backfill (20260318) excluded atlas-conversation and
-- friday-conversation but not the system (FAST kernel) workspace.
DELETE FROM public.activities
WHERE workspace_id = 'system';

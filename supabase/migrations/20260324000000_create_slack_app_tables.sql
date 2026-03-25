-- Per-workspace Slack app tables
-- Part of the per-workspace Slack apps feature: each Friday workspace gets its
-- own Slack app. These tables support webhook verification and credential-to-
-- workspace mapping.

-- ============================================================================
-- slack_app_webhook: signing secrets for webhook verification
-- Link writes on app creation, signal-gateway reads for signing secret lookup
-- ============================================================================

CREATE TABLE public.slack_app_webhook (
    app_id         TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    signing_secret TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.slack_app_webhook ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_app_webhook FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.slack_app_webhook IS 'Signing secrets for per-workspace Slack app webhook verification';
COMMENT ON COLUMN public.slack_app_webhook.app_id IS 'Slack app ID (from apps.manifest.create)';
COMMENT ON COLUMN public.slack_app_webhook.user_id IS 'Atlas user ID who owns this Slack app';

-- ============================================================================
-- slack_app_workspace: maps slack-app credentials to Atlas workspace IDs
-- Link reads/writes via service role
-- ============================================================================

CREATE TABLE public.slack_app_workspace (
    credential_id TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup by workspace ID (e.g. "which credential serves this workspace?")
CREATE INDEX idx_slack_app_workspace_workspace_id
    ON public.slack_app_workspace(workspace_id);

ALTER TABLE public.slack_app_workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_app_workspace FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.slack_app_workspace IS 'Maps slack-app credentials to Atlas workspace IDs';
COMMENT ON COLUMN public.slack_app_workspace.credential_id IS 'Logical FK to credential.id (no constraint — credential uses soft delete)';
COMMENT ON COLUMN public.slack_app_workspace.workspace_id IS 'Atlas workspace ID this slack app is wired to';

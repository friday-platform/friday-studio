CREATE SCHEMA IF NOT EXISTS gateway;

CREATE TABLE gateway.email_suppressions (
    email        TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (email, workspace_id)
);

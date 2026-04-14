"""workspace-creator: deterministic HTTP agent to create ephemeral FAST workspaces.

Creates a new workspace via the daemon's POST /api/workspaces/create endpoint.
Pure HTTP, no LLM calls. Building block for cross-workspace orchestration where
a parent workspace spins up scoped child workspaces, fans out work, and tears
them down when done.

Input shape (passed via task config):
  workspace_id: str    — REQUIRED. Proposed slug / workspaceName for the new workspace.
  config: dict         — REQUIRED. Parsed workspace configuration object (NOT raw YAML).
                         The daemon's endpoint expects a JSON object; it serializes to
                         YAML itself. Callers with raw YAML must parse it first.
  name: str            — optional. Human-readable name; embedded in config['workspace']['name']
                         if not already present.
  ephemeral: bool      — optional, default True. Passed through to daemon.
  platformUrl: str     — optional. Daemon base URL override (default http://localhost:8080).

Behavior:
  1. Validate workspace_id and config inputs.
  2. POST /api/workspaces/create with JSON body {config, workspaceName, ephemeral}.
  3. On HTTP 201: return ok() with workspace_id, workspace_path, created.
  4. On non-2xx: return err() with status + body excerpt.
  5. On HttpError: return err() with exception message.
"""

from __future__ import annotations

import json
from typing import Any

from friday_agent_sdk import AgentContext, HttpError, agent, err, ok

# Re-export the WIT bridge Agent class so componentize-py finds it.
# The build pipeline expects the user `agent` module to export Agent at
# module level; the @agent decorator below registers the handler, and
# the bridge's Agent class delegates to it via the registry.
from friday_agent_sdk._bridge import Agent  # noqa: F401


PLATFORM_URL_DEFAULT = "http://localhost:8080"


def _platform_url(ctx: AgentContext) -> str:
    return ctx.config.get("platformUrl", PLATFORM_URL_DEFAULT) if ctx.config else PLATFORM_URL_DEFAULT


def _http_post_json(
    ctx: AgentContext,
    path: str,
    payload: dict,
    *,
    timeout_ms: int = 15000,
) -> Any:
    """POST JSON payload to the daemon. Returns the raw HttpResponse."""
    url = f"{_platform_url(ctx)}{path}"
    body = json.dumps(payload)
    return ctx.http.fetch(
        url,
        method="POST",
        headers={"Content-Type": "application/json"},
        body=body,
        timeout_ms=timeout_ms,
    )


@agent(
    id="workspace-creator",
    version="1.0.0",
    description="Creates an ephemeral FAST workspace via the daemon HTTP API. Pure HTTP, no LLM calls.",
    summary="Spins up a scoped child workspace via POST /api/workspaces/create.",
    examples=[
        "Create a new ephemeral workspace for task abc-123",
        "Spin up workspace my-workspace-slug with config {...}",
    ],
)
def execute(prompt: str, ctx: AgentContext) -> Any:
    config = ctx.config or {}

    ctx.stream.progress("validating inputs")

    # Validate workspace_id
    workspace_id = config.get("workspace_id")
    if not workspace_id or not isinstance(workspace_id, str):
        return err("missing required config: workspace_id")

    # Validate / coerce config dict
    workspace_config = config.get("config")
    if workspace_config is None:
        return err("missing required config: config (workspace configuration dict)")
    if isinstance(workspace_config, str):
        # Convenience: attempt JSON parse if caller passed a JSON string
        try:
            workspace_config = json.loads(workspace_config)
        except json.JSONDecodeError as exc:
            return err(f"config is a string but not valid JSON: {exc}")
    if not isinstance(workspace_config, dict):
        return err("missing required config: config (workspace configuration dict)")

    # Optional fields
    name: str | None = config.get("name")
    ephemeral: bool = bool(config.get("ephemeral", True))

    # If a human-readable name was provided and the workspace config doesn't
    # already have one, inject it so the daemon names the workspace correctly.
    if name and isinstance(workspace_config.get("workspace"), dict):
        workspace_config["workspace"].setdefault("name", name)

    ctx.stream.progress("creating workspace via daemon API")

    request_body: dict = {
        "config": workspace_config,
        "workspaceName": workspace_id,
        "ephemeral": ephemeral,
    }

    try:
        resp = _http_post_json(ctx, "/api/workspaces/create", request_body)
    except HttpError as exc:
        return err(f"HTTP request failed: {exc}")

    body_text: str = resp.body or ""

    if resp.status == 201:
        try:
            data = json.loads(body_text)
        except json.JSONDecodeError:
            return err(f"workspace creation returned 201 but body is not JSON: {body_text[:500]}")

        workspace_obj = data.get("workspace", {})
        created_workspace_id = workspace_obj.get("id", workspace_id)

        ctx.stream.progress(f"workspace created: {created_workspace_id}")

        return ok({
            "workspace_id": created_workspace_id,
            "status_code": 201,
            "server_message": "workspace created",
            "workspace_path": data.get("workspacePath"),
            "created": data.get("created"),
        })

    # Non-2xx response
    return err(f"workspace creation failed: HTTP {resp.status} \u2014 {body_text[:500]}")

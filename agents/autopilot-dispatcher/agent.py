"""autopilot-dispatcher — WASM agent that dispatches autopilot plan actions.

Posts to the daemon's /api/workspaces/{id}/signals/{id} endpoint. Pure HTTP,
no LLM. Reads action/target from ctx.config, validates inputs, fires the
signal POST with configurable timeout (default 10 min), and returns
session_id + completion status for the autopilot FSM.
"""

from __future__ import annotations

import json
import time
from typing import Any

from friday_agent_sdk import AgentContext, HttpError, agent, err, ok

# Re-export the WIT bridge Agent class so componentize-py finds it.
# The build pipeline expects the user `agent` module to export Agent at
# module level; the @agent decorator below registers the handler, and
# the bridge's Agent class delegates to it via the registry.
from friday_agent_sdk._bridge import Agent  # noqa: F401

PLATFORM_URL_DEFAULT = "http://localhost:8080"
DEFAULT_TIMEOUT_MS = 600_000  # 10 minutes — target FSMs can be multi-step


def _platform_url(ctx: AgentContext) -> str:
    return ctx.config.get("platformUrl", PLATFORM_URL_DEFAULT) if ctx.config else PLATFORM_URL_DEFAULT


def _http_post_json(
    ctx: AgentContext,
    path: str,
    payload: dict,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
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
    id="autopilot-dispatcher",
    version="1.0.0",
    description="Dispatches autopilot plan actions by POSTing to the daemon's workspace signal endpoint. Pure HTTP, no LLM calls.",
    summary="Fires POST /api/workspaces/:workspaceId/signals/:signalId and returns session_id + status for the autopilot FSM.",
    examples=[
        "Dispatch action run-tick to workspace mild_almond via signal autopilot-tick",
        "Trigger signal parity-plan-exec on workspace artisan_almond with payload {task: 'implement-task-4'}",
    ],
)
def execute(prompt: str, ctx: AgentContext) -> Any:
    cfg = ctx.config or {}

    # Short-circuit on planner idle: no action required.
    action: str = cfg.get("action", "execute")
    if action != "execute":
        return ok({
            "dispatched": False,
            "action": action,
            "rationale": f"planner action '{action}' is not 'execute'; no-op",
        })

    # Validate required config fields
    target_workspace_id: str = cfg.get("target_workspace_id") or ""
    target_signal_id: str = cfg.get("target_signal_id") or ""

    if not target_workspace_id:
        return err("config.target_workspace_id is required when action=='execute'")
    if not target_signal_id:
        return err("config.target_signal_id is required when action=='execute'")

    # Optional fields
    signal_payload: dict = cfg.get("signal_payload") or {}
    timeout_ms: int = int(cfg.get("timeout_ms", DEFAULT_TIMEOUT_MS))

    ctx.stream.progress(
        f"dispatching signal '{target_signal_id}' to workspace '{target_workspace_id}'"
    )

    # POST body matches signalBodySchema (index.ts:67-71):
    # { payload?: Record<string, unknown>, streamId?: string, skipStates?: string[] }
    request_body = {"payload": signal_payload}

    path = f"/api/workspaces/{target_workspace_id}/signals/{target_signal_id}"

    t_start = time.time()
    try:
        resp = _http_post_json(ctx, path, request_body, timeout_ms=timeout_ms)
    except HttpError as exc:
        return err(f"HTTP request failed: {exc}")
    duration_ms_observed = int((time.time() - t_start) * 1000)

    body_text: str = resp.body or ""

    # Success: 200 response from signal endpoint
    # { message, status, workspaceId, signalId, sessionId } per index.ts:1700-1706
    if resp.status == 200:
        try:
            data = json.loads(body_text)
        except json.JSONDecodeError:
            return err(
                f"signal dispatch returned 200 but body is not JSON: {body_text[:500]}"
            )

        session_id = data.get("sessionId")
        ctx.stream.progress(
            f"signal completed: sessionId={session_id}, duration={duration_ms_observed}ms"
        )

        return ok({
            "dispatched": True,
            "session_id": session_id,
            "target_workspace_id": target_workspace_id,
            "target_signal_id": target_signal_id,
            "duration_ms_observed": duration_ms_observed,
            "response_status": resp.status,
            "response_message": data.get("message"),
        })

    # Specific error codes from the signal endpoint
    if resp.status == 404:
        return err(
            f"workspace or signal not found: {target_workspace_id}/{target_signal_id} — {body_text[:500]}"
        )
    if resp.status == 409:
        return err(
            f"workspace {target_workspace_id} already has an active session (concurrent session conflict) — {body_text[:500]}"
        )
    if resp.status == 422:
        return err(
            f"signal dispatch failed (session error / missing config): HTTP 422 — {body_text[:500]}"
        )

    # Generic non-2xx
    return err(
        f"signal dispatch failed: HTTP {resp.status} — {body_text[:500]}"
    )

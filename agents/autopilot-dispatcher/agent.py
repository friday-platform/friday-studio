"""autopilot-dispatcher v2 — fire-and-poll pattern.

Posts to the daemon's /api/workspaces/{id}/signals/{id} endpoint with a short
timeout (default 5s). If the FSM completes within that window, returns
immediately. If the POST times out (HttpError), the daemon keeps running the
FSM — we discover the active session via GET /api/sessions?workspaceId=X, then
poll GET /api/sessions/{id} every N seconds until a terminal status.

Solves the v1 gap where the 180s SDK fetch limit caused timeout before long
FSMs (5-10 min architect+coder+reviewer) completed.
"""

from __future__ import annotations

import json
import time
from typing import Any

from friday_agent_sdk import AgentContext, HttpError, agent, err, ok

# Re-export the WIT bridge Agent class so componentize-py finds it.
from friday_agent_sdk._bridge import Agent  # noqa: F401

PLATFORM_URL_DEFAULT = "http://localhost:8080"
DEFAULT_FIRE_TIMEOUT_MS = 5_000       # 5s — just long enough for trivial FSMs
DEFAULT_POLL_INTERVAL_S = 5           # seconds between poll requests
DEFAULT_MAX_POLL_DURATION_S = 900     # 15 minutes max polling
DEFAULT_SESSION_QUERY_TIMEOUT_MS = 10_000  # 10s for GET requests

TERMINAL_STATUSES = {"completed", "failed", "timeout", "cancelled", "skipped"}


def _platform_url(ctx: AgentContext) -> str:
    return ctx.config.get("platformUrl", PLATFORM_URL_DEFAULT) if ctx.config else PLATFORM_URL_DEFAULT


def _http_post_json(
    ctx: AgentContext,
    path: str,
    payload: dict,
    *,
    timeout_ms: int = DEFAULT_FIRE_TIMEOUT_MS,
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


def _http_get_json(ctx: AgentContext, path: str) -> Any:
    """GET JSON from the daemon. Returns parsed dict or raises."""
    url = f"{_platform_url(ctx)}{path}"
    resp = ctx.http.fetch(
        url,
        method="GET",
        headers={"Accept": "application/json"},
        timeout_ms=DEFAULT_SESSION_QUERY_TIMEOUT_MS,
    )
    if resp.status != 200:
        raise HttpError(f"GET {path} returned HTTP {resp.status}: {(resp.body or '')[:500]}")
    return json.loads(resp.body or "{}")


def _find_active_session(ctx: AgentContext, workspace_id: str) -> str | None:
    """Query sessions list and return the first active session ID, or None."""
    data = _http_get_json(ctx, f"/api/sessions?workspaceId={workspace_id}")
    sessions = data.get("sessions", [])
    for session in sessions:
        if session.get("status") == "active":
            return session.get("sessionId") or session.get("id")
    return None


def _poll_session(
    ctx: AgentContext,
    session_id: str,
    max_duration_s: int,
    poll_interval_s: int,
) -> dict:
    """Poll a session until terminal status or deadline. Returns final session data."""
    deadline = time.time() + max_duration_s
    iteration = 0

    while True:
        iteration += 1
        try:
            data = _http_get_json(ctx, f"/api/sessions/{session_id}")
        except (HttpError, json.JSONDecodeError) as exc:
            ctx.stream.progress(f"poll #{iteration}: error querying session — {exc}")
            # Transient error — keep polling until deadline
            if time.time() >= deadline:
                return {"status": "timeout", "error": f"poll deadline exceeded after transient errors: {exc}"}
            time.sleep(poll_interval_s)
            continue

        status = data.get("status", "unknown")
        ctx.stream.progress(f"poll #{iteration}: session {session_id} status={status}")

        if status in TERMINAL_STATUSES:
            return data

        if time.time() >= deadline:
            return {"status": "timeout", "error": f"poll deadline exceeded after {iteration} iterations"}

        time.sleep(poll_interval_s)


@agent(
    id="autopilot-dispatcher",
    version="2.0.0",
    description="Dispatches autopilot plan actions via fire-and-poll. POSTs signal with short timeout, then polls session status until completion.",
    summary="Fire-and-poll dispatcher: POST signal → discover session → poll until terminal status.",
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

    # Config fields (v1 compat + v2 extensions)
    signal_payload: dict = cfg.get("signal_payload") or {}
    fire_timeout_ms: int = int(cfg.get("fire_timeout_ms", DEFAULT_FIRE_TIMEOUT_MS))
    poll_interval_s: int = int(cfg.get("poll_interval_s", DEFAULT_POLL_INTERVAL_S))
    max_poll_duration_s: int = int(cfg.get("max_poll_duration_s", DEFAULT_MAX_POLL_DURATION_S))

    ctx.stream.progress(
        f"dispatching signal '{target_signal_id}' to workspace '{target_workspace_id}'"
    )

    # ── Phase 1: Fire ──────────────────────────────────────────────
    # POST with short timeout. If the FSM completes fast, we get the
    # response directly. If it times out, the daemon keeps running.
    request_body = {"payload": signal_payload}
    path = f"/api/workspaces/{target_workspace_id}/signals/{target_signal_id}"

    t_start = time.time()
    fire_timed_out = False

    try:
        resp = _http_post_json(ctx, path, request_body, timeout_ms=fire_timeout_ms)
    except HttpError as exc:
        exc_str = str(exc)
        # Timeout — expected for long FSMs. Proceed to discover+poll.
        # Non-timeout HTTP errors (connection refused, etc.) are real failures.
        # We can't perfectly distinguish timeout vs other errors from HttpError,
        # so we treat all HttpErrors as potential timeouts and try to discover.
        fire_timed_out = True
        ctx.stream.progress(f"fire phase: POST timed out or failed ({exc_str[:200]}), switching to poll mode")

    if not fire_timed_out:
        # POST returned a response — check it
        duration_ms = int((time.time() - t_start) * 1000)
        body_text: str = resp.body or ""

        if resp.status == 200:
            try:
                data = json.loads(body_text)
            except json.JSONDecodeError:
                return err(f"signal dispatch returned 200 but body is not JSON: {body_text[:500]}")

            session_id = data.get("sessionId")
            ctx.stream.progress(f"signal completed synchronously: sessionId={session_id}, duration={duration_ms}ms")

            return ok({
                "dispatched": True,
                "session_id": session_id,
                "target_workspace_id": target_workspace_id,
                "target_signal_id": target_signal_id,
                "duration_ms": duration_ms,
                "status": "completed",
                "poll_required": False,
            })

        if resp.status == 404:
            return err(f"workspace or signal not found: {target_workspace_id}/{target_signal_id} — {body_text[:500]}")
        if resp.status == 409:
            return err(f"workspace {target_workspace_id} already has an active session (concurrent conflict) — {body_text[:500]}")
        if resp.status == 422:
            return err(f"signal dispatch failed (session error / missing config): HTTP 422 — {body_text[:500]}")

        return err(f"signal dispatch failed: HTTP {resp.status} — {body_text[:500]}")

    # ── Phase 2: Discover ──────────────────────────────────────────
    # Find the active session spawned by our POST.
    ctx.stream.progress(f"discover phase: querying sessions for workspace '{target_workspace_id}'")

    session_id = None
    try:
        session_id = _find_active_session(ctx, target_workspace_id)
    except (HttpError, json.JSONDecodeError):
        pass

    # Retry once after 2s — race between session creation and our query
    if not session_id:
        time.sleep(2)
        try:
            session_id = _find_active_session(ctx, target_workspace_id)
        except (HttpError, json.JSONDecodeError):
            pass

    if not session_id:
        # Check if maybe it already completed (fast FSM that finished
        # between our POST timeout and discovery query)
        try:
            data = _http_get_json(ctx, f"/api/sessions?workspaceId={target_workspace_id}")
            sessions = data.get("sessions", [])
            if sessions:
                latest = sessions[0]  # sorted by startedAt descending
                latest_status = latest.get("status", "unknown")
                latest_id = latest.get("sessionId") or latest.get("id")
                if latest_status in TERMINAL_STATUSES:
                    duration_ms = int((time.time() - t_start) * 1000)
                    return ok({
                        "dispatched": True,
                        "session_id": latest_id,
                        "target_workspace_id": target_workspace_id,
                        "target_signal_id": target_signal_id,
                        "duration_ms": duration_ms,
                        "status": latest_status,
                        "poll_required": False,
                    })
        except (HttpError, json.JSONDecodeError):
            pass

        return err(
            f"could not discover active session for workspace '{target_workspace_id}' "
            f"after POST to signal '{target_signal_id}' timed out"
        )

    ctx.stream.progress(f"discovered session: {session_id}")

    # ── Phase 3: Poll ──────────────────────────────────────────────
    ctx.stream.progress(f"poll phase: polling session {session_id} every {poll_interval_s}s (max {max_poll_duration_s}s)")

    final_data = _poll_session(ctx, session_id, max_poll_duration_s, poll_interval_s)
    duration_ms = int((time.time() - t_start) * 1000)
    final_status = final_data.get("status", "unknown")

    ctx.stream.progress(f"session {session_id} reached terminal status: {final_status} ({duration_ms}ms total)")

    return ok({
        "dispatched": True,
        "session_id": session_id,
        "target_workspace_id": target_workspace_id,
        "target_signal_id": target_signal_id,
        "duration_ms": duration_ms,
        "status": final_status,
        "poll_required": True,
    })

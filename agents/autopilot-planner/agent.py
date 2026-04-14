"""Autopilot planner — deterministic backlog scheduler for the FAST autopilot loop.

componentize-py compiles this module. It must:
1. Register the handler via @agent decorator (side-effect import)
2. Export the Agent class that componentize-py expects
"""

from __future__ import annotations

from typing import Any

from friday_agent_sdk import agent, err, ok
from friday_agent_sdk._bridge import Agent  # noqa: F401 — componentize-py needs this

# Despite the .yaml extension, the file MUST be valid JSON — no YAML parser
# is available in the WASM stdlib sandbox. Extension preserved for operator
# backwards-compat with renamed .json files.
BACKLOG_URL_DEFAULT = (
    "http://localhost:8080/api/files/raw?path=/workspace/atlas/docs/plans/autopilot-backlog.yaml"
)
PLATFORM_URL_DEFAULT = "http://localhost:8080"


def _http_get_json(ctx: Any, url: str) -> dict[str, Any]:
    """Fetch an arbitrary URL and return parsed JSON. Raises on non-200."""
    resp = ctx.http.fetch(url, method="GET", timeout_ms=15000)
    if resp.status != 200:
        raise RuntimeError(f"GET {url} → HTTP {resp.status}")
    return resp.json()


def _filter_eligible(tasks: list[dict[str, Any]], completed_ids: set[str]) -> list[dict[str, Any]]:
    """Return pending, unblocked tasks sorted by priority desc then created_at asc."""
    eligible = [
        t for t in tasks
        if t.get("status") == "pending"
        and all(dep in completed_ids for dep in t.get("blocked_by", []))
    ]
    eligible.sort(key=lambda t: (-t.get("priority", 0), t.get("created_at", "")))
    return eligible


@agent(
    id="autopilot-planner",
    version="1.0.0",
    description=(
        "Deterministic backlog planner for the FAST autopilot loop. "
        "Fetches a JSON backlog, filters and sorts pending tasks by priority "
        "and dependency resolution, and returns the next task to execute. "
        "No LLM call — this is a router, not a reasoner. Consumed by the "
        "autopilot workspace's autopilot-tick FSM as its first step."
    ),
    summary="Selects the next pending backlog task to execute; returns idle when none are eligible.",
    examples=[
        "Plan the next autopilot task",
        "What should the autopilot do next?",
    ],
)
def execute(prompt, ctx):
    cfg = ctx.config or {}

    inline_json = cfg.get("backlog_json")
    if isinstance(inline_json, str) and inline_json:
        import json as _json
        try:
            data = _json.loads(inline_json)
        except _json.JSONDecodeError as exc:
            return err(f"backlog_json is not valid JSON: {exc}")
    elif isinstance(inline_json, dict):
        data = inline_json
    else:
        backlog_url = cfg.get("backlog_url", BACKLOG_URL_DEFAULT)
        try:
            data = _http_get_json(ctx, backlog_url)
        except RuntimeError as exc:
            return err(f"Failed to fetch backlog: {exc}")

    if not isinstance(data, dict):
        return err("Backlog JSON root must be an object")

    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        return err("Backlog JSON must have a 'tasks' array at root")

    # Build completed set from the backlog itself plus any caller-supplied ids.
    completed_ids: set[str] = {
        t["id"] for t in tasks
        if isinstance(t, dict) and t.get("status") == "completed" and "id" in t
    }
    recent = cfg.get("recent_completions", [])
    if isinstance(recent, list):
        completed_ids |= set(recent)

    eligible = _filter_eligible(
        [t for t in tasks if isinstance(t, dict)],
        completed_ids,
    )

    if not eligible:
        return ok({
            "action": "idle",
            "task_id": None,
            "target_workspace_id": None,
            "target_signal_id": None,
            "signal_payload": None,
            "task_kind": None,
            "rationale": "no eligible tasks",
        })

    task = eligible[0]
    payload = task.get("payload") or {}

    target_workspace_id = payload.get("workspace_id")
    target_signal_id = payload.get("signal_id")

    if not target_workspace_id:
        return err(f"Task '{task.get('id')}' payload missing 'workspace_id'")
    if not target_signal_id:
        return err(f"Task '{task.get('id')}' payload missing 'signal_id'")

    return ok({
        "action": "execute",
        "task_id": task.get("id"),
        "target_workspace_id": target_workspace_id,
        "target_signal_id": target_signal_id,
        "signal_payload": payload,
        "task_kind": task.get("kind"),
        "rationale": (
            f"Selecting task '{task.get('id')}' (priority={task.get('priority', 0)}, "
            f"kind={task.get('kind')}, title={task.get('title', '')!r})."
        ),
    })

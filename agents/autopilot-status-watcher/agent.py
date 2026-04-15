"""Autopilot status watcher — closes the loop on dispatched tasks.

Reads the kernel's dispatch-log narrative corpus, fetches each dispatched
session's status, and appends a {status: completed | blocked} entry to the
autopilot-backlog narrative corpus when the target session has finished.

Runs as the first FSM step (step_observe) of the autopilot-tick job, BEFORE
the planner picks the next task. The planner's eligibility filter then sees
the newly-completed task ids and skips them on subsequent ticks.

Closes the loop without modifying the planner.
"""

from __future__ import annotations

import json
from typing import Any

from friday_agent_sdk import agent, ok
from friday_agent_sdk._bridge import Agent  # noqa: F401 — componentize-py needs this

PLATFORM_URL_DEFAULT = "http://localhost:8080"
KERNEL_WS_DEFAULT = "thick_endive"
DISPATCH_LOG_DEFAULT = "dispatch-log"
BACKLOG_DEFAULT = "autopilot-backlog"


def _http_get_json(ctx: Any, url: str) -> Any | None:
    """Fetch a URL and return parsed JSON, or None on error."""
    try:
        resp = ctx.http.fetch(url, method="GET", timeout_ms=5000)
        if resp.status != 200:
            return None
        return json.loads(resp.body or "null")
    except Exception:  # noqa: BLE001
        return None


def _post_json(ctx: Any, url: str, body: dict[str, Any]) -> int | str:
    """POST a JSON body, return status or error string. Best-effort."""
    try:
        resp = ctx.http.fetch(
            url,
            method="POST",
            headers={"Content-Type": "application/json"},
            body=json.dumps(body),
            timeout_ms=5000,
        )
        return resp.status
    except Exception as exc:  # noqa: BLE001
        return f"err: {str(exc)[:120]}"


def _extract_changed_files(session_data: dict[str, Any]) -> list[str]:
    """Extract file paths from session agentBlocks tool calls."""
    files: set[str] = set()
    for block in session_data.get("agentBlocks", []):
        if not isinstance(block, dict):
            continue
        for tc in block.get("toolCalls", []):
            if not isinstance(tc, dict):
                continue
            tool_name = tc.get("toolName", "")
            args = tc.get("args") or {}
            if not isinstance(args, dict):
                continue
            if tool_name in ("write_file", "Write", "fs_write"):
                fpath = args.get("file_path") or args.get("path") or ""
                if fpath:
                    files.add(fpath)
            elif tool_name in ("str_replace_editor", "Edit", "fs_edit"):
                fpath = args.get("path") or args.get("file_path") or ""
                if fpath:
                    files.add(fpath)
    return sorted(files)


def _fire_post_session_validator(
    ctx: Any,
    platform_url: str,
    kernel_ws: str,
    payload: dict[str, Any],
) -> dict[str, Any] | None:
    """Fire the post-session-validator signal and return the result, or None on error."""
    url = f"{platform_url}/api/workspaces/{kernel_ws}/signals/post-session-validate"
    try:
        resp = ctx.http.fetch(
            url,
            method="POST",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"payload": payload}),
            timeout_ms=480000,
        )
        if resp.status == 200:
            body = json.loads(resp.body or "null")
            return body if isinstance(body, dict) else None
        return None
    except Exception:  # noqa: BLE001
        return None


def _latest_per_id(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Return {id: latest-entry-by-createdAt} from a list of NarrativeEntry dicts."""
    latest: dict[str, dict[str, Any]] = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        eid = e.get("id")
        if not isinstance(eid, str):
            continue
        prev = latest.get(eid)
        if prev is None or (e.get("createdAt", "") > prev.get("createdAt", "")):
            latest[eid] = e
    return latest


@agent(
    id="autopilot-status-watcher",
    version="1.2.0",
    description=(
        "Closes the loop on autopilot dispatches. Reads the dispatch-log "
        "narrative memory, fetches each dispatched session's status, and "
        "appends completion entries to the autopilot-backlog memory so the "
        "planner stops re-picking finished tasks. No LLM call — pure "
        "observation. Runs as step_observe before step_plan in the kernel's "
        "autopilot-tick FSM."
    ),
    summary="Marks dispatched tasks completed in the backlog when their target sessions finish.",
    examples=[
        "Observe completed dispatches",
        "Mark finished autopilot tasks done",
    ],
)
def execute(prompt, ctx):
    cfg = ctx.config or {}
    platform_url = cfg.get("platformUrl", PLATFORM_URL_DEFAULT)
    kernel_ws = cfg.get("kernel_workspace_id", KERNEL_WS_DEFAULT)
    dispatch_log = cfg.get("dispatch_log_memory", DISPATCH_LOG_DEFAULT)
    backlog = cfg.get("backlog_memory", BACKLOG_DEFAULT)

    dispatch_log_url = f"{platform_url}/api/memory/{kernel_ws}/narrative/{dispatch_log}"
    backlog_url = f"{platform_url}/api/memory/{kernel_ws}/narrative/{backlog}"

    # 1. Read dispatch-log — find every task we've fired.
    dispatch_entries = _http_get_json(ctx, dispatch_log_url) or []
    if not isinstance(dispatch_entries, list):
        dispatch_entries = []

    # 2. Read autopilot-backlog — find which ones are already marked completed.
    backlog_entries = _http_get_json(ctx, backlog_url) or []
    if not isinstance(backlog_entries, list):
        backlog_entries = []
    backlog_latest = _latest_per_id(backlog_entries)
    already_completed: set[str] = {
        eid for eid, e in backlog_latest.items()
        if isinstance(e.get("metadata"), dict)
        and (e["metadata"].get("status") == "completed" or e["metadata"].get("validated") is True)
    }

    # 3. For each unique dispatched task that isn't already completed,
    #    find the latest dispatch entry and check its session.
    dispatch_latest = _latest_per_id(dispatch_entries)
    observations: list[dict[str, Any]] = []
    closed: list[str] = []
    skipped: list[str] = []

    # Cache of target_workspace_id -> recent sessions list, fetched once per tick.
    target_sessions_cache: dict[str, list[dict[str, Any]]] = {}

    def fetch_target_sessions(target_ws: str) -> list[dict[str, Any]]:
        cached = target_sessions_cache.get(target_ws)
        if cached is not None:
            return cached
        url = f"{platform_url}/api/sessions?workspaceId={target_ws}&limit=30"
        data = _http_get_json(ctx, url)
        sessions: list[dict[str, Any]] = []
        if isinstance(data, dict):
            sessions = data.get("sessions") or []
        elif isinstance(data, list):
            sessions = data
        target_sessions_cache[target_ws] = sessions if isinstance(sessions, list) else []
        return target_sessions_cache[target_ws]

    def find_matching_session(target_ws: str, dispatched_at: str) -> dict[str, Any] | None:
        """Find a target session whose startedAt is within ±5s of dispatched_at."""
        if not dispatched_at:
            return None
        sessions = fetch_target_sessions(target_ws)
        # ISO-string proximity: same minute is good enough for 2-min cron cadence
        prefix = dispatched_at[:16]  # YYYY-MM-DDTHH:MM
        for s in sessions:
            started = s.get("startedAt") or ""
            if started[:16] == prefix:
                return s
        return None

    for task_id, entry in dispatch_latest.items():
        if task_id in already_completed:
            skipped.append(f"{task_id}(already completed)")
            continue

        meta = entry.get("metadata") or {}
        session_id = meta.get("session_id")
        target_ws = meta.get("target_workspace_id")
        if not target_ws:
            skipped.append(f"{task_id}(no target_workspace_id)")
            continue

        session_data: dict[str, Any] | None = None

        # Path A: dispatch-log captured a session_id — fetch directly.
        if session_id:
            data = _http_get_json(ctx, f"{platform_url}/api/sessions/{session_id}")
            if isinstance(data, dict):
                session_data = data

        # Path B: dispatch-log session_id was null (planner HTTP aborted before
        # daemon returned). Fall back to matching by dispatched_at timestamp
        # against the target workspace's recent sessions list.
        if session_data is None:
            dispatched_at = meta.get("dispatched_at") or entry.get("createdAt", "")
            matched = find_matching_session(target_ws, dispatched_at)
            if matched is not None:
                session_data = matched
                session_id = matched.get("sessionId") or "(matched-by-time)"

        if session_data is None:
            skipped.append(f"{task_id}(no session match)")
            continue

        status = session_data.get("status")
        if status not in ("completed", "failed"):
            # Still active or pending — leave alone, check next tick.
            skipped.append(f"{task_id}({status})")
            continue

        # 5. Session is done — route through validator or mark directly.
        existing_meta = (backlog_latest.get(task_id, {}).get("metadata") or {})

        if status == "failed":
            completion_body = {
                "id": task_id,
                "text": f"{task_id} [auto-blocked via session {session_id[:8]} at {entry.get('createdAt', '?')}]",
                "metadata": {
                    "status": "blocked",
                    "kind": existing_meta.get("kind", "auto"),
                    "priority": existing_meta.get("priority", 0),
                    "auto_marked": True,
                    "source_session_id": session_id,
                    "source_session_status": status,
                    "target_workspace_id": target_ws,
                },
            }
            post_status = _post_json(ctx, backlog_url, completion_body)
            observations.append({
                "task_id": task_id,
                "session_id": session_id,
                "session_status": status,
                "marked": "blocked",
                "post_status": post_status,
            })
            closed.append(f"{task_id}->blocked")
            continue

        changed = _extract_changed_files(session_data)
        if changed:
            validator_payload = {
                "sessionId": session_id,
                "changedFiles": changed,
                "taskId": task_id,
                "taskBrief": existing_meta.get("payload", {}).get("task_brief", ""),
                "taskPriority": existing_meta.get("priority", 50),
                "workspaceId": target_ws,
                "dispatcherWorkspaceId": kernel_ws,
            }
            validator_result = _fire_post_session_validator(ctx, platform_url, kernel_ws, validator_payload)
            if validator_result is not None:
                observations.append({
                    "task_id": task_id,
                    "session_id": session_id,
                    "session_status": status,
                    "marked": "delegated-to-validator",
                    "validator_result": validator_result,
                })
                closed.append(f"{task_id}->validated")
                continue

        completion_body = {
            "id": task_id,
            "text": f"{task_id} [auto-completed via session {session_id[:8]} at {entry.get('createdAt', '?')}]",
            "metadata": {
                "status": "completed",
                "kind": existing_meta.get("kind", "auto"),
                "priority": existing_meta.get("priority", 0),
                "auto_marked": True,
                "source_session_id": session_id,
                "source_session_status": status,
                "target_workspace_id": target_ws,
            },
        }
        post_status = _post_json(ctx, backlog_url, completion_body)
        observations.append({
            "task_id": task_id,
            "session_id": session_id,
            "session_status": status,
            "marked": "completed",
            "post_status": post_status,
        })
        closed.append(f"{task_id}->completed")

    return ok({
        "observed_dispatches": len(dispatch_latest),
        "already_completed": len(already_completed),
        "newly_closed": len(closed),
        "closed_tasks": closed,
        "skipped": skipped[:10],  # cap noise
        "observations": observations,
        "rationale": (
            f"Watched {len(dispatch_latest)} dispatched tasks; "
            f"{len(already_completed)} already done; "
            f"closed {len(closed)} this tick: {', '.join(closed) if closed else '(none)'}."
        ),
    })

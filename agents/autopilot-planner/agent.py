"""Autopilot planner — deterministic backlog scheduler for the FAST autopilot loop.

componentize-py compiles this module. It must:
1. Register the handler via @agent decorator (side-effect import)
2. Export the Agent class that componentize-py expects
"""

from __future__ import annotations

import json
from typing import Any

from friday_agent_sdk import agent, err, ok
from friday_agent_sdk._bridge import Agent  # noqa: F401 — componentize-py needs this

# Despite the .yaml extension, the file MUST be valid JSON — no YAML parser
# is available in the WASM stdlib sandbox. Extension preserved for operator
# backwards-compat with renamed .json files.
BACKLOG_URL_DEFAULT = (
    "http://localhost:8080/api/memory/mild_almond/narrative/autopilot-backlog"
)
PLATFORM_URL_DEFAULT = "http://localhost:8080"


def _http_get_json(ctx: Any, url: str) -> dict[str, Any]:
    """Fetch an arbitrary URL and return parsed JSON. Raises on non-200."""
    resp = ctx.http.fetch(url, method="GET", timeout_ms=15000)
    if resp.status != 200:
        raise RuntimeError(f"GET {url} → HTTP {resp.status}")
    return resp.json()


def _narrative_entries_to_backlog(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Map a NarrativeEntry[] response from the corpus endpoint to {tasks: [...]}."""
    tasks: list[dict[str, Any]] = []
    for entry in entries:
        meta = entry.get("metadata") or {}
        tasks.append({
            "id": entry.get("id", ""),
            "title": entry.get("text", ""),
            "status": meta.get("status", "pending"),
            "priority": meta.get("priority", 0),
            "kind": meta.get("kind"),
            "blocked_by": meta.get("blocked_by", []),
            "created_at": entry.get("createdAt", ""),
            "payload": meta.get("payload", {}),
        })
    return {"tasks": tasks}


_LAST_FIRED_DIAG: dict[str, Any] = {}


def _is_leap(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        return 29 if _is_leap(year) else 28
    if month in (4, 6, 9, 11):
        return 30
    return 31


def _iso_subtract_seconds(iso: str, seconds: int) -> str | None:
    """Subtract seconds from an ISO 8601 timestamp string, return ISO string.

    WASM Python sandbox lacks datetime and calendar. Manual math: split the
    ISO into y/mo/d/h/m/s ints, decrement, handle borrow across day/month/year
    boundaries (with leap-year support). Returns None on parse errors.
    """
    try:
        # "2026-04-14T17:33:11.063Z" → date and time parts
        clean = iso.replace("Z", "")
        if "." in clean:
            clean = clean.split(".", 1)[0]
        date_part, time_part = clean.split("T")
        y, mo, d = (int(x) for x in date_part.split("-"))
        h, mi, sec = (int(x) for x in time_part.split(":"))

        total_s = h * 3600 + mi * 60 + sec - seconds
        # Borrow days when negative — walk back through months/years properly
        while total_s < 0:
            total_s += 86400
            d -= 1
            if d <= 0:
                mo -= 1
                if mo <= 0:
                    mo = 12
                    y -= 1
                d = _days_in_month(y, mo)

        new_h = total_s // 3600
        new_m = (total_s % 3600) // 60
        new_s = total_s % 60
        return f"{y:04d}-{mo:02d}-{d:02d}T{new_h:02d}:{new_m:02d}:{new_s:02d}"
    except Exception:  # noqa: BLE001
        return None


def _fired_within(ctx: Any, platform_url: str, workspace_id: str, signal_id: str, cooldown_s: int, match_job_name: str | None = None) -> bool:
    """Return True if signal_id was the target of any session started within the last cooldown_s seconds.

    Uses ISO string comparison (lexical sort works for ISO 8601). Fetches
    the daemon's current time from /health, computes the cutoff ISO by
    subtracting cooldown_s, then compares each recent session's startedAt
    against the cutoff. Falls back to position-based check if the time
    fetch fails.
    """
    diag: dict[str, Any] = {"workspace_id": workspace_id, "signal_id": signal_id, "cooldown_s": cooldown_s}
    _LAST_FIRED_DIAG.clear()
    _LAST_FIRED_DIAG.update(diag)

    try:
        # Fetch daemon's "now"
        cutoff_iso: str | None = None
        try:
            health_url = f"{platform_url}/health"
            health_resp = ctx.http.fetch(health_url, method="GET", timeout_ms=3000)
            if health_resp.status == 200:
                health_data = json.loads(health_resp.body or "{}")
                now_iso = health_data.get("timestamp")
                if isinstance(now_iso, str):
                    cutoff_iso = _iso_subtract_seconds(now_iso, cooldown_s)
                    _LAST_FIRED_DIAG["now_iso"] = now_iso
                    _LAST_FIRED_DIAG["cutoff_iso"] = cutoff_iso
        except Exception:  # noqa: BLE001
            pass

        # Fetch recent sessions
        url = f"{platform_url}/api/sessions?workspaceId={workspace_id}&limit=20"
        resp = ctx.http.fetch(url, method="GET", timeout_ms=5000)
        if resp.status != 200:
            _LAST_FIRED_DIAG["error"] = f"GET {resp.status}"
            return False
        data = json.loads(resp.body or "{}")
        sessions = data.get("sessions") if isinstance(data, dict) else data
        if not isinstance(sessions, list):
            _LAST_FIRED_DIAG["error"] = "sessions not a list"
            return False
        _LAST_FIRED_DIAG["session_count"] = len(sessions)

        # Build the set of names that count as a "match" for this signal.
        # Sessions don't record the signal name, only jobName. Some signals
        # trigger jobs with a different name (e.g. apply-approved-reflection
        # → apply-reflection). The backlog task can pass match_job_name to
        # disambiguate.
        match_names = {signal_id}
        if match_job_name:
            match_names.add(match_job_name)
        _LAST_FIRED_DIAG["match_names"] = list(match_names)

        for idx, s in enumerate(sessions):
            if not isinstance(s, dict):
                continue
            if s.get("jobName") not in match_names and s.get("signalId") not in match_names:
                continue
            started = s.get("startedAt")
            if not isinstance(started, str):
                continue
            # Time-based check: ISO string comparison (lexical sort works)
            if cutoff_iso is not None:
                # Strip subseconds + Z for comparable form
                started_clean = started.replace("Z", "").split(".", 1)[0]
                if started_clean >= cutoff_iso:
                    _LAST_FIRED_DIAG["matched_at_position"] = idx
                    _LAST_FIRED_DIAG["matched_started_at"] = started
                    return True
            else:
                # Fallback to position-based heuristic if cutoff calc failed
                n_window = max(1, min(20, cooldown_s // 60))
                if idx < n_window:
                    _LAST_FIRED_DIAG["matched_at_position"] = idx
                    _LAST_FIRED_DIAG["fallback"] = "position-based"
                    return True
        _LAST_FIRED_DIAG["matched_at_position"] = -1
        return False
    except Exception as exc:  # noqa: BLE001 — be defensive, fail open
        _LAST_FIRED_DIAG["exception"] = str(exc)[:200]
        return False


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
    version="1.3.1",
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
            raw_data = _http_get_json(ctx, backlog_url)
        except RuntimeError as exc:
            return err(f"Failed to fetch backlog: {exc}")

        # Support NarrativeEntry[] from corpus endpoint (list at root)
        # as well as legacy {tasks: [...]} format (dict at root).
        if isinstance(raw_data, list):
            data = _narrative_entries_to_backlog(raw_data)
        elif isinstance(raw_data, dict):
            data = raw_data
        else:
            return err("Backlog JSON root must be an object or array")

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

    # ── Skip-recent filter ──────────────────────────────────────────
    # Walk eligible tasks and pick the first that hasn't fired in the
    # cooldown window. Default cooldown 600s. Stops the cron-driven
    # treadmill where the same highest-priority task fires every tick.
    cooldown_s = int(cfg.get("cooldown_s", 600))
    platform_url = cfg.get("platformUrl", PLATFORM_URL_DEFAULT)
    chosen_task = None
    skip_reasons: list[str] = []
    for candidate in eligible:
        cand_payload = candidate.get("payload") or {}
        cand_ws = cand_payload.get("workspace_id")
        cand_sig = cand_payload.get("signal_id")
        if not cand_ws or not cand_sig:
            chosen_task = candidate
            break
        cand_match_job = candidate.get("match_job_name")
        if _fired_within(ctx, platform_url, cand_ws, cand_sig, cooldown_s, cand_match_job):
            skip_reasons.append(f"{candidate.get('id')} (fired in last {cooldown_s}s)")
            continue
        chosen_task = candidate
        break

    if chosen_task is None:
        return ok({
            "action": "idle",
            "task_id": None,
            "target_workspace_id": None,
            "target_signal_id": None,
            "signal_payload": None,
            "task_kind": None,
            "rationale": "all eligible tasks in cooldown: " + "; ".join(skip_reasons),
        })

    task = chosen_task
    payload = task.get("payload") or {}

    target_workspace_id = payload.get("workspace_id")
    target_signal_id = payload.get("signal_id")

    if not target_workspace_id:
        return err(f"Task '{task.get('id')}' payload missing 'workspace_id'")
    if not target_signal_id:
        return err(f"Task '{task.get('id')}' payload missing 'signal_id'")

    # ── Inline dispatch ─────────────────────────────────────────────
    # Workaround for daemon bug: when an FSM step invokes a SECOND user
    # agent (e.g. dispatcher after planner), the agentContext is missing
    # http/stream bindings. Until the daemon is fixed, the planner does
    # the dispatch itself in the same FSM step. POST with a short timeout
    # and return immediately — fire-and-forget. Polling is dropped; the
    # daemon's session list will reflect the work asynchronously.
    fire_url = f"{cfg.get('platformUrl', PLATFORM_URL_DEFAULT)}/api/workspaces/{target_workspace_id}/signals/{target_signal_id}"
    fire_payload = {"payload": payload}
    fire_status: int | str = "fired"
    fire_session_id: str | None = None
    try:
        body = json.dumps(fire_payload)
        resp = ctx.http.fetch(
            fire_url,
            method="POST",
            headers={"Content-Type": "application/json"},
            body=body,
            timeout_ms=5000,
        )
        fire_status = resp.status
        if resp.status == 200 and resp.body:
            try:
                fire_session_id = json.loads(resp.body).get("sessionId")
            except json.JSONDecodeError:
                pass
    except Exception as exc:  # noqa: BLE001 — host fetch may raise opaque errors
        fire_status = f"fetch-error: {str(exc)[:160]}"

    return ok({
        "action": "execute",
        "task_id": task.get("id"),
        "target_workspace_id": target_workspace_id,
        "target_signal_id": target_signal_id,
        "signal_payload": payload,
        "task_kind": task.get("kind"),
        "fired_status": fire_status,
        "fired_session_id": fire_session_id,
        "fired_diag": dict(_LAST_FIRED_DIAG),
        "rationale": (
            f"Selected and fired task '{task.get('id')}' (priority={task.get('priority', 0)}, "
            f"kind={task.get('kind')}). Fire status: {fire_status}. "
            f"Cooldown diag: {dict(_LAST_FIRED_DIAG)}"
        ),
    })

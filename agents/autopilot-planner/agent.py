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
    "http://localhost:8080/api/memory/salted_granola/narrative/autopilot-backlog"
)
DISPATCH_LOG_URL_DEFAULT = (
    "http://localhost:8080/api/memory/salted_granola/narrative/dispatch-log"
)
PLATFORM_URL_DEFAULT = "http://localhost:8080"


def _http_get_json(ctx: Any, url: str) -> dict[str, Any]:
    """Fetch an arbitrary URL and return parsed JSON. Raises on non-200."""
    resp = ctx.http.fetch(url, method="GET", timeout_ms=15000)
    if resp.status != 200:
        raise RuntimeError(f"GET {url} → HTTP {resp.status}")
    return resp.json()


def _narrative_entries_to_backlog(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Map a NarrativeEntry[] response from the corpus endpoint to {tasks: [...]}.

    The narrative corpus is append-only, so a single task_id can have multiple
    entries reflecting its status transitions (pending → completed, etc).
    Dedupe by id keeping the latest createdAt so a `completed` entry shadows
    an earlier `pending` one. Without this dedupe the planner re-dispatches
    completed tasks forever because the stale pending entry still satisfies
    the eligibility filter.
    """
    latest_by_id: dict[str, dict[str, Any]] = {}
    for entry in entries:
        eid = entry.get("id", "")
        if not eid:
            continue
        prior = latest_by_id.get(eid)
        if prior is None or entry.get("createdAt", "") > prior.get("createdAt", ""):
            latest_by_id[eid] = entry

    tasks: list[dict[str, Any]] = []
    for entry in latest_by_id.values():
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


def _now_iso(ctx: Any, platform_url: str) -> str | None:
    """Fetch the daemon's current ISO timestamp from /health."""
    try:
        resp = ctx.http.fetch(f"{platform_url}/health", method="GET", timeout_ms=3000)
        if resp.status != 200:
            return None
        data = json.loads(resp.body or "{}")
        ts = data.get("timestamp")
        return ts if isinstance(ts, str) else None
    except Exception:  # noqa: BLE001
        return None


def _last_dispatch_iso(ctx: Any, dispatch_log_url: str, task_id: str) -> str | None:
    """Return ISO string of the most recent dispatch for this task_id, or None.

    Reads the dispatch-log narrative corpus on the kernel workspace, filters
    entries where id == task_id, returns the max createdAt. Per-task tracking
    means cooldown is applied to THIS task, not to the signal it fires.
    """
    try:
        resp = ctx.http.fetch(dispatch_log_url, method="GET", timeout_ms=3000)
        if resp.status != 200:
            return None
        entries = json.loads(resp.body or "[]")
        if not isinstance(entries, list):
            return None
        candidates = [e for e in entries if isinstance(e, dict) and e.get("id") == task_id]
        if not candidates:
            return None
        candidates.sort(key=lambda e: e.get("createdAt", ""), reverse=True)
        return candidates[0].get("createdAt")
    except Exception:  # noqa: BLE001
        return None


def _within_cooldown(now_iso: str | None, last_iso: str | None, cooldown_s: int) -> bool:
    """ISO-string comparison cooldown check. Returns True if last_iso is within cooldown_s of now_iso."""
    if not last_iso or not now_iso:
        return False
    cutoff = _iso_subtract_seconds(now_iso, cooldown_s)
    if not cutoff:
        return False
    last_clean = last_iso.replace("Z", "").split(".", 1)[0]
    return last_clean >= cutoff


def _log_dispatch(
    ctx: Any,
    dispatch_log_url: str,
    task_id: str,
    target_workspace_id: str,
    target_signal_id: str,
    session_id: str | None,
    now_iso: str | None,
) -> None:
    """POST a dispatch record to the dispatch-log corpus. Best-effort; never raises."""
    try:
        body = json.dumps({
            "id": task_id,
            "text": f"Dispatched {task_id} → {target_workspace_id}/{target_signal_id} session={session_id or '?'}",
            "createdAt": now_iso,
            "metadata": {
                "task_id": task_id,
                "target_workspace_id": target_workspace_id,
                "target_signal_id": target_signal_id,
                "session_id": session_id,
                "dispatched_at": now_iso,
            },
        })
        ctx.http.fetch(
            dispatch_log_url,
            method="POST",
            headers={"Content-Type": "application/json"},
            body=body,
            timeout_ms=5000,
        )
    except Exception:  # noqa: BLE001
        pass


def _filter_eligible(tasks: list[dict[str, Any]], completed_ids: set[str]) -> list[dict[str, Any]]:
    """Return pending, unblocked, auto-apply-eligible tasks sorted by priority desc then created_at asc."""
    eligible = [
        t for t in tasks
        if t.get("status") == "pending"
        and (t.get("metadata", {}).get("auto_apply") is not False)
        and all(dep in completed_ids for dep in t.get("blocked_by", []))
    ]
    eligible.sort(key=lambda t: (-t.get("priority", 0), t.get("created_at", "")))
    return eligible


@agent(
    id="autopilot-planner",
    version="1.6.0",
    description=(
        "Deterministic backlog planner for the FAST autopilot loop. "
        "Fetches a JSON backlog, filters and sorts pending tasks by priority "
        "and dependency resolution, returns the next task to execute, fires "
        "the target signal inline, and logs the dispatch to a per-task "
        "dispatch-log corpus. v1.6.0: dedupes narrative-corpus entries by "
        "task_id so completed entries shadow earlier pending ones — fixes "
        "a bug where 189 of 232 sessions were re-dispatching already-done "
        "tasks. v1.5.0: skips tasks with auto_apply=false (surface-only, "
        "human-gated). v1.4.0: per-TASK cooldown (was per-signal in v1.3.x)."
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

    # ── Per-task cooldown filter ────────────────────────────────────
    # v1.4.0: track last dispatch per TASK_ID via the dispatch-log
    # narrative corpus on the kernel workspace. v1.3.x's per-signal
    # cooldown locked out every task sharing a target signal after
    # one fired — useless for parity work where many tasks share
    # braised_biscuit/run-task. Default cooldown 600s.
    cooldown_s = int(cfg.get("cooldown_s", 600))
    platform_url = cfg.get("platformUrl", PLATFORM_URL_DEFAULT)
    dispatch_log_url = cfg.get("dispatch_log_url", DISPATCH_LOG_URL_DEFAULT)
    now_iso = _now_iso(ctx, platform_url)

    chosen_task = None
    skip_reasons: list[str] = []
    for candidate in eligible:
        cand_id = candidate.get("id")
        cand_payload = candidate.get("payload") or {}
        cand_ws = cand_payload.get("workspace_id")
        cand_sig = cand_payload.get("signal_id")
        if not cand_id or not cand_ws or not cand_sig:
            # Tasks missing dispatch info aren't eligible to fire — skip rather
            # than crash the whole tick; the operator can backfill the payload.
            skip_reasons.append(f"{cand_id or '?'} (missing id/workspace_id/signal_id)")
            continue
        last_iso = _last_dispatch_iso(ctx, dispatch_log_url, cand_id)
        if _within_cooldown(now_iso, last_iso, cooldown_s):
            skip_reasons.append(f"{cand_id} (last dispatch {last_iso})")
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
    # Daemon's signal POST blocks until the FSM completes, which can take
    # minutes for claude-code targets. We use a SHORT timeout (1500ms) and
    # ALWAYS log to dispatch-log on the abort — the dispatch went through
    # on the daemon side; we just can't see the response. The cooldown
    # mechanism cares about "did we already try this task", not "did it
    # succeed". A genuine failure (4xx, missing workspace) at most causes
    # a re-dispatch a cooldown period later.
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
            timeout_ms=1500,
        )
        fire_status = resp.status
        if resp.status == 200 and resp.body:
            try:
                fire_session_id = json.loads(resp.body).get("sessionId")
            except json.JSONDecodeError:
                pass
    except Exception as exc:  # noqa: BLE001 — host fetch may raise opaque errors
        fire_status = f"fetch-error: {str(exc)[:160]}"

    # Log dispatch unconditionally — see comment above. The dispatch-log
    # is the cooldown source of truth, not the daemon response.
    _log_dispatch(
        ctx,
        dispatch_log_url,
        task.get("id"),
        target_workspace_id,
        target_signal_id,
        fire_session_id,
        now_iso,
    )

    return ok({
        "action": "execute",
        "task_id": task.get("id"),
        "target_workspace_id": target_workspace_id,
        "target_signal_id": target_signal_id,
        "signal_payload": payload,
        "task_kind": task.get("kind"),
        "fired_status": fire_status,
        "fired_session_id": fire_session_id,
        "rationale": (
            f"Selected and fired task '{task.get('id')}' (priority={task.get('priority', 0)}, "
            f"kind={task.get('kind')}). Fire status: {fire_status}. "
            f"Skipped: {len(skip_reasons)} ({'; '.join(skip_reasons[:3])}{'...' if len(skip_reasons) > 3 else ''})."
        ),
    })

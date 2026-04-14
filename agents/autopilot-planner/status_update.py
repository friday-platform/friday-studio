"""Status update helper for autopilot-planner.

Provides post_in_progress() — called immediately after a successful HTTP
dispatch to record an in_progress entry in the autopilot-backlog corpus.
The status-watcher kernel job reads these entries to close the loop.
"""

from __future__ import annotations

import json
from typing import Any

CORPUS_NAME = "autopilot-backlog"


def post_in_progress(
    ctx: Any,
    corpus_url: str,
    task_id: str,
    dispatched_session_id: str,
    now_iso: str | None = None,
) -> bool:
    """Append an in_progress NarrativeEntry to the autopilot-backlog corpus.

    Idempotent: checks for an existing in_progress entry with the same task_id
    before appending. Returns True if an entry was appended, False if skipped
    (already exists) or on error.
    """
    try:
        resp = ctx.http.fetch(corpus_url, method="GET", timeout_ms=5000)
        if resp.status == 200:
            entries = json.loads(resp.body or "[]")
            if isinstance(entries, list):
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    meta = entry.get("metadata") or {}
                    if (
                        entry.get("id") == task_id
                        and meta.get("status") == "in_progress"
                    ):
                        return False
    except Exception:  # noqa: BLE001
        pass

    body = json.dumps({
        "id": task_id,
        "text": f"Task {task_id} dispatched to session {dispatched_session_id}",
        "createdAt": now_iso or "",
        "metadata": {
            "status": "in_progress",
            "task_id": task_id,
            "dispatched_session_id": dispatched_session_id,
        },
    })
    try:
        resp = ctx.http.fetch(
            corpus_url,
            method="POST",
            headers={"Content-Type": "application/json"},
            body=body,
            timeout_ms=5000,
        )
        return resp.status == 200 or resp.status == 201
    except Exception:  # noqa: BLE001
        return False

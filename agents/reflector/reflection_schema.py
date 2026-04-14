"""Pydantic-free reflection payload schema for the 'reflections' narrative corpus.

Fields map 1-to-1 to NarrativeEntry: id, text, author='reflector', createdAt
(ISO-8601), metadata={target_workspace_id, target_session_id, finding_type,
severity, proposed_action}.

Uses stdlib only — no external packages available inside the WASM sandbox.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

FINDING_TYPES = frozenset({"SKILL_GAP", "PROCESS_DRIFT", "ANOMALY", "INFO"})
SEVERITIES = frozenset({"CRITICAL", "HIGH", "MEDIUM", "LOW"})

REFLECTIONS_NAMESPACE = uuid.UUID("a1b2c3d4-e5f6-7890-abcd-ef1234567890")


def _deterministic_id(session_id: str, run_id: str, step_index: int) -> str:
    """uuid5 from (session_id, run_id, step_index) for replay idempotency."""
    name = f"{session_id}:{run_id}:{step_index}"
    return str(uuid.uuid5(REFLECTIONS_NAMESPACE, name))


class ReflectionEntry:
    """Structured reflection payload that serialises to NarrativeEntry dict."""

    def __init__(
        self,
        *,
        text: str,
        target_workspace_id: str,
        target_session_id: str,
        finding_type: str,
        severity: str,
        proposed_action: str,
        session_id: str | None = None,
        run_id: str | None = None,
        step_index: int = 0,
    ) -> None:
        if finding_type not in FINDING_TYPES:
            raise ValueError(f"finding_type must be one of {sorted(FINDING_TYPES)}, got {finding_type!r}")
        if severity not in SEVERITIES:
            raise ValueError(f"severity must be one of {sorted(SEVERITIES)}, got {severity!r}")
        if not text:
            raise ValueError("text must be non-empty")

        if session_id and run_id:
            self.id = _deterministic_id(session_id, run_id, step_index)
        else:
            self.id = str(uuid.uuid4())

        self.text = text
        self.author: Literal["reflector"] = "reflector"
        self.created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        self.metadata: dict[str, Any] = {
            "target_workspace_id": target_workspace_id,
            "target_session_id": target_session_id,
            "finding_type": finding_type,
            "severity": severity,
            "proposed_action": proposed_action,
        }

    def to_narrative_entry(self) -> dict[str, Any]:
        """Serialise to the NarrativeEntry shape expected by the daemon API."""
        return {
            "id": self.id,
            "text": self.text,
            "author": self.author,
            "createdAt": self.created_at,
            "metadata": self.metadata,
        }

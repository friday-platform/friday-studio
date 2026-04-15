"""skill-publisher: deterministic skill publish agent for the FAST self-mod loop.

Replaces the claude-code-based skill-updater in grilled_xylem with a pure
Python agent that does the mechanical work of publishing a skill update via
the daemon's skill upload endpoint. No LLM calls; pure HTTP + multipart
encoding. Sub-second instead of multi-minute.

Input shape (passed via task config):
  reflection_session_id: str    — session ID of a completed reflect-on-last-run
  confidence_threshold: float   — minimum confidence to apply (default 0.9)

Behavior:
  1. Verify input fields present
  2. GET /api/sessions/{reflection_session_id} to fetch the reflection-output
  3. Extract new_skill_md, confidence, current_skill_version, etc.
  4. If confidence < threshold → return applied=false with rationale
  5. GET /api/skills/@tempest/fast-self-modification → record previous_version
  6. Build multipart/form-data with skillMd field containing new_skill_md
  7. POST /api/skills/@tempest/fast-self-modification/upload
  8. Return structured result with new_version, previous_version, rollback hint

This is a Phase-5 reinforcement loop primitive built on the Phase-1
modification-surface ladder Tier 5 (agent SDK authorship). It demonstrates
that the autonomous skill-evolution loop can run on cheap, deterministic
agents — no opus + effort=high required for purely mechanical work.
"""

from __future__ import annotations

import json
import secrets
from typing import Any

from friday_agent_sdk import AgentContext, agent, err, ok

# Re-export the WIT bridge Agent class so componentize-py finds it.
# The build pipeline expects the user `agent` module to export Agent at
# module level; the @agent decorator below registers the handler, and
# the bridge's Agent class delegates to it via the registry.
from friday_agent_sdk._bridge import Agent  # noqa: F401


PLATFORM_URL_DEFAULT = "http://localhost:8080"
SKILL_NAMESPACE = "tempest"
SKILL_NAME = "fast-self-modification"
DEFAULT_CONFIDENCE_THRESHOLD = 0.9


def _build_multipart(fields: dict[str, str]) -> tuple[str, str]:
    """Encode form fields as multipart/form-data. Returns (content_type, body).

    Pure Python encoder — no requests/urllib3 dependency. Generates a random
    boundary, joins parts, returns the assembled body string. The Friday
    daemon's skill upload endpoint reads form fields via formData.get().
    """
    boundary = f"----FastSelfModBoundary{secrets.token_hex(8)}"
    parts: list[str] = []
    for name, value in fields.items():
        parts.append(f"--{boundary}")
        parts.append(f'Content-Disposition: form-data; name="{name}"')
        parts.append("")
        parts.append(value)
    parts.append(f"--{boundary}--")
    parts.append("")
    body = "\r\n".join(parts)
    content_type = f"multipart/form-data; boundary={boundary}"
    return content_type, body


def _platform_url(ctx: AgentContext) -> str:
    return ctx.config.get("platformUrl", PLATFORM_URL_DEFAULT) if ctx.config else PLATFORM_URL_DEFAULT


def _fetch_reflection(ctx: AgentContext, session_id: str) -> dict[str, Any]:
    """GET the reflection session and extract the reflection-output payload."""
    url = f"{_platform_url(ctx)}/api/sessions/{session_id}"
    resp = ctx.http.fetch(url, method="GET", timeout_ms=10000)
    if resp.status != 200:
        raise RuntimeError(f"failed to fetch reflection session {session_id}: HTTP {resp.status}")
    data = resp.json()
    blocks = data.get("agentBlocks", [])
    for block in blocks:
        if block.get("stateId") == "step_reflect":
            output = block.get("output")
            if isinstance(output, str):
                return json.loads(output)
            if isinstance(output, dict):
                return output
            return {}
    raise RuntimeError(f"reflection session {session_id} has no step_reflect block")


def _fetch_current_skill(ctx: AgentContext) -> dict[str, Any]:
    """GET the current skill metadata to record previous_version for rollback."""
    url = f"{_platform_url(ctx)}/api/skills/@{SKILL_NAMESPACE}/{SKILL_NAME}"
    resp = ctx.http.fetch(url, method="GET", timeout_ms=10000)
    if resp.status != 200:
        raise RuntimeError(f"failed to fetch current skill metadata: HTTP {resp.status}")
    data = resp.json()
    return data.get("skill", data)


def _publish_skill(ctx: AgentContext, new_skill_md: str) -> dict[str, Any]:
    """POST the new skill content to the daemon's upload endpoint."""
    url = f"{_platform_url(ctx)}/api/skills/@{SKILL_NAMESPACE}/{SKILL_NAME}/upload"
    content_type, body = _build_multipart({"skillMd": new_skill_md})
    resp = ctx.http.fetch(
        url,
        method="POST",
        headers={"Content-Type": content_type},
        body=body,
        timeout_ms=30000,
    )
    if resp.status not in (200, 201):
        raise RuntimeError(f"skill upload failed: HTTP {resp.status} body={resp.body[:300]}")
    return resp.json()


@agent(
    id="skill-publisher",
    version="1.1.0",
    description=(
        "Deterministic skill publisher for the FAST self-modification loop. "
        "Reads a completed reflection session, verifies confidence threshold, "
        "and publishes the proposed SKILL.md as a new version of "
        "@tempest/fast-self-modification. Pure HTTP + multipart, no LLM calls."
    ),
    summary="Publishes reflector-approved skill updates via the daemon API.",
    examples=[
        "Apply approved reflection from session abc-123",
        "Publish skill v2 from completed reflection",
    ],
)
def execute(prompt: str, ctx: AgentContext) -> Any:
    config = ctx.config or {}
    session_id = config.get("reflection_session_id")
    threshold = float(config.get("confidence_threshold", DEFAULT_CONFIDENCE_THRESHOLD))
    target_workspace = config.get("workspace_id", "artisan_ink")

    # If no session_id provided, walk recent sessions on the target workspace
    # and find the most recent reflect-on-last-run with skill_update_proposed=true.
    # This makes the signal safe to fire periodically without an explicit ID.
    if not session_id or not isinstance(session_id, str):
        ctx.stream.progress(
            f"no reflection_session_id provided; walking recent sessions on {target_workspace}"
        )
        try:
            url = f"{_platform_url(ctx)}/api/sessions?workspaceId={target_workspace}&limit=20"
            resp = ctx.http.fetch(url, method="GET", timeout_ms=10000)
            if resp.status != 200:
                return err(f"could not list sessions on {target_workspace}: HTTP {resp.status}")
            data = resp.json()
            sessions = data.get("sessions") if isinstance(data, dict) else data
            if not isinstance(sessions, list):
                return err("sessions list response not an array")
            # Find the first reflect-on-last-run with skill_update_proposed=true
            for s in sessions:
                if not isinstance(s, dict):
                    continue
                if s.get("jobName") != "reflect-on-last-run":
                    continue
                if s.get("status") != "completed":
                    continue
                # Probe the session to check skill_update_proposed
                try:
                    probe = _fetch_reflection(ctx, s.get("sessionId") or s.get("id"))
                    if probe.get("skill_update_proposed"):
                        session_id = s.get("sessionId") or s.get("id")
                        break
                except Exception:
                    continue
            if not session_id:
                return ok({
                    "applied": False,
                    "rationale": (
                        f"no reflect-on-last-run session on {target_workspace} "
                        "with skill_update_proposed=true; nothing to apply"
                    ),
                    "summary": "no-op: no eligible reflection found",
                })
        except Exception as exc:
            return err(f"failed walking sessions: {exc}")

    ctx.stream.progress(f"fetching reflection session {session_id}")
    try:
        reflection = _fetch_reflection(ctx, session_id)
    except Exception as exc:
        return err(f"fetch reflection failed: {exc}")

    proposed = reflection.get("skill_update_proposed")
    if not proposed:
        return ok(
            {
                "applied": False,
                "rationale": "reflection.skill_update_proposed is false; nothing to publish",
                "summary": "no-op: reflection did not propose an update",
                "reflection_outcome": reflection.get("outcome"),
            }
        )

    new_skill_md = reflection.get("new_skill_md")
    if not new_skill_md or not isinstance(new_skill_md, str):
        return err(
            "reflection proposes update but new_skill_md is missing or not a string"
        )

    confidence = reflection.get("confidence")
    if confidence is None or not isinstance(confidence, (int, float)):
        return err("reflection missing required confidence field for publish gate")

    confidence_float = float(confidence)
    if confidence_float < threshold:
        return ok(
            {
                "applied": False,
                "confidence_observed": confidence_float,
                "confidence_threshold": threshold,
                "rationale": (
                    f"reflection confidence {confidence_float:.2f} below "
                    f"publish threshold {threshold:.2f} — surfacing as proposal "
                    "for human review only"
                ),
                "summary": (
                    f"deferred: confidence {confidence_float:.2f} < threshold "
                    f"{threshold:.2f}"
                ),
                "diff_summary": reflection.get("diff_summary"),
            }
        )

    ctx.stream.progress("fetching current skill metadata for rollback")
    try:
        current = _fetch_current_skill(ctx)
    except Exception as exc:
        return err(f"fetch current skill failed: {exc}")
    previous_version = current.get("version")

    ctx.stream.progress(
        f"publishing new skill version (was v{previous_version}, "
        f"{len(new_skill_md)} chars)"
    )
    try:
        publish_result = _publish_skill(ctx, new_skill_md)
    except Exception as exc:
        return err(f"publish failed: {exc}")

    published = publish_result.get("published", {})
    new_version = published.get("version")

    rollback_command = (
        "# Re-fetch the previous version's content from a backup or git, then:\n"
        f"curl -X POST {_platform_url(ctx)}/api/skills/"
        f"@{SKILL_NAMESPACE}/{SKILL_NAME}/upload "
        '-F "skillMd=<previous-skill.md"'
    )

    return ok(
        {
            "applied": True,
            "new_version": new_version,
            "previous_version": previous_version,
            "skill_namespace": SKILL_NAMESPACE,
            "skill_name": SKILL_NAME,
            "confidence_observed": confidence_float,
            "confidence_threshold": threshold,
            "rationale": (
                f"reflection confidence {confidence_float:.2f} >= "
                f"threshold {threshold:.2f}; published v{new_version} "
                f"(was v{previous_version})"
            ),
            "rollback_command": rollback_command,
            "summary": (
                f"published @{SKILL_NAMESPACE}/{SKILL_NAME} v{new_version} "
                f"from reflection session {session_id}"
            ),
        }
    )

"""session-summarizer: deterministic session parser for cross-session pattern detection.

Pure mechanical extraction of structural signals from a session's agent blocks.
No LLM call. Fetches a session via the daemon HTTP API, iterates over
agentBlocks, extracts structured outputs using the same dual-path logic as the
reflector, and returns a flat dict optimized for cross-session comparison.

Designed as a cheap building block the reflector can call N times to scan
multiple sessions before making judgment calls.

Input (via ctx.config):
  session_id: str          - required, the session to summarize
  platformUrl: str | None  - optional, defaults to http://localhost:8080

Output (flat dict):
  {
    session_id, workspace_id, status, task, started_at, duration_seconds,
    step_count, architect_summary, coder_summary, reviewer_summary,
    verdict, finding_count, finding_severities, files_written_count,
    deno_check_passed, deno_lint_passed
  }
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from friday_agent_sdk import AgentContext, agent, err, ok

# Re-export the WIT bridge Agent class so componentize-py finds it.
from friday_agent_sdk._bridge import Agent  # noqa: F401


PLATFORM_URL_DEFAULT = "http://localhost:8080"
MAX_SUMMARY_CHARS = 400


def _platform_url(ctx: AgentContext) -> str:
    return ctx.config.get("platformUrl", PLATFORM_URL_DEFAULT) if ctx.config else PLATFORM_URL_DEFAULT


def _http_get_json(ctx: AgentContext, path: str) -> dict[str, Any]:
    url = f"{_platform_url(ctx)}{path}"
    resp = ctx.http.fetch(url, method="GET", timeout_ms=10000)
    if resp.status != 200:
        raise RuntimeError(f"GET {path} \u2192 HTTP {resp.status}")
    return resp.json()


def _fetch_session(ctx: AgentContext, session_id: str) -> dict[str, Any]:
    return _http_get_json(ctx, f"/api/sessions/{session_id}")


def _extract_block_output(block: dict[str, Any]) -> dict[str, Any]:
    """Extract structured output from an agent block.

    Bundled claude-code agents put structured output in `block.output`.
    LLM-typed agents use `toolCalls[-1].args` with `complete` tool name.
    Try both.
    """
    output = block.get("output")
    if isinstance(output, dict):
        return output
    if isinstance(output, str):
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            pass
    for tc in reversed(block.get("toolCalls", [])):
        if tc.get("toolName") == "complete":
            args = tc.get("args")
            if isinstance(args, dict):
                return args
    return {}


def _compute_duration(session: dict[str, Any]) -> float | None:
    """Compute session duration in seconds from ISO timestamps.

    Returns None if either timestamp is missing or unparseable.
    """
    started = session.get("startedAt")
    completed = session.get("completedAt")
    if not started or not completed:
        return None
    try:
        start_dt = datetime.fromisoformat(started)
        end_dt = datetime.fromisoformat(completed)
        return (end_dt - start_dt).total_seconds()
    except (ValueError, TypeError):
        return None


def _truncate(text: str | None, max_chars: int = MAX_SUMMARY_CHARS) -> str | None:
    if text is None:
        return None
    text = str(text)
    if len(text) <= max_chars:
        return text
    return text[:max_chars]


@agent(
    id="session-summarizer",
    version="1.0.0",
    description=(
        "Deterministic session parser that fetches a session via the daemon "
        "HTTP API and returns a flat structured summary for cross-session "
        "pattern detection. No LLM call. Pure mechanical extraction."
    ),
    summary="Fetches a session, extracts structural signals into a flat summary dict.",
    examples=[
        "Summarize session abc-123",
        "Extract structural signals from session xyz-456",
    ],
)
def execute(prompt: str, ctx: AgentContext) -> Any:
    config = ctx.config or {}
    session_id = config.get("session_id")

    if not session_id:
        return err("session_id is required in ctx.config")

    ctx.stream.progress("fetching session")
    try:
        session = _fetch_session(ctx, session_id)
    except Exception as exc:
        return err(f"fetch session failed: {exc}")

    ctx.stream.progress("extracting structural signals")

    # Index blocks by stateId for targeted extraction.
    blocks = session.get("agentBlocks", [])
    by_state: dict[str, dict[str, Any]] = {}
    for block in blocks:
        state_id = block.get("stateId", "")
        by_state[state_id] = block

    research = by_state.get("step_research", {})
    implement = by_state.get("step_implement", {})
    review = by_state.get("step_review", {})

    research_out = _extract_block_output(research)
    impl_out = _extract_block_output(implement)
    review_out = _extract_block_output(review)

    # Architect summary: prefer integration_notes, fall back to summary.
    architect_text = research_out.get("integration_notes") or research_out.get("summary")
    architect_summary = _truncate(architect_text)

    # Coder summary.
    coder_summary = _truncate(impl_out.get("summary"))

    # Reviewer summary.
    reviewer_summary = _truncate(review_out.get("summary"))

    # Reviewer findings.
    findings = review_out.get("findings", [])
    finding_severities = [f.get("severity") for f in findings if isinstance(f, dict)]

    # Duration.
    duration_seconds = _compute_duration(session)

    return ok({
        "session_id": session.get("sessionId"),
        "workspace_id": session.get("workspaceId"),
        "status": session.get("status"),
        "task": session.get("task"),
        "started_at": session.get("startedAt"),
        "duration_seconds": duration_seconds,
        "step_count": len(blocks),
        "architect_summary": architect_summary,
        "coder_summary": coder_summary,
        "reviewer_summary": reviewer_summary,
        "verdict": review_out.get("verdict"),
        "finding_count": len(findings),
        "finding_severities": finding_severities,
        "files_written_count": len(impl_out.get("files_written", [])),
        "deno_check_passed": impl_out.get("deno_check_passed"),
        "deno_lint_passed": impl_out.get("deno_lint_passed"),
    })

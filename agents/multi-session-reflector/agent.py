"""Cross-session reflector agent.

Fetches the last N completed sessions for a workspace, computes per-session
structural summaries, builds an aggregate with outcome buckets and pass rates,
fetches the current fast-self-modification skill, then makes a SINGLE LLM call
to judge whether a recurring failure pattern warrants a skill update.

Closes parity-plan open question #20.
"""

from __future__ import annotations

import json
from typing import Any

from friday_agent_sdk import AgentContext, LlmError, agent, err, ok

# Re-export the WIT bridge Agent class so componentize-py finds it.
from friday_agent_sdk._bridge import Agent  # noqa: F401


PLATFORM_URL_DEFAULT = "http://localhost:8080"
BACKLOG_CORPUS_URL_DEFAULT = (
    "http://localhost:8080/api/memory/thick_endive/narrative/autopilot-backlog"
)
SKILL_NAMESPACE = "tempest"
SKILL_NAME = "fast-self-modification"
JUDGMENT_MODEL = "anthropic:claude-haiku-4-5"
JUDGMENT_MAX_TOKENS = 2048
MAX_SUMMARY_CHARS = 300

JUDGMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "matches_known_pattern": {"type": "boolean"},
        "recurring_pattern_key": {
            "anyOf": [{"type": "string"}, {"type": "null"}],
        },
        "skill_update_warranted": {"type": "boolean"},
        "new_failure_mode": {
            "anyOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "symptom": {"type": "string"},
                        "root_cause": {"type": "string"},
                        "structural_fix": {"type": "string"},
                    },
                    "required": ["symptom", "root_cause", "structural_fix"],
                },
                {"type": "null"},
            ],
        },
        "confidence": {"type": "number"},
        "rationale": {"type": "string"},
    },
    "required": [
        "matches_known_pattern",
        "recurring_pattern_key",
        "skill_update_warranted",
        "new_failure_mode",
        "confidence",
        "rationale",
    ],
}


# ---------------------------------------------------------------------------
# HTTP helpers (same pattern as reflector/agent.py)
# ---------------------------------------------------------------------------

def _platform_url(ctx: AgentContext) -> str:
    return ctx.config.get("platformUrl", PLATFORM_URL_DEFAULT) if ctx.config else PLATFORM_URL_DEFAULT


def _http_get_json(ctx: AgentContext, path: str) -> dict[str, Any]:
    url = f"{_platform_url(ctx)}{path}"
    resp = ctx.http.fetch(url, method="GET", timeout_ms=10000)
    if resp.status != 200:
        raise RuntimeError(f"GET {path} → HTTP {resp.status}")
    return resp.json()


def _fetch_session(ctx: AgentContext, session_id: str) -> dict[str, Any]:
    return _http_get_json(ctx, f"/api/sessions/{session_id}")


def _fetch_current_skill(ctx: AgentContext) -> dict[str, Any]:
    data = _http_get_json(ctx, f"/api/skills/@{SKILL_NAMESPACE}/{SKILL_NAME}")
    return data.get("skill", data)


# ---------------------------------------------------------------------------
# Block output extraction (verbatim from session-summarizer & reflector)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Session fetching & summarization
# ---------------------------------------------------------------------------

def _fetch_completed_sessions(ctx: AgentContext, workspace_id: str, n: int) -> list[dict[str, Any]]:
    data = _http_get_json(ctx, f"/api/sessions?workspaceId={workspace_id}&limit={n * 2}")
    sessions_list = data if isinstance(data, list) else data.get("sessions", [])
    completed = [s for s in sessions_list if s.get("status") == "completed"]
    completed = completed[:n]
    if len(completed) < 1:
        raise RuntimeError(f"No completed sessions found for workspace {workspace_id}")
    full_sessions = []
    for s in completed:
        sid = s.get("sessionId") or s.get("id")
        if sid:
            full_sessions.append(_fetch_session(ctx, sid))
    return full_sessions


def _truncate(text: Any, limit: int = MAX_SUMMARY_CHARS) -> str | None:
    if not isinstance(text, str):
        return None
    return text[:limit] if len(text) > limit else text


def _summarize_one_session(session: dict[str, Any]) -> dict[str, Any]:
    blocks = session.get("agentBlocks", [])
    by_state: dict[str, dict[str, Any]] = {}
    for block in blocks:
        state_id = block.get("stateId", "")
        by_state[state_id] = block

    review = by_state.get("step_review", {})
    implement = by_state.get("step_implement", {})

    impl_out = _extract_block_output(implement)
    review_out = _extract_block_output(review)

    findings = review_out.get("findings", [])
    finding_severities = [f.get("severity") for f in findings if isinstance(f, dict)]

    return {
        "session_id": session.get("sessionId"),
        "status": session.get("status"),
        "verdict": review_out.get("verdict"),
        "finding_count": len(findings),
        "finding_severities": finding_severities,
        "files_written_count": len(impl_out.get("files_written", [])),
        "deno_check_passed": impl_out.get("deno_check_passed"),
        "deno_lint_passed": impl_out.get("deno_lint_passed"),
        "reviewer_summary": _truncate(review_out.get("summary")),
    }


def _outcome_label(summary: dict[str, Any]) -> str:
    if summary.get("status") != "completed":
        return "TIMEOUT"
    verdict = summary.get("verdict")
    if verdict in ("APPROVE", "NEEDS_CHANGES", "BLOCK"):
        return verdict
    return "OTHER"


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def _aggregate_summaries(summaries: list[dict[str, Any]]) -> dict[str, Any]:
    outcome_buckets: dict[str, int] = {}
    finding_severity_counts: dict[str, int] = {}
    files_written_total = 0
    deno_check_passes = 0
    deno_lint_passes = 0
    deno_check_total = 0
    deno_lint_total = 0
    reviewer_summaries: list[str] = []

    for s in summaries:
        label = _outcome_label(s)
        outcome_buckets[label] = outcome_buckets.get(label, 0) + 1

        for sev in s.get("finding_severities", []):
            if isinstance(sev, str):
                finding_severity_counts[sev] = finding_severity_counts.get(sev, 0) + 1

        files_written_total += s.get("files_written_count", 0) or 0

        if s.get("deno_check_passed") is not None:
            deno_check_total += 1
            if s["deno_check_passed"]:
                deno_check_passes += 1
        if s.get("deno_lint_passed") is not None:
            deno_lint_total += 1
            if s["deno_lint_passed"]:
                deno_lint_passes += 1

        rs = s.get("reviewer_summary")
        if isinstance(rs, str):
            reviewer_summaries.append(rs)

    return {
        "total_scanned": len(summaries),
        "outcome_buckets": outcome_buckets,
        "finding_severity_counts": finding_severity_counts,
        "files_written_total": files_written_total,
        "deno_check_pass_rate": deno_check_passes / deno_check_total if deno_check_total else 1.0,
        "deno_lint_pass_rate": deno_lint_passes / deno_lint_total if deno_lint_total else 1.0,
        "reviewer_summaries": reviewer_summaries,
    }


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

def _build_judgment_prompt(aggregate: dict[str, Any], skill_instructions: str) -> list[dict[str, str]]:
    system = (
        "You are a cross-session reflector for the FAST self-modification loop. "
        "You receive an aggregate summary of the last N completed sessions and "
        "the current skill instructions. Your job: determine whether a RECURRING "
        "failure pattern (appearing in >=2 sessions) warrants a skill update.\n\n"
        "Rules:\n"
        "- Only flag patterns that appear across multiple sessions.\n"
        "- One-off failures should NOT trigger skill_update_warranted.\n"
        "- The publish gate requires confidence >= 0.9 — set confidence below "
        "0.9 unless you are highly certain.\n"
        "- If no recurring pattern exists, set skill_update_warranted to false, "
        "new_failure_mode to null, and confidence to 0.0.\n"
        "- Be conservative. False positives waste engineering time."
    )
    user = (
        "## Aggregate session summary\n\n"
        f"```json\n{json.dumps(aggregate, indent=2)}\n```\n\n"
        "## Current skill instructions\n\n"
        f"```\n{skill_instructions}\n```"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


# ---------------------------------------------------------------------------
# Discovery-to-task helper (same pattern as reflector/agent.py)
# ---------------------------------------------------------------------------

def _post_discovery_task(
    ctx: AgentContext,
    discovery: dict[str, Any],
) -> None:
    """POST a discovery-task to the autopilot-backlog corpus. Best-effort."""
    corpus_url = (
        ctx.config.get("backlog_corpus_url", BACKLOG_CORPUS_URL_DEFAULT)
        if ctx.config
        else BACKLOG_CORPUS_URL_DEFAULT
    )

    title_slug = discovery["title"].lower()
    for ch in " /\\:*?\"<>|":
        title_slug = title_slug.replace(ch, "-")
    title_slug = title_slug.strip("-")[:60]

    entry_id = f"auto-{discovery['kind']}-{title_slug}"
    payload = json.dumps({
        "id": entry_id,
        "text": discovery["title"],
        "createdAt": "",
        "metadata": {
            "status": "pending",
            "priority": discovery.get("priority", 50),
            "kind": discovery["kind"],
            "blocked_by": [],
            "match_job_name": "execute-task",
            "auto_apply": discovery.get("auto_apply", False),
            "discovered_by": discovery["discovered_by"],
            "discovered_session": discovery["discovered_session"],
            "payload": {
                "workspace_id": discovery["target_workspace_id"],
                "signal_id": discovery["target_signal_id"],
                "task_id": entry_id,
                "task_brief": discovery["brief"],
                "target_files": discovery.get("target_files", []),
            },
        },
    })

    try:
        ctx.http.fetch(
            corpus_url,
            method="POST",
            headers={"Content-Type": "application/json"},
            body=payload,
            timeout_ms=5000,
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Agent entry point
# ---------------------------------------------------------------------------

@agent(
    id="multi-session-reflector",
    version="1.0.0",
    description=(
        "Cross-session reflector for the FAST self-modification loop. Fetches "
        "the last N completed sessions, computes structural summaries and "
        "aggregate pass rates, then makes a single LLM call to judge whether "
        "a recurring failure pattern warrants a skill update. Companion to the "
        "single-session reflector — triggered periodically to detect trends."
    ),
    summary="Scans recent sessions for recurring failure patterns, proposes skill updates.",
    examples=[
        "Reflect on the last 10 sessions for workspace abc-123",
        "Check for recurring patterns in recent runs",
    ],
)
def execute(prompt: str, ctx: AgentContext) -> Any:
    config = ctx.config or {}
    workspace_id = config.get("workspace_id") or config.get("workspaceId")
    if not workspace_id:
        return err("workspace_id is required in agent config")

    n = int(config.get("n", 10))

    try:
        sessions = _fetch_completed_sessions(ctx, workspace_id, n)
    except RuntimeError as exc:
        return err(f"Failed to fetch sessions: {exc}")

    summaries = [_summarize_one_session(s) for s in sessions]
    aggregate = _aggregate_summaries(summaries)

    try:
        skill_data = _fetch_current_skill(ctx)
    except RuntimeError as exc:
        return err(f"Failed to fetch skill: {exc}")

    skill_instructions = skill_data.get("instructions", "")
    skill_version = skill_data.get("version", "unknown")

    messages = _build_judgment_prompt(aggregate, skill_instructions)

    try:
        resp = ctx.llm.generate_object(
            messages,
            JUDGMENT_SCHEMA,
            model=JUDGMENT_MODEL,
            max_tokens=JUDGMENT_MAX_TOKENS,
        )
    except LlmError as exc:
        return err(f"LLM judgment failed: {exc}")

    judgment = resp.object if resp.object else {}

    if judgment.get("skill_update_warranted") is True:
        new_mode = judgment.get("new_failure_mode")
        failure_label = ""
        if isinstance(new_mode, dict):
            failure_label = new_mode.get("symptom", "unknown")
        _post_discovery_task(ctx, {
            "discovered_by": "multi-session-reflector",
            "discovered_session": sessions[0].get("sessionId", "") if sessions else "",
            "target_workspace_id": workspace_id,
            "target_signal_id": "fast-self-modification-update",
            "title": f"Update @tempest/fast-self-modification: {failure_label}",
            "brief": judgment.get("rationale", ""),
            "target_files": [],
            "priority": 60,
            "kind": "reflector",
            "auto_apply": False,
        })

    return ok({
        "workspace_id": workspace_id,
        "n_sessions_scanned": len(sessions),
        "aggregate": aggregate,
        "current_skill_version": skill_version,
        "judgment": judgment,
        "summary": judgment.get("rationale", ""),
    })

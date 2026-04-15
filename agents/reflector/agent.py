"""reflector: deterministic session reader + focused LLM judgment for self-mod.

Replaces the claude-code-based reflector in grilled_xylem with a hybrid
agent: deterministic Python for the mechanical parts (fetching sessions,
parsing block structure, computing structural signals) plus a single
focused ctx.llm.generate_object call for the "is this a new pattern that
warrants a skill update" judgment.

Why this exists:
- The claude-code reflector runs opus + effort=high to do work that is
  mostly mechanical (parse session JSON, look up skill content). That
  burns tokens and wall time on operations that have a deterministic
  answer.
- A focused LLM call with structured output (generate_object + a Zod-
  validated schema) is much cheaper and more reliable than a free-form
  reasoning loop.
- This is the FAST self-modification loop's reflector, the agent
  responsible for proposing skill updates after every task. It runs
  once per task and produces structured proposals the human or the
  skill-publisher can act on.

Input shape (passed via task config):
  session_id: str | null   — session to reflect on; if null, fetch most recent

Output (reflection-result):
  {
    "outcome": "APPROVE" | "NEEDS_CHANGES" | "BLOCK" | "TIMEOUT",
    "matches_known_failure": bool,
    "known_failure_row": str | null,
    "skill_update_proposed": bool,
    "new_skill_md": str | null,         # full replacement content if proposed
    "diff_summary": str | null,
    "confidence": float | null,         # 0.0-1.0
    "current_skill_version": int | null,
    "session_summary": dict,            # structural facts about the session
    "summary": str
  }
"""

from __future__ import annotations

import json
from typing import Any

from friday_agent_sdk import AgentContext, agent, err, ok

# Re-export the WIT bridge Agent class so componentize-py finds it.
from friday_agent_sdk._bridge import Agent  # noqa: F401

from corpus_appender import CorpusAppender
from reflection_schema import ReflectionEntry


PLATFORM_URL_DEFAULT = "http://localhost:8080"
SKILL_NAMESPACE = "tempest"
SKILL_NAME = "fast-self-modification"
JUDGMENT_MODEL = "anthropic:claude-haiku-4-5"
JUDGMENT_MAX_TOKENS = 2048


# Output schema for the focused LLM judgment call. Strict shape so the
# response is mechanical, not free-form reasoning. additionalProperties:
# false on every object level — required by the LLM provider's strict
# structured-output mode.
JUDGMENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "matches_known_failure": {"type": "boolean"},
        "known_failure_row": {"type": ["string", "null"]},
        "skill_update_warranted": {"type": "boolean"},
        "new_failure_mode": {
            "type": ["object", "null"],
            "additionalProperties": False,
            "properties": {
                "symptom": {"type": "string"},
                "root_cause": {"type": "string"},
                "structural_fix": {"type": "string"},
            },
            "required": ["symptom", "root_cause", "structural_fix"],
        },
        "confidence": {"type": "number"},
        "rationale": {"type": "string"},
    },
    "required": [
        "matches_known_failure",
        "known_failure_row",
        "skill_update_warranted",
        "new_failure_mode",
        "confidence",
        "rationale",
    ],
}


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


# Job names the reflector should NOT pick when finding "latest" — these
# are reflective/meta jobs whose output isn't substantive work to learn
# from. Reflecting on a reflection produces nothing useful.
_SKIP_JOB_NAMES = frozenset({
    "reflect-on-last-run",
    "apply-reflection",
    "audit-orphans",
    "cross-session-reflect",
    "autopilot-tick",
})


def _fetch_latest_session(ctx: AgentContext, workspace_id: str) -> dict[str, Any]:
    """Find the most recent SUBSTANTIVE completed session — skips meta jobs.

    Asks for 25 sessions and walks them in order, returning the first
    completed session whose jobName is NOT in _SKIP_JOB_NAMES. Falls back
    to the first completed session if all 25 are meta.
    """
    data = _http_get_json(
        ctx, f"/api/sessions?workspaceId={workspace_id}&limit=25"
    )
    sessions = data.get("sessions", data if isinstance(data, list) else [])
    completed = [s for s in sessions if s.get("status") == "completed"]
    if not completed:
        raise RuntimeError(f"no completed sessions for workspace {workspace_id}")
    # Prefer substantive sessions (skip meta jobs)
    for s in completed:
        if s.get("jobName") not in _SKIP_JOB_NAMES:
            return _fetch_session(ctx, s["sessionId"])
    # Fallback: return the most recent completed session even if it's a meta job
    return _fetch_session(ctx, completed[0]["sessionId"])


def _fetch_current_skill(ctx: AgentContext) -> dict[str, Any]:
    return _http_get_json(
        ctx, f"/api/skills/@{SKILL_NAMESPACE}/{SKILL_NAME}"
    ).get("skill", {})


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


def _summarize_session(session: dict[str, Any]) -> dict[str, Any]:
    """Compute structural signals from a session for reflection input."""
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

    # Collect any error messages — session-level + per-block. Without these
    # the reflector is blind on hard failures and just sees "step did not
    # complete" without knowing why.
    session_error = session.get("error")
    block_errors: list[dict[str, Any]] = []
    for block in blocks:
        err = block.get("error")
        if err:
            block_errors.append({
                "stateId": block.get("stateId"),
                "status": block.get("status"),
                "error": str(err)[:400],
            })

    return {
        "session_id": session.get("sessionId"),
        "session_status": session.get("status"),
        "session_error": str(session_error)[:400] if session_error else None,
        "block_errors": block_errors,
        "workspace_id": session.get("workspaceId"),
        "task": session.get("task"),
        "step_count": len(blocks),
        "step_statuses": {
            block.get("stateId"): block.get("status") for block in blocks
        },
        "architect": {
            "completed": research.get("status") == "completed",
            "plan_citations_count": len(research_out.get("plan_citations", [])),
            "files_to_create_count": len(research_out.get("files_to_create", [])),
            "files_to_modify_count": len(research_out.get("files_to_modify", [])),
        },
        "coder": {
            "completed": implement.get("status") == "completed",
            "files_written_count": len(impl_out.get("files_written", [])),
            "deno_check_passed": impl_out.get("deno_check_passed"),
            "deno_lint_passed": impl_out.get("deno_lint_passed"),
            "summary": (impl_out.get("summary") or "")[:400],
        },
        "reviewer": {
            "completed": review.get("status") == "completed",
            "verdict": review_out.get("verdict"),
            "findings_count": len(review_out.get("findings", [])),
            "findings_severities": [
                f.get("severity") for f in review_out.get("findings", [])
            ],
            "summary": (review_out.get("summary") or "")[:400],
        },
    }


def _build_judgment_prompt(
    session_summary: dict[str, Any],
    skill_instructions: str,
) -> list[dict[str, str]]:
    """Build the LLM prompt for the focused new-pattern judgment."""
    system = (
        "You are the reflector for the FAST self-modification loop. Your "
        "job is a focused judgment call: based on the session structural "
        "summary and the current SKILL.md content, decide whether this "
        "session reveals a NEW failure mode that warrants adding a row to "
        "the skill's failure-mode table.\n\n"
        "Rules:\n"
        "1. If the session is a clean APPROVE with no findings, "
        "skill_update_warranted is almost always false.\n"
        "2. If the reviewer found drift, check whether the failure-mode "
        "table already has a matching row. If yes, set "
        "matches_known_failure=true and skill_update_warranted=false.\n"
        "3. Only set skill_update_warranted=true if you can articulate a "
        "structural fix (contract change, agent type change, FSM state "
        "change) that does not duplicate an existing rule.\n"
        "4. Confidence is your certainty in the judgment, 0.0-1.0. The "
        "publish gate threshold is 0.9, so be honest.\n"
        "5. Do not propose prompt rewrites. Propose contract or agent-type "
        "changes only.\n"
    )
    user = (
        "## Session structural summary\n"
        f"```json\n{json.dumps(session_summary, indent=2)}\n```\n\n"
        "## Current SKILL.md content\n"
        f"```markdown\n{skill_instructions}\n```\n\n"
        "Produce your judgment as JSON matching the output schema."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _outcome_from_session(session_summary: dict[str, Any]) -> str:
    """Map session structural facts to an outcome label."""
    if session_summary["session_status"] != "completed":
        return "TIMEOUT"
    verdict = session_summary["reviewer"]["verdict"]
    if verdict in ("APPROVE", "NEEDS_CHANGES", "BLOCK"):
        return verdict
    if not session_summary["reviewer"]["completed"]:
        return "TIMEOUT"
    return "APPROVE"  # session completed but no explicit verdict — assume clean


KERNEL_WORKSPACE_ID = "thick_endive"
BACKLOG_CORPUS_URL_DEFAULT = (
    "http://localhost:8080/api/memory/thick_endive/narrative/autopilot-backlog"
)


def _append_to_corpus(
    *,
    ctx: AgentContext,
    session_summary: dict[str, Any],
    outcome: str,
    rationale: str,
    update_warranted: bool,
) -> None:
    """Append a reflection entry to the thick_endive reflections corpus.

    Non-blocking: failures are logged but never raise.
    """
    finding_type = "SKILL_GAP" if update_warranted else "INFO"
    severity = "MEDIUM" if update_warranted else "LOW"
    proposed_action = rationale if update_warranted else "none"

    session_id = session_summary.get("session_id", "")
    workspace_id = session_summary.get("workspace_id", "")

    try:
        entry = ReflectionEntry(
            text=f"{outcome}: {rationale}" if rationale else outcome,
            target_workspace_id=workspace_id,
            target_session_id=session_id,
            finding_type=finding_type,
            severity=severity,
            proposed_action=proposed_action,
            session_id=session_id,
            run_id=session_id,
            step_index=0,
        )
        appender = CorpusAppender(
            platform_url=_platform_url(ctx),
            http=ctx.http,
        )
        appender.append_reflection(
            workspace_id=KERNEL_WORKSPACE_ID,
            entry=entry,
        )
    except Exception:
        pass


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


@agent(
    id="reflector",
    version="1.3.0",
    description=(
        "Deterministic session reader + focused LLM judgment for the FAST "
        "self-modification loop. Reads a completed session via daemon HTTP, "
        "computes structural signals, asks claude-haiku for a single new-"
        "pattern judgment, and emits a reflection-result. Cheap and fast "
        "compared to the prior claude-code reflector."
    ),
    summary="Reads sessions, judges new failure patterns, proposes skill updates.",
    examples=[
        "Reflect on session abc-123",
        "Reflect on the latest grilled_xylem run",
    ],
)
def execute(prompt: str, ctx: AgentContext) -> Any:
    config = ctx.config or {}
    session_id = config.get("session_id")
    workspace_id = config.get("workspace_id", "grilled_xylem")

    ctx.stream.progress("fetching session")
    try:
        if session_id:
            session = _fetch_session(ctx, session_id)
        else:
            session = _fetch_latest_session(ctx, workspace_id)
    except Exception as exc:
        return err(f"fetch session failed: {exc}")

    session_summary = _summarize_session(session)
    outcome = _outcome_from_session(session_summary)

    ctx.stream.progress("fetching current skill content")
    try:
        skill = _fetch_current_skill(ctx)
    except Exception as exc:
        return err(f"fetch skill failed: {exc}")
    skill_instructions = skill.get("instructions", "")
    current_skill_version = skill.get("version")

    ctx.stream.progress("asking llm for new-pattern judgment")
    try:
        llm_response = ctx.llm.generate_object(
            messages=_build_judgment_prompt(session_summary, skill_instructions),
            schema=JUDGMENT_SCHEMA,
            model=JUDGMENT_MODEL,
            max_tokens=JUDGMENT_MAX_TOKENS,
        )
    except Exception as exc:
        return err(f"llm judgment failed: {exc}")

    judgment = llm_response.object or {}
    matches_known = bool(judgment.get("matches_known_failure", False))
    known_row = judgment.get("known_failure_row")
    update_warranted = bool(judgment.get("skill_update_warranted", False))
    confidence = float(judgment.get("confidence", 0.0))
    rationale = str(judgment.get("rationale", ""))
    new_failure_mode = judgment.get("new_failure_mode")

    ctx.stream.progress("appending reflection to corpus")
    _append_to_corpus(
        ctx=ctx,
        session_summary=session_summary,
        outcome=outcome,
        rationale=rationale,
        update_warranted=update_warranted,
    )

    if update_warranted and confidence >= 0.9:
        failure_label = ""
        if isinstance(new_failure_mode, dict):
            failure_label = new_failure_mode.get("symptom", "unknown")
        _post_discovery_task(ctx, {
            "discovered_by": "reflector",
            "discovered_session": session_summary.get("session_id", ""),
            "target_workspace_id": session_summary.get("workspace_id", ""),
            "target_signal_id": "fast-self-modification-update",
            "title": f"Update @tempest/fast-self-modification: {failure_label}",
            "brief": rationale,
            "target_files": [],
            "priority": 60,
            "kind": "reflector",
            "auto_apply": False,
        })

    return ok(
        {
            "outcome": outcome,
            "matches_known_failure": matches_known,
            "known_failure_row": known_row,
            "skill_update_proposed": update_warranted,
            "new_failure_mode": new_failure_mode,
            "confidence": confidence,
            "current_skill_version": current_skill_version,
            "session_summary": session_summary,
            "rationale": rationale,
            "summary": (
                f"{outcome} session {session_summary['session_id'][:8]}: "
                f"{'new pattern detected' if update_warranted else 'no update'} "
                f"(confidence {confidence:.2f})"
            ),
        }
    )

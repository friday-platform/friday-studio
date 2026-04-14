"""skill-author: produces replacement SKILL.md from reflector proposals.

Closes the FAST self-modification loop gap between the reflector (which
judges whether a new failure mode exists and proposes it) and the
skill-publisher (which applies the update via the daemon API).

Pipeline position:
  reflector -> skill-author -> skill-publisher

Input shape (passed via task config):
  reflection_result: dict  -- full ok-payload from the reflector agent
  current_skill_md: str    -- current SKILL.md content (fetched by FSM orchestrator)

Output (authoring-result):
  {
    "proposed_skill_md": str | None,
    "change_summary": str | None,
    "current_skill_version": int | None,
    "confidence_at_authoring": float,
    "target_skill_namespace": "tempest",
    "target_skill_name": "fast-self-modification",
    "skipped": bool,
    "reason": str | None,
  }
"""

from __future__ import annotations

import json
from typing import Any

from friday_agent_sdk import AgentContext, agent, err, ok

# Re-export the WIT bridge Agent class so componentize-py finds it.
from friday_agent_sdk._bridge import Agent  # noqa: F401


AUTHORING_MODEL = "anthropic:claude-haiku-4-5"
AUTHORING_MAX_TOKENS = 8192
PUBLISH_CONFIDENCE_GATE = 0.9

SKILL_NAMESPACE = "tempest"
SKILL_NAME = "fast-self-modification"

# Minimum ratio of output length to input length. If the LLM produces a
# SKILL.md shorter than 80% of the original, it likely dropped content
# rather than appending.
MIN_LENGTH_RATIO = 0.8

# Output schema for ctx.llm.generate_object. Strict shape with
# additionalProperties: false on every object level.
AUTHORING_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "skill_md": {"type": "string"},
        "change_summary": {"type": "string"},
    },
    "required": ["skill_md", "change_summary"],
}

REQUIRED_FAILURE_MODE_KEYS = ("symptom", "root_cause", "structural_fix")


def _validate_failure_mode(fm: Any) -> str | None:
    """Check that new_failure_mode is a dict with required keys.

    Returns an error string if invalid, None if valid.
    """
    if not isinstance(fm, dict):
        return f"new_failure_mode must be a dict, got {type(fm).__name__}"
    missing = [k for k in REQUIRED_FAILURE_MODE_KEYS if k not in fm]
    if missing:
        return f"new_failure_mode missing required keys: {', '.join(missing)}"
    for key in REQUIRED_FAILURE_MODE_KEYS:
        if not isinstance(fm[key], str) or not fm[key].strip():
            return f"new_failure_mode.{key} must be a non-empty string"
    return None


def _build_authoring_prompt(
    current_skill_md: str,
    new_failure_mode: dict,
) -> list[dict[str, str]]:
    """Build the LLM prompt for SKILL.md authoring.

    Returns [system message, user message] following the same pattern as
    reflector's _build_judgment_prompt.
    """
    system = (
        "You are the skill-author for the FAST self-modification loop. "
        "Your job is to produce a complete replacement SKILL.md with a "
        "new failure-mode row appended to the failure-mode table.\n\n"
        "Rules:\n"
        "1. Preserve the ENTIRE existing SKILL.md structure, wording, and "
        "formatting exactly. Do not rewrite, rephrase, or reorganize "
        "existing content.\n"
        "2. Append exactly ONE new row to the failure-mode table "
        "(the markdown table under '## Failure-mode -> structural-fix "
        "mapping'). The row must contain the symptom, root cause, and "
        "structural fix from the provided new_failure_mode.\n"
        "3. Output the FULL SKILL.md content including ALL existing rows "
        "and the new row. Do not truncate or summarize.\n"
        "4. The new row's columns are: Symptom | Root cause | Structural "
        "fix — matching the existing table format.\n"
        "5. Do not add commentary, explanations, or markdown code fences "
        "around the output. Return the raw SKILL.md content.\n"
        "6. If the existing table has a trailing blank line or section "
        "after it, preserve that structure.\n"
    )
    user = (
        "## Current SKILL.md content\n\n"
        f"{current_skill_md}\n\n"
        "## New failure mode to append\n\n"
        f"```json\n{json.dumps(new_failure_mode, indent=2)}\n```\n\n"
        "Produce the complete updated SKILL.md with the new row appended "
        "to the failure-mode table. Also provide a one-line change_summary "
        "describing what was added."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


@agent(
    id="skill-author",
    version="1.0.0",
    description=(
        "Produces a complete replacement SKILL.md by appending new "
        "failure-mode rows from reflector proposals. Bridges the gap "
        "between the reflector (which judges) and the skill-publisher "
        "(which applies). Single focused LLM call with structured output."
    ),
    summary="Produces replacement SKILL.md with new failure-mode rows from reflector proposals.",
    examples=[
        "Author a skill update from reflection result",
        "Add a failure-mode row to SKILL.md",
    ],
)
def execute(prompt: str, ctx: AgentContext) -> Any:
    config = ctx.config or {}

    # --- Extract inputs from config ---
    reflection_result = config.get("reflection_result")
    current_skill_md = config.get("current_skill_md")

    if not reflection_result or not isinstance(reflection_result, dict):
        return err("missing or invalid reflection_result in config")
    if not current_skill_md or not isinstance(current_skill_md, str):
        return err("missing or invalid current_skill_md in config")

    # --- Confidence gate ---
    confidence = float(reflection_result.get("confidence", 0.0))
    if confidence < PUBLISH_CONFIDENCE_GATE:
        return ok({
            "proposed_skill_md": None,
            "change_summary": None,
            "current_skill_version": reflection_result.get("current_skill_version"),
            "confidence_at_authoring": confidence,
            "target_skill_namespace": SKILL_NAMESPACE,
            "target_skill_name": SKILL_NAME,
            "skipped": True,
            "reason": f"confidence {confidence:.2f} below gate {PUBLISH_CONFIDENCE_GATE}",
        })

    # --- Validate new_failure_mode ---
    new_failure_mode = reflection_result.get("new_failure_mode")
    validation_err = _validate_failure_mode(new_failure_mode)
    if validation_err:
        return err(f"invalid new_failure_mode: {validation_err}")

    # --- Build prompt and call LLM ---
    ctx.stream.progress("authoring skill update")
    messages = _build_authoring_prompt(current_skill_md, new_failure_mode)

    try:
        llm_response = ctx.llm.generate_object(
            messages=messages,
            schema=AUTHORING_SCHEMA,
            model=AUTHORING_MODEL,
            max_tokens=AUTHORING_MAX_TOKENS,
        )
    except Exception as exc:
        return err(f"llm authoring call failed: {exc}")

    result = llm_response.object or {}
    proposed_skill_md = result.get("skill_md", "")
    change_summary = result.get("change_summary", "")

    # --- Validate LLM response ---
    if not proposed_skill_md:
        return err("llm returned empty skill_md")

    if len(proposed_skill_md) < len(current_skill_md) * MIN_LENGTH_RATIO:
        return err(
            f"llm output too short: {len(proposed_skill_md)} chars vs "
            f"{len(current_skill_md)} input chars "
            f"(ratio {len(proposed_skill_md) / len(current_skill_md):.2f}, "
            f"minimum {MIN_LENGTH_RATIO})"
        )

    symptom = new_failure_mode["symptom"]
    if symptom not in proposed_skill_md:
        return err(
            f"proposed skill_md does not contain the new symptom string: "
            f"'{symptom[:80]}'"
        )

    return ok({
        "proposed_skill_md": proposed_skill_md,
        "change_summary": change_summary,
        "current_skill_version": reflection_result.get("current_skill_version"),
        "confidence_at_authoring": confidence,
        "target_skill_namespace": SKILL_NAMESPACE,
        "target_skill_name": SKILL_NAME,
        "skipped": False,
        "reason": None,
    })

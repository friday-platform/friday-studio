"""Reflection aggregator — deterministic trend summary over N reflection results.

No LLM call, no HTTP. Pure-Python aggregation of reflection-result objects
produced by the reflector agent.
"""

from friday_agent_sdk import agent, err, ok
from friday_agent_sdk._bridge import Agent  # noqa: F401 — componentize-py needs this


@agent(
    id="reflection-aggregator",
    version="1.0.0",
    description=(
        "Aggregates N reflection-result dicts into a deterministic trend summary. "
        "Pure-Python, no LLM call, no HTTP. Input via ctx.config['reflections']."
    ),
)
def execute(prompt, ctx):
    cfg = ctx.config
    reflections = cfg.get("reflections")

    if not isinstance(reflections, list):
        return err("reflections must be a list")

    if not reflections:
        return ok({
            "total_count": 0,
            "outcome_buckets": {"PROGRESSED": 0, "STUCK": 0, "REGRESSED": 0, "OTHER": 0},
            "known_failure_recurrence_count": 0,
            "top_failure_pattern": None,
            "avg_confidence": None,
            "proposes_new_skill_count": 0,
        })

    outcome_buckets = {"PROGRESSED": 0, "STUCK": 0, "REGRESSED": 0, "OTHER": 0}
    known_failure_counts = {}
    confidence_values = []
    proposes_new_skill_count = 0

    for item in reflections:
        if not isinstance(item, dict):
            ctx.stream.progress(f"skipping non-dict item: {type(item).__name__}")
            continue

        outcome = item.get("outcome", "OTHER")
        if outcome in outcome_buckets:
            outcome_buckets[outcome] += 1
        else:
            outcome_buckets["OTHER"] += 1

        matches_known = item.get("matches_known_failure")
        if matches_known is not None:
            known_failure_counts[matches_known] = known_failure_counts.get(matches_known, 0) + 1

        confidence = item.get("confidence")
        if isinstance(confidence, (int, float)):
            confidence_values.append(float(confidence))

        if item.get("proposes_skill_update"):
            proposes_new_skill_count += 1

    known_failure_recurrence_count = sum(known_failure_counts.values())

    top_failure_pattern = None
    if known_failure_counts:
        top_failure_pattern = max(known_failure_counts, key=known_failure_counts.get)

    avg_confidence = None
    if confidence_values:
        avg_confidence = sum(confidence_values) / len(confidence_values)

    return ok({
        "total_count": len(reflections),
        "outcome_buckets": outcome_buckets,
        "known_failure_recurrence_count": known_failure_recurrence_count,
        "top_failure_pattern": top_failure_pattern,
        "avg_confidence": avg_confidence,
        "proposes_new_skill_count": proposes_new_skill_count,
    })

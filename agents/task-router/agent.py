"""Task router — deterministic quick-fix vs full-fsm routing.

componentize-py compiles this module. It must:
1. Register the handler via @agent decorator (side-effect import)
2. Export the Agent class that componentize-py expects
"""

from friday_agent_sdk import agent, err, ok
from friday_agent_sdk._bridge import Agent  # noqa: F401 — componentize-py needs this

QUICK_FIX_KEYWORDS = frozenset({"fix", "remove", "rename", "rewrite", "undo"})
MAX_BRIEF_LEN = 800


@agent(
    id="task-router",
    version="1.0.0",
    description=(
        "Routes a self-mod task brief to 'quick-fix' (coder + reviewer only, "
        "single file) or 'full-fsm' (architect + coder + reviewer). "
        "Deterministic — no LLM call. Implements parity plan open question #19."
    ),
)
def execute(prompt, ctx):
    cfg = ctx.config

    task_brief = cfg.get("task_brief", "")
    target_files = cfg.get("target_files", [])

    if not task_brief:
        return err("task_brief is required")
    if not isinstance(target_files, list):
        return err("target_files must be a list")

    brief_lower = task_brief.lower()
    is_single_file = len(target_files) == 1
    has_quick_keyword = any(kw in brief_lower for kw in QUICK_FIX_KEYWORDS)
    is_short_brief = len(task_brief) < MAX_BRIEF_LEN

    if is_single_file and has_quick_keyword and is_short_brief:
        matched_kw = next(kw for kw in QUICK_FIX_KEYWORDS if kw in brief_lower)
        return ok({
            "route": "quick-fix",
            "rationale": (
                f"Single target file, brief contains '{matched_kw}', "
                f"and brief is {len(task_brief)} chars (< {MAX_BRIEF_LEN}). "
                "Skipping architect — running coder + reviewer only."
            ),
            "estimated_files_changed": 1,
        })

    reasons = []
    if not is_single_file:
        reasons.append(f"{len(target_files)} target files (needs exactly 1)")
    if not has_quick_keyword:
        reasons.append(f"brief contains none of {sorted(QUICK_FIX_KEYWORDS)}")
    if not is_short_brief:
        reasons.append(f"brief is {len(task_brief)} chars (>= {MAX_BRIEF_LEN})")

    return ok({
        "route": "full-fsm",
        "rationale": "Full FSM required: " + "; ".join(reasons) + ".",
        "estimated_files_changed": max(len(target_files), 1),
    })

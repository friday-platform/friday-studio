"""Orphan agent auditor — finds user agents not wired into any workspace."""

from __future__ import annotations

import json
from typing import Any

from friday_agent_sdk import AgentContext, agent, err, ok

# Re-export the WIT bridge Agent class so componentize-py finds it.
# The build pipeline expects the user `agent` module to export Agent at
# module level; the @agent decorator below registers the handler, and
# the bridge's Agent class delegates to it via the registry.
from friday_agent_sdk._bridge import Agent  # noqa: F401


PLATFORM_URL_DEFAULT = "http://localhost:8080"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _platform_url(ctx: AgentContext) -> str:
    return ctx.config.get("platformUrl", PLATFORM_URL_DEFAULT) if ctx.config else PLATFORM_URL_DEFAULT


def _http_get_json(ctx: AgentContext, path: str) -> Any:
    url = f"{_platform_url(ctx)}{path}"
    resp = ctx.http.fetch(url, method="GET", timeout_ms=10000)
    if resp.status != 200:
        raise RuntimeError(f"GET {path} \u2192 HTTP {resp.status}")
    return resp.json()


def _identify_user_agents(
    agents: list[dict[str, Any]],
    config: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Identify user agents via priority chain.

    1. Explicit user_agent_ids from config
    2. 'category' field on agent entries (future-proof, not yet returned by API)
    3. Exclude known non-user IDs via exclude_ids config
    4. Fallback: treat all agents as user agents
    """
    cfg = config or {}
    explicit_ids: list[str] | None = cfg.get("user_agent_ids")
    exclude_ids: list[str] = cfg.get("exclude_ids", [])

    # Strategy 1: explicit list
    if explicit_ids is not None:
        id_set = set(explicit_ids)
        return [a for a in agents if a.get("id") in id_set]

    # Strategy 2: category field (future-proof)
    has_category = any("category" in a for a in agents)
    if has_category:
        # 'yaml' and 'sdk' map to user-built agents
        user_categories = {"yaml", "sdk"}
        return [a for a in agents if a.get("category") in user_categories]

    # Strategy 3: exclude known non-user IDs
    if exclude_ids:
        excl = set(exclude_ids)
        return [a for a in agents if a.get("id") not in excl]

    # Strategy 4: treat all as user agents
    return list(agents)


def _scan_agent_references(ws_config: dict[str, Any]) -> set[str]:
    """Scan workspace config.agents for type=='user' references."""
    refs: set[str] = set()
    agents_section = ws_config.get("agents", {})
    if not isinstance(agents_section, dict):
        return refs
    for _key, entry in agents_section.items():
        if isinstance(entry, dict) and entry.get("type") == "user":
            agent_id = entry.get("agent")
            if agent_id:
                refs.add(agent_id)
    return refs


def _scan_fsm_references(ws_config: dict[str, Any]) -> set[str]:
    """Scan workspace config.jobs.*.fsm states for agent references."""
    refs: set[str] = set()
    jobs_section = ws_config.get("jobs", {})
    if not isinstance(jobs_section, dict):
        return refs
    for _job_key, job in jobs_section.items():
        if not isinstance(job, dict):
            continue
        fsm = job.get("fsm", {})
        if not isinstance(fsm, dict):
            continue
        for _state_key, state in fsm.items():
            if not isinstance(state, dict):
                continue
            agent_id = state.get("agent")
            if isinstance(agent_id, str) and agent_id:
                refs.add(agent_id)
    return refs


# ---------------------------------------------------------------------------
# Agent handler
# ---------------------------------------------------------------------------

@agent(
    id="orphan-agent-auditor",
    version="1.2.0",
    description=(
        "Cross-artifact integration auditor. Pure HTTP, no LLM. "
        "Fetches all registered agents and workspace configs, then "
        "identifies user agents not referenced by any workspace "
        "(orphans)."
    ),
    summary="Finds orphan user agents not wired into any workspace.",
    examples=[
        "Audit for orphan agents across all workspaces",
        "List user agents with no workspace consumer",
        "Check which agents are unreferenced",
    ],
)
def execute(prompt: str, ctx: AgentContext) -> Any:
    config = ctx.config or {}

    # 1. Fetch all registered agents.
    ctx.stream.progress("fetching registered agents")
    agents_resp = _http_get_json(ctx, "/api/agents?limit=500")
    if isinstance(agents_resp, list):
        all_agents: list[dict[str, Any]] = agents_resp
    else:
        all_agents = agents_resp.get("agents", [])

    # 2. Identify user agents via priority chain
    user_agents = _identify_user_agents(all_agents, config)
    user_agent_map: dict[str, dict[str, Any]] = {
        a["id"]: a for a in user_agents if "id" in a
    }
    ctx.stream.progress(f"identified {len(user_agent_map)} user agent(s)")

    # 3. Fetch all workspace IDs.
    ctx.stream.progress("fetching workspace configs")
    ws_resp = _http_get_json(ctx, "/api/workspaces")
    if isinstance(ws_resp, list):
        workspaces: list[dict[str, Any]] = ws_resp
    else:
        workspaces = ws_resp.get("workspaces", [])

    # 4-5. For each workspace, scan config.agents and config.jobs.*.fsm
    ctx.stream.progress(f"scanning {len(workspaces)} workspace(s) for agent references")
    referenced: dict[str, list[str]] = {}  # agent_id -> [workspace_ids]
    for ws in workspaces:
        ws_id = ws.get("id")
        if not ws_id:
            continue
        try:
            ws_detail = _http_get_json(ctx, f"/api/workspaces/{ws_id}")
        except RuntimeError:
            continue
        ws_config = ws_detail.get("config", ws_detail)
        refs = _scan_agent_references(ws_config) | _scan_fsm_references(ws_config)
        for ref_id in refs:
            if ref_id in user_agent_map:
                referenced.setdefault(ref_id, []).append(ws_id)

    # 6. Compute orphans, excluding library agents (called from inside other
    # agents, not from FSMs directly — they legitimately have no consumer FSM
    # reference and shouldn't be flagged as orphans).
    library_agent_ids: set[str] = set(config.get("library_agents", []) or [])

    ctx.stream.progress("computing orphan results")
    referenced_ids = set(referenced.keys())
    raw_orphan_ids = set(user_agent_map.keys()) - referenced_ids
    orphan_ids = raw_orphan_ids - library_agent_ids
    library_orphans = sorted(raw_orphan_ids & library_agent_ids)

    orphans = [
        {"agent_id": aid, "version": user_agent_map[aid].get("version", "unknown")}
        for aid in sorted(orphan_ids)
    ]
    referenced_list = [
        {"agent_id": aid, "workspaces": wss}
        for aid, wss in sorted(referenced.items())
    ]

    total = len(user_agent_map)
    ref_count = len(referenced_ids)

    rationale_parts = [
        f"Scanned {len(workspaces)} workspace(s) and found {total} user agent(s).",
        f"{ref_count} are referenced in at least one workspace config;",
        f"{len(orphans)} are orphans.",
    ]
    if library_orphans:
        rationale_parts.append(
            f"Excluded {len(library_orphans)} library agent(s) from orphan count: "
            + ", ".join(library_orphans)
        )

    return ok({
        "total_user_agents": total,
        "referenced_count": ref_count,
        "orphan_count": len(orphans),
        "orphans": orphans,
        "referenced": referenced_list,
        "library_orphans_excluded": library_orphans,
        "rationale": " ".join(rationale_parts),
    })

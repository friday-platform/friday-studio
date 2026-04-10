"""WIT bridge shim — componentize-py discovers Agent class here.

Users never import this module. The build step (atlas agent build) wires
the user's module import and runs componentize-py against this file.
"""

import dataclasses
import json
from dataclasses import dataclass

from friday_agent_sdk._context import build_context
from friday_agent_sdk._registry import get_registered_agent
from friday_agent_sdk._result import AgentExtras, ErrResult, OkResult
from friday_agent_sdk._serialize import serialize_data

try:
    from wit_world.imports.types import AgentResult_Err, AgentResult_Ok

    def _ok_result(value: str) -> AgentResult_Ok:
        return AgentResult_Ok(value=value)

    def _err_result(value: str) -> AgentResult_Err:
        return AgentResult_Err(value=value)
except ImportError:
    # Native Python (tests, dev) — no WIT bindings available.
    # Use a simple tagged type that mirrors the WIT variant.
    @dataclass
    class _AgentResult:
        tag: str
        value: str

    def _ok_result(value: str) -> _AgentResult:
        return _AgentResult(tag="ok", value=value)

    def _err_result(value: str) -> _AgentResult:
        return _AgentResult(tag="err", value=value)


def _to_camel(name: str) -> str:
    """Convert snake_case to camelCase."""
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _serialize_dataclass_camel(obj: object) -> dict:
    """Serialize a dataclass to a camelCase dict, omitting None values."""
    result = {}
    for field in dataclasses.fields(obj):
        value = getattr(obj, field.name)
        if value is not None:
            result[_to_camel(field.name)] = value
    return result


def _serialize_extras(extras: AgentExtras) -> dict:
    """Serialize AgentExtras to camelCase dict matching TS SDK format."""
    result = {}
    if extras.reasoning is not None:
        result["reasoning"] = extras.reasoning
    if extras.artifact_refs is not None:
        result["artifactRefs"] = [
            _serialize_dataclass_camel(ref) for ref in extras.artifact_refs
        ]
    if extras.outline_refs is not None:
        result["outlineRefs"] = [
            _serialize_dataclass_camel(ref) for ref in extras.outline_refs
        ]
    return result


class Agent:
    """WIT interface implementation. Delegates to the registered handler."""

    def get_metadata(self) -> str:
        """Returns JSON blob matching CreateAgentConfig shape."""
        reg = get_registered_agent()
        meta: dict = {
            "id": reg.id,
            "version": reg.version,
            "description": reg.description,
        }
        if reg.display_name:
            meta["displayName"] = reg.display_name
        if reg.summary:
            meta["summary"] = reg.summary
        if reg.constraints:
            meta["constraints"] = reg.constraints
        meta["expertise"] = {"examples": reg.examples or []}
        if reg.input_json_schema:
            meta["inputSchema"] = reg.input_json_schema
        if reg.output_json_schema:
            meta["outputSchema"] = reg.output_json_schema
        if reg.environment:
            meta["environment"] = reg.environment
        if reg.mcp:
            meta["mcp"] = reg.mcp
        if reg.llm:
            meta["llm"] = reg.llm
        if reg.use_workspace_skills:
            meta["useWorkspaceSkills"] = True
        return json.dumps(meta)

    def execute(self, prompt: str, context: str):
        """Execute the registered agent handler."""
        reg = get_registered_agent()
        ctx = build_context(json.loads(context))

        try:
            result = reg.handler(prompt, ctx)

            if isinstance(result, OkResult):
                payload: dict = {"data": serialize_data(result.data)}
                if result.extras:
                    payload.update(_serialize_extras(result.extras))
                return _ok_result(json.dumps(payload))
            elif isinstance(result, ErrResult):
                return _err_result(result.error)
            else:
                return _err_result(
                    f"Handler returned {type(result).__name__}, "
                    "expected OkResult or ErrResult"
                )
        except Exception as e:
            return _err_result(str(e))

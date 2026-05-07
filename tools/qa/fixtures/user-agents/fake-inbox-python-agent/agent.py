import json
from typing import Any

from friday_agent_sdk import AgentContext, ToolCallError, agent, err, ok, run


def _mcp_text(result: Any) -> str:
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list):
            return "\n".join(
                item.get("text", "")
                for item in content
                if isinstance(item, dict) and item.get("type") == "text"
            )
        return json.dumps(result)
    return str(result)


@agent(
    id="fake-inbox-python-agent",
    version="0.1.0",
    description="Fetches synthetic inbox messages through ctx.tools for first-principles QA.",
)
def execute(prompt: str, ctx: AgentContext):
    try:
        tool_names = [tool.name for tool in ctx.tools.list()]
        if "request_human_input" in prompt:
            ctx.stream.progress("Requesting user decision", tool_name="request_human_input")
            decision = ctx.tools.call("request_human_input", {
                "question": "Choose the fake inbox action for first-principles QA",
                "options": [
                    {"label": "Archive", "value": "archive"},
                    {"label": "Keep", "value": "keep"},
                ],
            })
            parsed = json.loads(_mcp_text(decision))
            return ok({
                "marker": "PY_USER_AGENT_HUMAN_INPUT_RESUMED",
                "listedTools": tool_names,
                "status": parsed.get("status"),
                "answer": parsed.get("answer", ""),
                "elicitationId": parsed.get("elicitationId"),
            })

        ctx.stream.progress("Searching fake inbox", tool_name="search_messages")
        search_result = ctx.tools.call("search_messages", {"query": "from:newsletter@example.test", "limit": 4})
        ids = json.loads(_mcp_text(search_result)).get("ids", [])
        ctx.stream.progress(f"Fetching {len(ids)} fake inbox messages", tool_name="get_messages_content_batch")
        batch_result = ctx.tools.call("get_messages_content_batch", {"ids": ids})
        messages = json.loads(_mcp_text(batch_result)).get("messages", [])
    except (ToolCallError, json.JSONDecodeError, TypeError) as exc:
        return err(f"fake inbox Python agent failed: {exc}")

    return ok(
        {
            "marker": "PY_USER_AGENT_TOOL_OK",
            "listedTools": tool_names,
            "count": len(messages),
            "firstId": messages[0].get("id") if messages else None,
            "sawBodySentinel": any(
                "FIRST_PRINCIPLES_EMAIL_BODY" in str(message.get("body", ""))
                for message in messages
                if isinstance(message, dict)
            ),
        }
    )


if __name__ == "__main__":
    run()

"""Build AgentContext from the raw JSON dict passed by the host via NATS."""

import asyncio
import json

from friday_agent_sdk._types import (
    AgentContext,
    Http,
    HttpError,
    HttpResponse,
    Llm,
    LlmError,
    LlmResponse,
    SessionData,
    StreamEmitter,
    ToolCallError,
    ToolDefinition,
    Tools,
)


def _nats_call(coro, loop: asyncio.AbstractEventLoop, timeout: float) -> str:
    """Run a NATS coroutine from a sync context (thread pool worker).

    Uses run_coroutine_threadsafe so the main event loop services the
    request while this thread blocks on .result().
    """
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=timeout)


def build_context(
    raw: dict,
    nc,
    session_id: str,
    loop: asyncio.AbstractEventLoop,
) -> AgentContext:
    """Construct an AgentContext backed by NATS capability subjects."""

    async def _llm_request(request_json: str) -> str:
        resp = await nc.request(
            f"caps.{session_id}.llm.generate",
            request_json.encode(),
            timeout=120,
        )
        data = json.loads(resp.data.decode())
        if "error" in data:
            raise LlmError(data["error"])
        return resp.data.decode()

    async def _http_request(request_json: str) -> str:
        resp = await nc.request(
            f"caps.{session_id}.http.fetch",
            request_json.encode(),
            timeout=60,
        )
        data = json.loads(resp.data.decode())
        if "error" in data:
            raise HttpError(data["error"])
        return resp.data.decode()

    async def _tools_call(name: str, args_json: str) -> str:
        payload = json.dumps({"name": name, "args": json.loads(args_json)})
        resp = await nc.request(
            f"caps.{session_id}.tools.call",
            payload.encode(),
            timeout=60,
        )
        data = json.loads(resp.data.decode())
        if "error" in data:
            raise ToolCallError(data["error"])
        return resp.data.decode()

    async def _tools_list() -> list:
        resp = await nc.request(
            f"caps.{session_id}.tools.list",
            b"{}",
            timeout=10,
        )
        data = json.loads(resp.data.decode())
        if "error" in data:
            return []
        return [
            type("ToolEntry", (), {
                "name": t["name"],
                "description": t.get("description", ""),
                "input_schema": json.dumps(t.get("inputSchema", {})),
            })()
            for t in data.get("tools", [])
        ]

    async def _stream_publish(event_type: str, payload: str) -> None:
        chunk = json.dumps({"type": event_type, "data": json.loads(payload) if payload.startswith(("{", "[")) else payload})
        await nc.publish(f"sessions.{session_id}.events", chunk.encode())

    def llm_generate_sync(request_json: str) -> str:
        return _nats_call(_llm_request(request_json), loop, timeout=130)

    def http_fetch_sync(request_json: str) -> str:
        return _nats_call(_http_request(request_json), loop, timeout=70)

    def tools_call_sync(name: str, args_json: str) -> str:
        return _nats_call(_tools_call(name, args_json), loop, timeout=70)

    def tools_list_sync() -> list:
        return _nats_call(_tools_list(), loop, timeout=15)

    def stream_emit_sync(event_type: str, payload: str) -> None:
        asyncio.run_coroutine_threadsafe(_stream_publish(event_type, payload), loop)
        # fire-and-forget: don't block on result

    session_raw = raw.get("session")
    session = None
    if session_raw is not None:
        session = SessionData(
            id=session_raw["id"],
            workspace_id=session_raw["workspace_id"],
            user_id=session_raw["user_id"],
            datetime=session_raw["datetime"],
        )

    agent_llm_config = raw.get("llm_config")

    return AgentContext(
        env=raw.get("env", {}),
        config=raw.get("config", {}),
        session=session,
        output_schema=raw.get("output_schema"),
        tools=Tools(call_tool=tools_call_sync, list_tools=tools_list_sync),
        llm=Llm(llm_generate=llm_generate_sync, agent_llm_config=agent_llm_config),
        http=Http(http_fetch=http_fetch_sync),
        stream=StreamEmitter(stream_emit=stream_emit_sync),
    )

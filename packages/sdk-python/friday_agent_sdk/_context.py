"""Build AgentContext from the raw JSON dict passed by the host."""

from friday_agent_sdk._types import (
    AgentContext,
    Http,
    Llm,
    SessionData,
    StreamEmitter,
    Tools,
)

try:
    from wit_world.imports import capabilities as _wit_caps
except ImportError:
    _wit_caps = None


def _build_tools() -> Tools | None:
    if _wit_caps is None or not hasattr(_wit_caps, "call_tool"):
        return None
    return Tools(call_tool=_wit_caps.call_tool, list_tools=_wit_caps.list_tools)


def _build_llm(agent_llm_config: dict | None) -> Llm | None:
    if _wit_caps is None or not hasattr(_wit_caps, "llm_generate"):
        return None
    return Llm(
        llm_generate=_wit_caps.llm_generate,
        agent_llm_config=agent_llm_config,
    )


def _build_http() -> Http | None:
    if _wit_caps is None or not hasattr(_wit_caps, "http_fetch"):
        return None
    return Http(http_fetch=_wit_caps.http_fetch)


def _build_stream() -> StreamEmitter | None:
    if _wit_caps is None or not hasattr(_wit_caps, "stream_emit"):
        return None
    return StreamEmitter(stream_emit=_wit_caps.stream_emit)


def build_context(raw: dict) -> AgentContext:
    """Construct an AgentContext from parsed JSON execution context."""
    session_raw = raw.get("session")
    session = None
    if session_raw is not None:
        session = SessionData(
            id=session_raw["id"],
            workspace_id=session_raw["workspace_id"],
            user_id=session_raw["user_id"],
            datetime=session_raw["datetime"],
        )

    # Agent LLM config comes from metadata (set at build time via decorator),
    # passed through to execution context by the host.
    agent_llm_config = raw.get("llm_config")

    return AgentContext(
        env=raw.get("env", {}),
        config=raw.get("config", {}),
        session=session,
        output_schema=raw.get("output_schema"),
        tools=_build_tools(),
        llm=_build_llm(agent_llm_config),
        http=_build_http(),
        stream=_build_stream(),
    )

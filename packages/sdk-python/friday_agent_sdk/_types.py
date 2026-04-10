"""Context and data types for agent execution."""

import json
from dataclasses import dataclass, field
from typing import Any, Callable


class ToolCallError(Exception):
    """Raised when a host tool call fails."""

    pass


class LlmError(Exception):
    """Raised when a host LLM call fails."""

    pass


class HttpError(Exception):
    """Raised when a host HTTP call fails."""

    pass


@dataclass
class ToolDefinition:
    """A tool available to the agent via MCP."""

    name: str
    description: str
    input_schema: dict


class Tools:
    """Wrapper around WIT capabilities for tool invocation."""

    def __init__(
        self,
        call_tool: Callable[[str, str], Any],
        list_tools: Callable[[], list],
    ) -> None:
        self._call_tool = call_tool
        self._list_tools = list_tools

    def call(self, name: str, args: dict) -> dict:
        """Call a tool by name. Raises ToolCallError on failure.

        componentize-py unwraps result<string, string>: Ok returns the
        string directly, Err raises an Err(str) exception.
        """
        try:
            result = self._call_tool(name, json.dumps(args))
        except Exception as e:
            raise ToolCallError(e.value) from e
        return json.loads(result)

    def list(self) -> list[ToolDefinition]:
        """List available tools."""
        raw = self._list_tools()
        return [
            ToolDefinition(
                name=t.name,
                description=t.description,
                input_schema=json.loads(t.input_schema),
            )
            for t in raw
        ]


@dataclass
class LlmResponse:
    """Response from an LLM generation call."""

    text: str | None
    object: dict | None
    model: str
    usage: dict
    finish_reason: str


@dataclass
class HttpResponse:
    """Response from an HTTP fetch call."""

    status: int
    headers: dict[str, str]
    body: str

    def json(self) -> Any:
        """Parse body as JSON."""
        return json.loads(self.body)


class Llm:
    """Wrapper around WIT llm-generate capability."""

    def __init__(
        self,
        llm_generate: Callable[[str], str],
        agent_llm_config: dict | None = None,
    ) -> None:
        self._llm_generate = llm_generate
        self._config = agent_llm_config or {}

    def _parse_response(self, raw: str) -> LlmResponse:
        """Parse a JSON response string into an LlmResponse."""
        data = json.loads(raw)
        return LlmResponse(
            text=data.get("text"),
            object=data.get("object"),
            model=data["model"],
            usage=data["usage"],
            finish_reason=data["finish_reason"],
        )

    def generate(
        self,
        messages: list[dict[str, str]],
        *,
        model: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        provider_options: dict | None = None,
    ) -> LlmResponse:
        """Generate text from an LLM.

        Model resolution: explicit model param > agent llm config > error.
        """
        request: dict = {"messages": messages}
        if model is not None:
            request["model"] = model
        if max_tokens is not None:
            request["max_tokens"] = max_tokens
        if temperature is not None:
            request["temperature"] = temperature
        if provider_options is not None:
            request["provider_options"] = provider_options

        try:
            raw = self._llm_generate(json.dumps(request))
        except Exception as e:
            raise LlmError(e.value) from e

        return self._parse_response(raw)

    def generate_object(
        self,
        messages: list[dict[str, str]],
        schema: dict,
        *,
        model: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        provider_options: dict | None = None,
    ) -> LlmResponse:
        """Generate a structured object matching a JSON Schema.

        Returns LlmResponse with .object populated and .text as None.
        Consistent with generate() — callers access response.object.
        """
        request: dict = {"messages": messages, "output_schema": schema}
        if model is not None:
            request["model"] = model
        if max_tokens is not None:
            request["max_tokens"] = max_tokens
        if temperature is not None:
            request["temperature"] = temperature
        if provider_options is not None:
            request["provider_options"] = provider_options

        try:
            raw = self._llm_generate(json.dumps(request))
        except Exception as e:
            raise LlmError(e.value) from e

        return self._parse_response(raw)


class Http:
    """Wrapper around WIT http-fetch capability."""

    def __init__(self, http_fetch: Callable[[str], str]) -> None:
        self._http_fetch = http_fetch

    def fetch(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        body: str | None = None,
        timeout_ms: int | None = None,
    ) -> HttpResponse:
        """Make an outbound HTTP request through the host."""
        request: dict = {"url": url, "method": method}
        if headers is not None:
            request["headers"] = headers
        if body is not None:
            request["body"] = body
        if timeout_ms is not None:
            request["timeout_ms"] = timeout_ms

        try:
            raw = self._http_fetch(json.dumps(request))
        except Exception as e:
            raise HttpError(e.value) from e

        data = json.loads(raw)
        return HttpResponse(
            status=data["status"],
            headers=data.get("headers", {}),
            body=data.get("body", ""),
        )


class StreamEmitter:
    """Wrapper around WIT stream-emit capability."""

    def __init__(self, stream_emit: Callable[[str, str], None]) -> None:
        self._stream_emit = stream_emit

    def emit(self, event_type: str, data: dict | str) -> None:
        """Emit a raw stream event to the host."""
        payload = json.dumps(data) if isinstance(data, dict) else data
        self._stream_emit(event_type, payload)

    def progress(self, content: str, *, tool_name: str | None = None) -> None:
        """Emit a data-tool-progress event."""
        self.emit(
            "data-tool-progress",
            {"toolName": tool_name or "agent", "content": content},
        )

    def intent(self, content: str) -> None:
        """Emit a data-intent event."""
        self.emit("data-intent", {"content": content})


@dataclass
class SessionData:
    """Session metadata passed from the host."""

    id: str
    workspace_id: str
    user_id: str
    datetime: str


def _uninitialized_llm():
    """Factory for uninitialized LLM stub."""
    def stub(_: str) -> str:
        raise RuntimeError("LLM capability not initialized - this should only happen in tests without proper context setup")
    return Llm(stub)


def _uninitialized_tools():
    """Factory for uninitialized Tools stub."""
    def call_stub(_: str, __: str) -> Any:
        raise RuntimeError("Tools capability not initialized - this should only happen in tests without proper context setup")
    def list_stub() -> list:
        return []
    return Tools(call_stub, list_stub)


def _uninitialized_http():
    """Factory for uninitialized Http stub."""
    def stub(_: str) -> str:
        raise RuntimeError("HTTP capability not initialized - this should only happen in tests without proper context setup")
    return Http(stub)


def _uninitialized_stream():
    """Factory for uninitialized StreamEmitter stub (no-op)."""
    def stub(_: str, __: str) -> None:
        pass
    return StreamEmitter(stub)


@dataclass
class AgentContext:
    """Execution context passed to agent handlers.

    Capability fields (llm, tools, http, stream) are always non-None.
    Defaults are safe stubs that raise if called outside the host environment.
    """

    env: dict[str, str] = field(default_factory=dict)
    config: dict = field(default_factory=dict)
    session: SessionData | None = None
    output_schema: dict | None = None
    tools: Tools = field(default_factory=_uninitialized_tools)
    llm: Llm = field(default_factory=_uninitialized_llm)
    http: Http = field(default_factory=_uninitialized_http)
    stream: StreamEmitter = field(default_factory=_uninitialized_stream)

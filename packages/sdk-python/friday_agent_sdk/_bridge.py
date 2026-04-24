"""NATS entry point — replaces the WIT bridge shim.

Connects to nats-server, subscribes to agents.{sessionId}.execute,
handles one message (spawn-per-call model), then exits.

Users never import this module directly. Each agent.py ends with:

    if __name__ == "__main__":
        from friday_agent_sdk import run
        run()
"""

import asyncio
import dataclasses
import json
import os

from nats.aio.client import Client as NATS

from friday_agent_sdk._context import build_context
from friday_agent_sdk._registry import get_registered_agent
from friday_agent_sdk._result import ErrResult, OkResult
from friday_agent_sdk._serialize import serialize_data


def _to_camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _serialize_dataclass_camel(obj: object) -> dict:
    result = {}
    for f in dataclasses.fields(obj):  # type: ignore[arg-type]
        value = getattr(obj, f.name)
        if value is not None:
            result[_to_camel(f.name)] = value
    return result


def _serialize_extras(extras) -> dict:
    result = {}
    if extras.reasoning is not None:
        result["reasoning"] = extras.reasoning
    if extras.artifact_refs is not None:
        result["artifactRefs"] = [_serialize_dataclass_camel(r) for r in extras.artifact_refs]
    if extras.outline_refs is not None:
        result["outlineRefs"] = [_serialize_dataclass_camel(r) for r in extras.outline_refs]
    return result


def _serialize_result(result) -> dict:
    if isinstance(result, OkResult):
        inner: dict = {"data": serialize_data(result.data)}
        if result.extras:
            inner.update(_serialize_extras(result.extras))
        return {"tag": "ok", "val": json.dumps(inner)}
    elif isinstance(result, ErrResult):
        return {"tag": "err", "val": result.error}
    else:
        return {
            "tag": "err",
            "val": f"Handler returned {type(result).__name__}, expected OkResult or ErrResult",
        }


async def _run_async() -> None:
    nats_url = os.environ.get("NATS_URL", "nats://localhost:4222")
    session_id = os.environ["ATLAS_SESSION_ID"]

    nc = NATS()
    await nc.connect(nats_url)
    loop = asyncio.get_event_loop()

    sub = await nc.subscribe(f"agents.{session_id}.execute")

    # single-shot: handle exactly one message then exit (spawn-per-call)
    msg = await sub.next_msg(timeout=30)

    payload = json.loads(msg.data)
    prompt: str = payload["prompt"]
    context_raw: dict = payload["context"]

    ctx = build_context(context_raw, nc, session_id, loop)
    reg = get_registered_agent()

    try:
        if asyncio.iscoroutinefunction(reg.handler):
            result = await reg.handler(prompt, ctx)
        else:
            result = await asyncio.to_thread(reg.handler, prompt, ctx)
        response = _serialize_result(result)
    except Exception as e:
        response = {"tag": "err", "val": str(e)}

    await msg.respond(json.dumps(response).encode())
    await nc.drain()


def run() -> None:
    """Entry point called from agent.py __main__ block."""
    asyncio.run(_run_async())

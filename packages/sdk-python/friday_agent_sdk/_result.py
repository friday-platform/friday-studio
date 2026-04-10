"""Tagged union result types for agent handlers."""

from dataclasses import dataclass
from typing import Union


@dataclass
class ArtifactRef:
    """Reference to an artifact created by an agent."""

    id: str
    type: str
    summary: str


@dataclass
class OutlineRef:
    """Structured reference displayed in UI outline."""

    service: str
    title: str
    content: str | None = None
    artifact_id: str | None = None
    artifact_label: str | None = None


@dataclass
class AgentExtras:
    """Optional extras returned alongside agent success data."""

    reasoning: str | None = None
    artifact_refs: list[ArtifactRef] | None = None
    outline_refs: list[OutlineRef] | None = None


@dataclass
class OkResult:
    """Success result — data is serialized to JSON by the bridge."""

    data: object
    extras: AgentExtras | None = None


@dataclass
class ErrResult:
    """Error result — message is passed through to the host."""

    error: str


AgentResult = Union[OkResult, ErrResult]


def ok(data: object, extras: AgentExtras | None = None) -> OkResult:
    """Create a success result."""
    return OkResult(data=data, extras=extras)


def err(message: str) -> ErrResult:
    """Create an error result."""
    return ErrResult(error=message)

"""Shared pytest fixtures for SDK agent tests."""

from friday_agent_sdk._registry import _reset_registry


def pytest_collectstart(collector):
    """Reset the global agent registry before each test module collection.

    The SDK enforces one @agent per WASM component (global singleton).
    When pytest collects multiple test modules that each load a different
    agent fixture, the second module hits "Agent already registered".
    Resetting before collection lets each module register its own agent.
    """
    _reset_registry()

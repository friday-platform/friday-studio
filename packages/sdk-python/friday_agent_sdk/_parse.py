"""Structured JSON extraction from enriched prompt strings.

Ports the logic from packages/bundled-agents/src/shared/operation-parser.ts
to pure Python. Code agents receive JSON operation configs embedded in
enriched prompts — this module extracts them.
"""

import dataclasses
import json
import re
from typing import Any, TypeVar, overload

T = TypeVar("T")


def _extract_json_candidates(text: str) -> list[str]:
    """Extract JSON object substrings via balanced-brace scan.

    Hand-rolled scanner because regex can't handle arbitrary nesting depth
    (e.g., findings arrays with nested objects). Tracks string boundaries
    and escape sequences to avoid miscounting braces inside string literals.
    """
    results: list[str] = []
    i = 0
    while i < len(text):
        if text[i] != "{":
            i += 1
            continue
        depth = 0
        in_string = False
        end = i
        while end < len(text):
            ch = text[end]
            if in_string:
                if ch == "\\":
                    end += 1  # skip escaped char
                elif ch == '"':
                    in_string = False
                end += 1
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    break
            end += 1
        if depth == 0 and not in_string:
            results.append(text[i : end + 1])
            i = end + 1
        else:
            i += 1
    return results


@overload
def parse_input(prompt: str) -> dict: ...


@overload
def parse_input(prompt: str, schema: type[T]) -> T: ...


def parse_input(prompt: str, schema: type | None = None) -> Any:
    """Extract structured JSON input from a text string.

    Searches for JSON in this order:
    1. Raw JSON objects (balanced-brace extraction)
    2. Code-fenced JSON blocks (```json ... ```)
    3. The entire prompt as JSON

    If schema is provided, it must be a dataclass — the parsed dict is passed
    to its constructor (unknown keys filtered). If schema is None, returns
    the raw dict.

    Raises ValueError if no valid JSON is found.
    Raises TypeError if schema is provided but is not a dataclass type.
    """
    # Fail fast on bad schema
    if schema is not None and not dataclasses.is_dataclass(schema):
        raise TypeError(f"{schema.__name__} is not a dataclass")

    def _try_parse(json_str: str) -> dict | None:
        parsed = json.loads(json_str)
        if not isinstance(parsed, dict):
            return None
        if schema is not None:
            fields = {f.name for f in dataclasses.fields(schema)}
            filtered = {k: v for k, v in parsed.items() if k in fields}
            try:
                return schema(**filtered)
            except TypeError as e:
                required = {
                    f.name
                    for f in dataclasses.fields(schema)
                    if f.default is dataclasses.MISSING
                    and f.default_factory is dataclasses.MISSING
                }
                missing = required - set(filtered.keys())
                raise ValueError(
                    f"JSON parsed but doesn't match "
                    f"{schema.__name__}: missing {missing}"
                ) from e
        return parsed

    # 1. Balanced-brace JSON objects
    for candidate in _extract_json_candidates(prompt):
        try:
            result = _try_parse(candidate)
            if result is not None:
                return result
        except json.JSONDecodeError:
            continue

    # 2. Code-fenced JSON blocks
    for match in re.finditer(r"```json\s*([\s\S]*?)```", prompt):
        try:
            result = _try_parse(match.group(1))
            if result is not None:
                return result
        except json.JSONDecodeError:
            continue

    # 3. Full prompt as JSON
    try:
        result = _try_parse(prompt)
        if result is not None:
            return result
    except json.JSONDecodeError:
        pass

    raise ValueError(
        "No valid JSON object found in prompt. "
        f"Prompt starts with: {prompt[:200]}"
    )


def parse_operation(prompt: str, schemas: dict[str, type[T]]) -> T:
    """Extract an operation config from an enriched prompt.

    Like parse_input, but filters to JSON objects containing an "operation"
    field and uses the discriminator to select the right dataclass schema.
    Mirrors the TS parseOperationConfig from operation-parser.ts.

    Args:
        prompt: Enriched prompt text potentially containing multiple JSON objects.
        schemas: Map of operation name → dataclass type (e.g. {"clone": CloneConfig}).

    Returns:
        Typed dataclass instance for the matched operation.

    Raises:
        ValueError: No valid operation config found in prompt.
    """
    # 1. Balanced-brace JSON objects containing "operation"
    for candidate in _extract_json_candidates(prompt):
        if '"operation"' not in candidate:
            continue
        try:
            raw = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(raw, dict) or "operation" not in raw:
            continue
        schema = schemas.get(raw["operation"])
        if schema is None:
            continue
        try:
            return parse_input(candidate, schema)
        except (ValueError, TypeError):
            continue

    # 2. Code-fenced JSON blocks containing "operation"
    for match in re.finditer(r"```json\s*([\s\S]*?)```", prompt):
        block = match.group(1)
        if '"operation"' not in block:
            continue
        try:
            raw = json.loads(block)
        except json.JSONDecodeError:
            continue
        if not isinstance(raw, dict) or "operation" not in raw:
            continue
        schema = schemas.get(raw["operation"])
        if schema is None:
            continue
        try:
            return parse_input(block, schema)
        except (ValueError, TypeError):
            continue

    raise ValueError(
        "No valid operation config found in prompt. "
        f"Known operations: {list(schemas.keys())}. "
        f"Prompt starts with: {prompt[:200]}"
    )

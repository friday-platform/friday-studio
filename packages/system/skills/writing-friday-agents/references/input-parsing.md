# Input parsing (`parse_input` / `parse_operation`)

`prompt` is not a clean JSON dict. Friday sends enriched markdown — user task, temporal facts, signal data, accumulated context, sometimes JSON in a code fence or inline object. Parse with SDK helpers, not string ops.

## `parse_input` — single shape

```python
from dataclasses import dataclass
from friday_agent_sdk import parse_input

@dataclass
class AnalyzeInput:
    text: str
    max_length: int = 500

def execute(prompt, ctx):
    try:
        data = parse_input(prompt, AnalyzeInput)
    except ValueError as e:
        return err(f"Invalid input: {e}")
    # data.text, data.max_length
```

Search order: balanced-brace JSON → fenced code block → whole prompt as JSON. Unknown keys dropped; required fields validated. Raises `ValueError` if nothing parses or required fields missing.

**Schema must be `@dataclass`, not Pydantic.** Pydantic is not installed in the agent environment.

Free-text prompt with no required JSON:

```python
payload = parse_input(prompt)  # dict or None — doesn't raise on missing JSON
```

## `parse_operation` — discriminated union

Multiple operations keyed on `operation` string:

```python
from dataclasses import dataclass
from friday_agent_sdk import parse_operation

@dataclass
class CreateIssue:
    operation: str
    summary: str
    description: str = ""

@dataclass
class UpdateIssue:
    operation: str
    issue_id: str
    status: str

OPERATIONS = {"create": CreateIssue, "update": UpdateIssue}

def execute(prompt, ctx):
    try:
        config = parse_operation(prompt, OPERATIONS)
    except ValueError as e:
        return err(f"Invalid operation: {e}")

    match config.operation:
        case "create":
            return _handle_create(config, ctx)
        case "update":
            return _handle_update(config, ctx)
```

The payload's `operation` string picks the dataclass. Every schema must include `operation: str`.

## Which to use

| Situation | Use |
|---|---|
| One thing | `parse_input` |
| 2+ modes on a literal | `parse_operation` |
| Optional JSON, may be raw text | `parse_input(prompt)` (no schema) |
| Nested/polymorphic per-field | `json.loads` + hand validation |

## FSM-triggered agents: unwrap `config`

Agents invoked from a workspace FSM action receive the signal payload wrapped one level deep, as `{ "config": { ...payload-fields... } }`. The wrap is added by the runtime when it auto-seeds `prepareResult` from a signal — `parse_input(prompt, MyInput)` against the raw prompt then fails because the schema fields live one level down.

Unwrap before typing:

```python
raw = parse_input(prompt)  # untyped dict
payload = raw.get("config", raw)  # tolerate both wrapped and flat
data = parse_input(json.dumps(payload), MyInput)
```

Same agent stays usable from non-FSM call sites that pass the schema fields at the top level — the `raw.get("config", raw)` fallback handles both.

## Value validation

Dataclasses give presence + type, not value constraints. Check by hand:

```python
if data.max_length <= 0 or data.max_length > 10000:
    return err("max_length must be between 1 and 10000")
```

Don't import validation libraries — most are blocked.

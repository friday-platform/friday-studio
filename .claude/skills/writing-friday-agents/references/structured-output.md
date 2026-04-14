# Structured output (`generate_object` + JSON Schema)

Use `ctx.llm.generate_object` when the model must return a specific shape — field lists, categories, ranked items. Provider enforces the schema; response returns pre-parsed.

## Pattern

```python
schema = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "key_points": {"type": "array", "items": {"type": "string"}},
        "sentiment": {"type": "string", "enum": ["positive", "negative", "neutral"]},
    },
    "required": ["summary", "key_points", "sentiment"],
    "additionalProperties": False,
}

response = ctx.llm.generate_object(
    messages=[{"role": "user", "content": f"Analyze this: {text}"}],
    schema=schema,
    model="anthropic:claude-haiku-4-5",
)
return ok(response.object)
```

## Schema format

JSON Schema as a dict, not a dataclass. Distinct from `parse_input`'s dataclass schemas.

- Set `"additionalProperties": False` on objects. Without it, providers sometimes add fields.
- List every expected field in `"required"`. Optional fields go in `properties` but not `required`.
- Use `enum` for categorical fields — more reliable than a description.
- Nested objects and arrays of objects work. Deep nesting confuses smaller models.

## Patterns

**Colocate dataclass and schema.** Mirror them in one place if you also want a typed view:

```python
@dataclass
class AnalysisResult:
    summary: str
    key_points: list[str]
    sentiment: str

ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "key_points": {"type": "array", "items": {"type": "string"}},
        "sentiment": {"type": "string", "enum": ["positive", "negative", "neutral"]},
    },
    "required": ["summary", "key_points", "sentiment"],
    "additionalProperties": False,
}
```

**Don't re-validate.** Provider already enforced the schema. Trust `response.object`.

## When not to use it

- Free prose (summary, draft email) → `generate` + `ok({"text": response.text})`
- Single value → `generate` + light parsing is often simpler
- Streaming needed → not available

## Gotcha

`generate_object` populates `response.object`, leaves `response.text` as `None`. `generate` is the reverse. Mixing them gives `None`, not an error.

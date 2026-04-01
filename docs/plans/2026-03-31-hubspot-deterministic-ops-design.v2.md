<!-- v2 - 2026-03-31 - Generated via /improving-plans from docs/plans/2026-03-31-hubspot-deterministic-ops-design.md -->

## Problem Statement

When the HubSpot agent is used as a mechanical relay — e.g., "post this exact
text as an internal comment" — the LLM intermediary re-interprets the input,
summarizing or cherry-picking content instead of passing it through verbatim.
This makes the agent unreliable for pipeline steps where the caller has already
composed the exact payload.

The bb and gh agents solved this by being fully deterministic (JSON operation in,
structured result out, no LLM). HubSpot needs the same capability for write
operations, while keeping the LLM path for exploratory CRM work.

## Solution

Add a deterministic operation dispatch path to the existing HubSpot agent
handler. When the prompt contains a JSON operation document, the agent parses it,
executes the corresponding API call directly (no LLM), and returns structured
output. When the prompt is freeform text, the existing `generateText` path runs
unchanged.

This is the same hybrid pattern the bb/gh agents use, applied to HubSpot.

## User Stories

1. As a workspace author, I want to post exact text to a HubSpot conversation thread, so that pipeline-composed content is not altered by an LLM
2. As a workspace author, I want to send a JSON operation document to the HubSpot agent, so that I get deterministic execution without LLM interpretation
3. As a workspace author, I want to keep using freeform prompts for exploratory CRM tasks (searching, reading tickets), so that the LLM path remains available
4. As a workspace author, I want structured output from deterministic operations (operation, success, data), so that downstream FSM steps can validate and extract fields reliably
5. As a workspace author, I want the HubSpot agent to return the same `{ response }` shape it always has when using freeform prompts, so that existing workspaces are not broken
6. As a platform developer, I want to add new deterministic operations by adding a schema variant and a switch case, so that the pattern scales without touching the LLM path
7. As a platform developer, I want the deterministic path to reuse the existing tool execute functions, so that API logic is not duplicated
8. As a platform developer, I want the output schema to remain a flat `z.object` with optional fields, so that the workspace planner and FSM engine remain compatible

## Implementation Decisions

### Hybrid Handler Pattern

The HubSpot agent handler gains a deterministic preamble before the existing
`generateText` call, using a **two-phase parse** to safely distinguish freeform
prompts from operation documents:

```
handler entry
  Phase 1: tryExtractJson(prompt) → json with "operation" key?
    no  → fall through to existing generateText() path (freeform prompt)
    yes → Phase 2: HubSpotOperationSchema.safeParse(json)
      success → deterministic switch(config.operation) → return ok({...})
      unknown op → return err("Unknown operation: <name>")
      validation failure → return err("Invalid operation: <details>")
  (LLM path is completely untouched)
```

**Why two-phase?** A single `parseOpConfig` try/catch treats all parse failures
identically — "not JSON" and "JSON with recognized operation but missing required
fields" both fall through to the LLM. The second case is dangerous: the prompt
clearly intended deterministic execution, and falling through lets the LLM
compose its own content, which is the exact problem this feature solves. Two-phase
parsing ensures that once the prompt looks like an operation doc (JSON with an
`operation` key), any validation failure is a hard error, not a silent
fallthrough.

Phase 1 is intentionally loose — it only checks for JSON containing an
`operation` key. This means freeform prompts (even those containing incidental
JSON) pass through to the LLM unless they have the specific `operation`
discriminator.

### Output Schema

The output schema becomes a flat object with optional fields for the
deterministic path:

```
HubSpotOutputSchema = z.object({
  response: z.string(),
  operation: z.string().optional(),
  success: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})
```

A `z.union` was considered but rejected because:

- The registry test asserts no `anyOf` in output JSON schemas
- `sanitizeJsonSchema()` strips `anyOf`/`oneOf`, losing all type information
- Field path validation walks `schema.properties` at the root — a union has
  none after sanitization

The discriminant is the presence of `operation`: LLM path returns only
`{ response }`, deterministic path returns all four fields.

**Deterministic path `response` value:** The deterministic path populates
`response` with a human-readable confirmation string (e.g.,
`"Comment posted to thread 456"`). This keeps `response` meaningful across both
paths — downstream FSM steps and `comment-result` documentTypes that read
`.response` get something sensible for logging/debugging without needing to parse
`data`. The structured payload lives in `data` for programmatic access.

### Operation Schema

Deterministic operations use a discriminated union on the `operation` field:

```
HubSpotOperationSchema = z.discriminatedUnion("operation", [
  SendThreadCommentOpSchema,
])
```

`SendThreadCommentOpSchema` maps directly to the existing
`send_thread_comment` tool input:

```
SendThreadCommentOpSchema = z.object({
  operation: z.literal("send-thread-comment"),
  threadId: z.string(),
  text: z.string(),
  richText: z.string().optional(),
  senderActorId: z.string().optional(),
})
```

Future deterministic operations are added by defining a new schema variant and
a new switch case.

### Direct Tool Reuse

The deterministic path calls the existing tool execute functions directly
(e.g., `createSendThreadCommentTool(accessToken)`), avoiding duplication of
HubSpot API logic. The tools layer remains the single source of truth for API
calls, request formatting, and response parsing.

### Workspace Integration

FSM `prepare_comment` functions output a JSON operation document as the task
string:

```
JSON.stringify({
  operation: "send-thread-comment",
  threadId: threadId,
  text: fullKbAnswerBody,
})
```

The agent receives this as its prompt, the two-phase parse extracts the JSON,
validates the full schema, and the operation executes with the exact `text` value.

Steps that need LLM reasoning (e.g., `step_read_ticket`) continue sending
freeform prompts and hitting the LLM path.

### Module Boundaries

**Deterministic dispatch (new, in agent.ts handler)**

- **Interface:** JSON prompt with `{ operation: "...", ...params }` → structured
  `{ response, operation, success, data }`
- **Hides:** Operation routing, two-phase validation, tool invocation, error
  wrapping
- **Trust contract:** If Phase 1 detects an operation doc, execution is fully
  deterministic — either succeeds exactly as specified or returns a hard error.
  No LLM interpretation occurs. If Phase 1 does not detect an operation doc,
  the LLM path handles it.

**Tool layer (unchanged, tools.ts)**

- **Interface:** `createSendThreadCommentTool(accessToken).execute(input)`
- **Hides:** HTTP call construction, Zod response parsing, URL building
- **Trust contract:** Caller provides typed input, gets typed output or a thrown
  error. No side effects beyond the single API call.

### Error Handling

**Phase 1 miss (no JSON or no `operation` key):** Falls through to LLM path.
Not treated as an error — the prompt is freeform text for the LLM.

**Phase 2 validation failure (JSON has `operation` but fails schema):** Returns
`err("Invalid operation: <zod error details>")`. This is a hard error — the
prompt intended deterministic execution but had malformed fields. Falling through
to the LLM would mask the bug.

**Unknown operation (valid JSON, `operation` not in discriminated union):** Returns
`err("Unknown operation: <name>")` immediately.

**API failure (`hubspotFetch` throws):** The deterministic path catches it and
returns `err("send-thread-comment failed: <message>")`. The FSM treats this as a
step failure, same as if the LLM path errored.

## Testing Decisions

Tests verify external behavior: given a prompt shape, assert the output shape
and API call. No mocking of internal routing logic.

**Deterministic path tests:**

- JSON operation prompt → calls tool execute with exact params, returns
  structured output with human-readable `response` confirmation
- Text field is passed through byte-for-byte (the core requirement)
- Missing required fields in JSON with `operation` key → hard `err()` with
  validation details (NOT fallthrough to LLM)
- Malformed JSON (no `operation` key) → falls through to LLM path
- Non-JSON freeform prompt → falls through to LLM path
- Valid JSON, unknown operation → `err()` with descriptive message
- API failure (hubspotFetch throws) → `err()` with upstream error

**LLM path regression:**

- Freeform prompt (no JSON) → reaches `generateText`, returns `{ response }`
- Existing CRM tool tests remain passing

**Registry compatibility:**

- Output schema produces no `anyOf` in `z.toJSONSchema()` (existing test)

Prior art: bb/gh agent tests follow deterministic input/output assertions.
Hubspot conversation tool tests in `tools.test.ts` already mock `hubspotFetch`
with fixture data.

## Out of Scope

- Additional deterministic operations beyond `send-thread-comment` (added when
  needed)
- Changes to the FSM engine or workspace runtime
- Changes to the shared `operation-parser.ts`
- Changes to the HubSpot system prompt or LLM tool set
- Changes to the workspace planner or registry infrastructure
- Fixing the `get_crm_object` 403 scope issue (separate OAuth config change)

## Further Notes

- The `get_crm_object` call in `step_read_ticket` returns HTTP 403
  (MISSING_SCOPES). The agent works around this by pulling context from
  conversation thread APIs. Adding the `tickets` scope to the HubSpot OAuth
  app would give richer ticket metadata but is not required for this feature.
- The `bucketlist-cs/workspace.yml` example also needs updates: `prepare_comment`
  outputs a JSON operation doc, and the `comment-result` documentType matches
  the deterministic output shape.

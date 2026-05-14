---
name: agent-action-handshake
description: |
  Canonical reference for the contract between an FSM action and the agent it
  invokes. Loads when authoring or debugging any combination of: `type: llm`
  inline action, `type: agent` action with `outputTo`, `type: agent` action
  with `inputFrom`, agent prompts that need to coordinate with the action
  invoking them. Covers what the runtime auto-injects per invocation kind
  (platform tools, `complete` when `outputTo` is set), `outputTo` semantics,
  `inputFrom` resolution, the four invocation kinds.
---

# Agent ↔ FSM-action handshake

This is the contract between an FSM action and the agent it
invokes. Most "platform bug" misdiagnoses live in the gap between
"how the FSM authors the action" and "what the agent prompt
expects." Read this once, then ground every job/agent edit in it.

## The four invocation kinds

| FSM action | Referenced agent | Runtime path |
|---|---|---|
| `type: llm` inline | none — the action carries `provider`, `model`, `prompt`, `tools` directly | `fsm-engine.ts case "llm"` |
| `type: agent` | `agents.<id>` block with `type: llm` | `fsm-engine.ts case "agent"` → `runAgent` → `from-llm.ts` |
| `type: agent` | `agents.<id>` with `type: atlas` | `case "agent"` → `runAgent` → bundled-agent handler |
| `type: agent` | `agents.<id>` with `type: user` | `case "agent"` → `runAgent` → ProcessAgentExecutor (NATS subprocess) |

Each path has the same `outputTo` contract but different tool
surfaces and prompt-composition rules.

## What the runtime auto-injects

Regardless of invocation kind, the LLM-side agent (any agent that's
`type: llm`) sees:

- **Platform tools** — full `PLATFORM_TOOL_NAMES` set from
  `packages/agent-sdk/src/platform-tools.ts` (~35 entries spanning
  memory, artifacts, fs, shell/data, state, HITL, and flow-control
  like `delegate`). These inject on top of the agent's
  `config.tools` allowlist regardless of what's in `tools:`. See
  source for the exact set.
- **`complete` tool** — injected when the action declares `outputTo`.
  The LLM MUST call this to surface output (see "The `complete`
  contract" below).
- **`failStep` tool** — injected for inline `type: llm` FSM actions
  (see `fsm-engine.ts case "llm"`). The LLM calls this to
  deliberately fail the step with a structured reason. NOT injected
  on the `type: agent` → `type: llm` path that goes through
  `from-llm.ts`; an agent reachable through both shapes can't
  assume the tool is present.

What's NOT auto-injected:

- MCP server tools — those come from `agents.<id>.config.tools`
  (workspace-scope MCP only) or from the inline `type: llm`
  action's `tools:` array.

## The `complete` contract

The single most important rule: **if an action has `outputTo`, the
agent's prompt MUST instruct the LLM to call `complete` with the
structured output.**

When the action is:

```yaml
- type: agent
  agentId: stale-report-agent
  outputTo: response
```

The runtime injects a `complete` tool with input schema `{response:
string}` (or richer if `outputType` is declared). The agent's prompt
should end with:

```
When done, call the `complete` tool with:
  { "response": "<the full final text>" }
This is how the FSM captures your output. Do not stream the text as
your final assistant message — the runtime reads it from `complete`.
```

Without this instruction, the LLM streams prose, never calls
`complete`, and the runtime throws:

```
LLM action with outputTo 'response' did not call complete
```

## `outputType` and structured output

When you set `outputType: SomeDoc`, the runtime looks up
`fsm.documentTypes.SomeDoc` for a JSON Schema and feeds it to the
`complete` tool's input schema. The LLM must produce data matching
the schema.

```yaml
documentTypes:
  EmailDraft:
    type: object
    properties:
      to: { type: string }
      subject: { type: string }
      body: { type: string }
    required: [to, subject, body]

states:
  drafting:
    entry:
      - type: agent
        agentId: drafter
        outputTo: draft
        outputType: EmailDraft
```

The agent's prompt should know about `to`, `subject`, `body` —
either from the prompt body or from a worked example.

## `inputFrom` and document chaining

`inputFrom` reads a prior step's `outputTo` document and feeds it
into the next step's input. String form chains one prior; array
form concatenates multiple labeled.

```yaml
states:
  draft:
    entry:
      - type: agent
        agentId: drafter
        outputTo: draft-doc
      - type: emit
        event: DONE
    on: { DONE: { target: review } }
  review:
    entry:
      - type: agent
        agentId: reviewer
        inputFrom: draft-doc       # reads from draft-doc
```

Bulky inputs are passed as `artifactRefs` plus a compact summary —
the agent reads the full data via `parse_artifact(<id>)` if needed.

## Pattern A vs Pattern B

Two job shapes:

- **Pattern A** (`execution.strategy: sequential`): list of agent
  IDs that run in order. Final agent's assistant text becomes the
  session output natively. Use when the work is a single LLM
  conversation, no document chaining needed, output is plain text.
- **Pattern B** (`fsm:`): state machine with named states, entry
  actions, and explicit `outputTo` documents. Required when you
  need branching, multi-step document flow, parallel actions, or
  HITL elicitation.

**Don't migrate Pattern A → Pattern B "to get `outputTo`."** The
migration introduces the `complete` injection contract, which is
the single most common source of empty-output failures. If a
Pattern A job is producing empty output, fix the agent's prompt
first.

## Cross-references

- `@friday/writing-workspace-jobs` — FSM authoring shapes.
- `@friday/workspace-api` — agent CRUD.
- `@friday/delegate-handoff` — sibling contract for the
  parent ↔ delegate-child boundary.
- `@friday/debugging-empty-output` — what happens when this contract is
  violated.
- `@friday/debugging-runtime-errors` — `did not call complete` and
  related errors.

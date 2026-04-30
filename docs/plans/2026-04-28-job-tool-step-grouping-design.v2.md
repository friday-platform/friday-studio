<!-- v2 - 2026-04-28 - Generated via /improving-plans from docs/plans/2026-04-28-job-tool-step-grouping-design.md -->

# Job Tool Step Grouping Design

## Problem Statement

When a workspace job invokes multiple agents in sequence — e.g. a triage agent followed by a draft agent — the job tool's nested children render as a flat list under the job card. The user sees `search_gmail_messages`, `memory_read`, `get_gmail_messages_content_batch` as siblings, with no visual indication that some belong to the triage step and others to the draft step. This makes it hard to understand which agent produced which work.

## Solution

Add explicit step-correlation to the nested-chunk envelope protocol. The workspace runtime emits FSM action-execution events that mark step boundaries. The job tool's SSE consumer receives these events. We:

1. Emit synthetic **agent-step-start** / **agent-step-complete** events into the chat stream when a step boundary is observed.
2. Forward all tool-call chunks that occur between a step's start and complete as **nested-chunk** envelopes scoped to that step's ID.
3. Introduce a `StepDisplay` node type as a discriminated-union sibling to `ToolCallDisplay`.
4. Teach the reducer to create step nodes as first-class intermediate parents in the tree.
5. Render step nodes with agent name, status, and collapsible nested children.

## User Stories

1. As a Friday user, when a job runs multiple agents, I want to see each agent's work grouped under a named step card, so I understand which agent did what.
2. As a Friday user, when a job has sequential steps, I want to see them as sibling step cards under the job, each with its own nested tool calls, so the work is visually distinct.
3. As a Friday user, I want step cards to auto-expand while their inner tool calls are in-flight, and remain expanded when the step completes, so I can monitor progress without clicking.
4. As a Friday user, I want to expand a completed step card to inspect exactly which tools it called, with what inputs and outputs, so I can audit a specific agent's work.
5. As a Friday developer, I want the step node type to be a discriminated union sibling to tool-call nodes, not a synthetic tool call, so the rendering layer can style them differently and the reducer doesn't conflate step boundaries with actual tool execution.

## Implementation Decisions

### New schema entries

Two new entries in `AtlasDataEventSchemas` (packages/agent-sdk). The `agent-` prefix distinguishes UI data parts from session-history events (`step:start` / `step:complete` in packages/core).

```ts
"agent-step-start": z.object({
  parentToolCallId: z.string(),   // job tool call ID this step belongs to
  stepId: z.string(),             // `${sessionId}-step-${stepNumber}`
  stepNumber: z.number(),
  stepName: z.string(),           // agent name or FSM state ID
  jobName: z.string(),
  input: z.unknown().optional(), // FSM input snapshot
}),
"agent-step-complete": z.object({
  parentToolCallId: z.string(),
  stepId: z.string(),
  stepNumber: z.number(),
  status: z.enum(["completed", "failed"]),
  output: z.unknown().optional(),
  reasoning: z.string().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
}),
```

Extend `data-nested-chunk` with optional `stepId` (same as v1):

```ts
"nested-chunk": z.object({
  parentToolCallId: z.string(),
  stepId: z.string().optional(),  // NEW
  chunk: z.unknown(),
}),
```

`stepId` is optional for backward compatibility: existing nested-chunk consumers (direct agent calls, delegate) continue to attach children directly to `parentToolCallId`. When `stepId` is present, the reducer inserts the step node between parent and child.

### Server-side: Job tool SSE consumer

In `executeJobViaSSE` (job-tools.ts), track the active step ID:

- On `data-fsm-action-execution` with `status: "started"` and `isAgentAction(...)`:
  - Derive `stepId` from the event's `sessionId` + local `stepCounter` (incremented in the consumer, or read from a counter if the runtime exposes it).
  - Write `data-agent-step-start` to the chat writer with `parentToolCallId: toolCallId`.
  - Record `activeStepId = stepId`.

- On any tool-call chunk (`tool-input-start`, `tool-input-available`, etc.):
  - If `activeStepId` is set, wrap as `data-nested-chunk` with both `parentToolCallId: toolCallId` and `stepId: activeStepId`.
  - If no active step, wrap as plain `data-nested-chunk` (current behavior).

- On `data-fsm-action-execution` with `status: "completed"` or `"failed"` and `isAgentAction(...)`:
  - Write `data-agent-step-complete` with matching `stepId`, `durationMs` from the FSM event, and `status`.
  - Clear `activeStepId`.

The job tool consumer owns step ID derivation from FSM events and the state machine of active-step tracking. The trust contract is: every inner tool call emitted between an agent-step-start and agent-step-complete lands under that step in the UI tree. Tool calls outside any step attach directly to the job tool (backward compatible).

### Server-side: Ephemeral session chunks

The workspace runtime's `onStreamEvent` callback already tags ephemeral chunks with `stepNumber` via `sessionStream.emitEphemeral({ stepNumber, chunk })`. Augment this to also include `stepId`:

```ts
sessionStream?.emitEphemeral({
  stepNumber: stepCounter,
  stepId: `${sessionId}-step-${stepCounter}`,
  chunk,
});
```

This makes session-history ephemeral chunks self-describing, so any future consumer of the session stream (not just the chat UI) can correlate chunks to steps without re-deriving the ID.

### Tree node union type

Introduce `StepDisplay` alongside `ToolCallDisplay` in the playground chat types.

```ts
export interface StepDisplay {
  kind: "step";
  stepId: string;
  stepNumber: number;
  stepName: string;
  jobName: string;
  status: "running" | "completed" | "failed";
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  reasoning?: string;
  errorText?: string;
  children?: TreeNode[];
}

export interface ToolCallDisplay {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  state: ...; // unchanged
  input?: unknown;
  output?: unknown;
  errorText?: string;
  children?: TreeNode[];
  reasoning?: string;
  progress?: string[];
  durationMs?: number;
}

export type TreeNode = ToolCallDisplay | StepDisplay;
```

`ToolCallDisplay` gains `kind: "tool"` (defaulted by the reducer for backward compatibility). All existing `children` arrays become `TreeNode[]`.

### Reducer: extractToolCalls and tree builder

**extractToolCalls.ts** — two new responsibilities during Pass 2:

1. **Step node creation**: when `data-agent-step-start` is encountered, create a `StepDisplay` entry in the working flat map keyed by `stepId`. Its `parentToolCallId` is the event's `parentToolCallId` (the job tool call).

2. **Parent pointer rewrite**: when a `data-nested-chunk` carries `stepId`, the reducer creates its accumulated entry with `parentToolCallId: stepId` (instead of the envelope's `parentToolCallId`). The step node itself already points to the job tool, so the tree builder naturally produces `job → step → tool`.

When `data-agent-step-complete` is encountered, find the `StepDisplay` entry by `stepId` and update its `status`, `durationMs`, `output`, `reasoning`, and `error` fields.

**tree-builder.ts** — minimal changes:

- Accept `Map<string, TreeNode & { parentToolCallId?: string }>` instead of `ToolCallDisplay`.
- Use a `nodeId` helper: `node.kind === "step" ? node.stepId : node.toolCallId`.
- The existing parent-chain resolution and cycle-breaking logic is unchanged; it operates on IDs, not node types.

The tree shape becomes:

```
job-tool (triage-inbox)
  ├─ step-1 (triage-agent)
  │    ├─ search_gmail_messages
  │    └─ memory_read
  └─ step-2 (draft-agent)
       └─ get_gmail_messages_content_batch
```

### Step-level error propagation

If a step fails, its children may still be in-flight. The reducer must mark them `output-error` — this generalizes the existing `delegate-end` blanket-interrupt pattern to `agent-step-complete` with `status: "failed"`.

After the tree is built, a post-processing walk finds `StepDisplay` nodes with `status === "failed"` and calls `interruptSubtree` on every child. This prevents orphaned "running" tool cards when an agent step aborts mid-tool-call.

### UI: TreeNodeCard renderer

The existing `ToolCallCard.svelte` becomes a discriminated dispatcher over `TreeNode`:

- **`kind: "step"`** — `StepCallCard`:
  - Icon: agent/robot instead of wrench.
  - Title: `stepName` (agent name or state ID).
  - Subtitle: `jobName` + step number.
  - Status badge: running / completed / failed.
  - Collapsible nested children (same disclosure as tool calls).
  - No input/output toggles — steps don't have tool args.
  - Reasoning text, when present, renders in a muted expandable panel.
  - Step cards are visually subtler than tool cards — indented, with a muted left border — to communicate that they are grouping boundaries, not executable operations.

- **`kind: "tool"`** — existing `ToolCallCard` rendering, unchanged except that recursive child rendering dispatches back to the same component.

The `ToolCallDisplay[]` return type of `extractToolCalls` becomes `TreeNode[]`. All chat-list rendering paths that iterate tool calls switch to iterating `TreeNode`.

### Data isolation

No database changes. `data-agent-step-start`, `data-agent-step-complete`, and `data-nested-chunk` with `stepId` ride on the existing `parts[]` persistence. No migration needed.

## Module Boundaries

**Job tool SSE consumer (`job-tools.ts`)**
- **Interface**: `executeJobViaSSE` already receives the full SSE stream.
- **Hides**: step ID derivation from FSM events, active-step tracking state machine, emission of synthetic agent-step-start/agent-step-complete events, scoping of nested-chunk envelopes with `stepId`.
- **Trust contract**: every inner tool call emitted between an agent-step-start and agent-step-complete lands under that step in the UI tree. Tool calls outside any step attach directly to the job tool (backward compatible).

**Workspace runtime (`runtime.ts`)**
- **Interface**: `onStreamEvent(chunk)` callback.
- **Hides**: ephemeral tap augmentation with `stepId`. Step counter is per-session, local to the runtime.
- **Trust contract**: every ephemeral chunk emitted during an active agent step carries the correct `stepNumber` and `stepId`. The chat-bound stream and the session-history stream receive consistent step metadata.

**Reducer (`extractToolCalls.ts`)**
- **Interface**: `(msg: AtlasUIMessage) → TreeNode[]`.
- **Hides**: that step nodes exist in the internal flat map; that parent pointers are rewritten from `parentToolCallId` to `stepId` when a nested-chunk carries `stepId`.
- **Trust contract**: a `data-nested-chunk` with `stepId` is always parented under that step, regardless of chunk interleaving. Steps without inner tool calls render as empty nodes (no children). Unknown step IDs fall back to direct attachment under `parentToolCallId` (defensive). Failed steps blanket-interrupt their non-terminal children.

**Tree builder (`tree-builder.ts`)**
- **Interface**: `(flat: Map<string, TreeNode & { parentToolCallId?: string }>) → TreeNode[]`.
- **Hides**: the recursive insertion of step nodes into the tree; handling of orphaned step references.
- **Trust contract**: every entry's `parentToolCallId` is resolved. If a `stepId` is present in a nested-chunk, the reducer has already rewritten the parent pointer so the tree builder resolves it naturally.

**UI renderer (`ToolCallCard` / `StepCallCard`)**
- **Interface**: `TreeNode[]` — discriminated by `kind`.
- **Hides**: whether a node came from a real tool call or a synthetic step boundary.
- **Trust contract**: step nodes render with agent icon, no input/output chrome, and nested children in a collapsible list. Tool nodes render exactly as before.

## Testing Decisions

- **Reducer unit tests**: fixtures with interleaved chunks from two sequential steps. Verify that `step-1` children and `step-2` children are correctly partitioned.
- **Step-failure tests**: a fixture where `agent-step-complete` with `status: "failed""` arrives while children are still `input-streaming`. Verify that all non-terminal children are promoted to `output-error` with `errorText: "interrupted"`.
- **Tree builder unit tests**: a flat map with mixed tool calls, step nodes, and delegate-nested-chunk children. Verify correct three-level tree (`job` → `step` → `tool`, plus `job` → `delegate` → `agent` → `tool`).
- **Job tool SSE tests**: mock SSE stream with `data-fsm-action-execution` start/complete wrapping `tool-input-start` and `tool-output-available`. Verify emitted `data-agent-step-start`, `data-agent-step-complete`, and `data-nested-chunk` with `stepId`.
- **End-to-end**: trigger a real multi-step job (e.g. Inbox Zero with triage + draft), verify the UI renders step cards with correct nested children.

## Out of Scope

- **Parallel step execution**: the FSM engine executes states sequentially. The tree structure supports parallel step siblings (two `StepDisplay` nodes under the same job tool), but the reducer and runtime do not need to handle simultaneous active steps. Parallel execution is a future runtime feature.
- **Step reasoning text rendering**: `reasoning` is plumbed through the schema and stored on `StepDisplay`, but a rich reasoning timeline (expandable per-thought) is a follow-up UI enhancement. The initial renderer shows reasoning as a simple expandable text block.
- **Other client rendering**: only `agent-playground` gets the step card renderer in this pass. Any other client consuming the SSE stream will see agent-step-start/complete as unknown `data-*` parts (harmless) until its reducer is updated.
- **Delegate inside job tool**: if a job tool's inner agent calls `delegate`, the delegate's nested-chunk envelopes already carry `parentToolCallId: delegateToolCallId`. With step grouping, those delegates appear as children of the step, not of the job tool directly. This is correct — no special handling needed.

## Further Notes

- The `stepId` derivation should use the session-scoped `stepCounter` plus the action's `actionId` or `state` to guarantee uniqueness across steps. Format: `${sessionId}-step-${stepNumber}`.
- Step nodes are **not** tool calls. They have no `input`/`output` state machine. Their status is binary (`running` from start to complete, then `completed` or `failed`). The reducer maps this to a simplified display state.
- The `data-fsm-action-execution` event already carries `durationMs` on completion. We plumb this into `data-agent-step-complete` so the UI can show step duration without client-side timing.
- When migrating types, `ToolCallDisplay[]` becomes `TreeNode[]` in the chat-message shape. Type errors will surface every render site — this is desirable, as it forces explicit handling of the new `kind: "step"` branch.

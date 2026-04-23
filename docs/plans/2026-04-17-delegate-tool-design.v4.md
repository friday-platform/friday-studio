<!-- v4 - 2026-04-22 - Generated via /improving-plans from docs/plans/2026-04-17-delegate-tool-design.v3.md -->

# Delegate Tool Design

## Problem Statement

As a user of the workspace chat in Friday, when I ask the agent to do something
that requires multiple tool calls (e.g. "go to airbnb.com and take a
screenshot"), the agent invokes `do_task`, which dispatches through the
workspace planner and FSM execution layer. From my perspective this is a
black box: I see `✓ do_task … done` with an expandable `▼details` disclosure
that contains raw JSON. I can't see which tools the sub-agent actually called,
what they returned, or where in the sub-task it spent its time. When the
sub-task goes wrong, I have no signal about why. When it goes right, I have no
evidence of how.

I want the sub-agent's work to be *transparent*: every tool it calls should
appear in the chat UI as a nested, live-streaming card under the parent tool
call, rendered the same way top-level tool calls render today. I also want a
structured record of what the sub-agent did, so that a future reflection /
memory layer can learn from past delegate runs.

## Solution

Replace `do_task` with a `delegate` tool that runs an in-process sub-agent via
a nested `streamText` call. The sub-agent inherits the parent's workspace
context and tool set (minus `delegate` itself, one level only), runs in the
same Deno process, and forwards its AI SDK stream chunks back up to the
parent's UI writer through a **proxy writer** that wraps every outgoing chunk
— including any custom `data-*` events the child's tools emit — in a
`data-delegate-chunk` envelope. The chat UI renders the sub-agent's tool
calls as a nested tree under the `delegate` card, with live spinners,
checkmarks, and error states, auto-expanded while running and auto-collapsed
when complete. The parent LLM sees a compact, structured result — a
discriminated union via a `finish` termination tool, plus an outline-only
`toolsUsed` sketch for retry reasoning — preserving parent context while
still enabling downstream reflection through a separately-streamed full
ledger.

In the same change, make Friday's bundled agents (`@atlas/bundled-agents` —
`web`, `gh`, `jira`, `data_analyst`, and the rest of `bundledAgents[]`)
callable from the workspace chat as first-class AI SDK tools via a shared
`createAgentTool(atlasAgent)` factory. Each wrapped agent is added to the
workspace chat's `primaryTools` set, so the parent gets direct access and
the child inherits them automatically via the delegate's tool-set thunk.
This closes the capability gap where bundled agents were only reachable
through `do_task` → planner → FSM.

## User Stories

1. As a Friday user, I want to see every tool call the sub-agent makes as it happens, so that I have real-time visibility into what my delegated work is doing.
2. As a Friday user, I want the sub-agent's nested tool calls to render identically to top-level tool calls, so that I don't have to learn a separate visual language.
3. As a Friday user, I want the delegate card to auto-expand while the sub-agent is running, so that I don't have to click to see progress on a long-running task.
4. As a Friday user, I want the delegate card to auto-collapse when the sub-agent finishes, so that completed delegations don't dominate my scrollback.
5. As a Friday user, I want to expand a completed delegate card to inspect exactly which tools ran, with what inputs, and what outputs, so that I can understand how a result was produced.
6. As a Friday user, I want to reload the chat and see the full delegate tree reconstructed, so that delegate history is not ephemeral.
7. As a Friday user, I want to cancel a running delegate, and have the sub-agent stop promptly, so that I don't have to wait for a misfiring delegation to finish.
8. As a Friday user, I want aborted or crashed delegate runs to reload with their in-flight child tools resolved to an error state, so that I don't see ghost spinners forever after a reload.
9. As the parent LLM, I want to spawn a sub-agent with a goal and a handoff summary, so that I don't have to inline a long task into my own reasoning.
10. As the parent LLM, I want the sub-agent to return a structured result — either a success payload with my answer, or a failure payload with the reason, plus a compact outline of which tools it used — so that my context window is not polluted by sub-agent intermediate tokens yet I can still reason about partial failures.
11. As the parent LLM, I want the sub-agent to fail gracefully — returning a structured error reason and a populated outline — rather than throwing, so that I can reason about partial failures.
12. As the parent LLM, I want the sub-agent to have the same tools I do (except `delegate`), so that I can assume anything I can do, it can do.
13. As the parent LLM, I want first-class tool access to Friday's bundled agents (web, gh, jira, data_analyst, …), so that I can invoke specialist work directly without routing through the planner.
14. As the parent LLM, I want clear guidance in my system prompt ranking direct tools > `agent_*` specialists > `delegate` for arbitrary work, so that I pick the cheapest path consistently instead of defaulting to `delegate` for everything.
15. As a Friday developer, I want bundled agents wrapped uniformly via a shared `createAgentTool` factory, so that registering a new agent in `bundledAgents[]` surfaces it in the chat automatically with no per-agent plumbing.
16. As a Friday operator, I want bundled-agent tools to gate themselves off when required env keys are missing (mirroring `createWebSearchTool`), so that the LLM never picks a tool it can't run.
17. As a Friday operator, I want `delegate` to run in-process with the rest of the workspace chat, so that I don't need to tune a thread pool, RPC gateway, or separate execution stack.
18. As a future author of Friday's reflection layer, I want every delegate run's full tool ledger persisted with the chat transcript — separately from what the parent LLM sees — so that I can analyze past runs to learn patterns of success and failure without the cost of including the ledger in every future LLM turn.
19. As a future author of Friday's reflection layer, I want each ledger entry to include step index and duration, so that I can reason about temporal patterns (parallel batches, slow outliers, retry cascades) without reconstructing them from the chunk stream.
20. As a future author of Friday's reflection layer, I want the tool ledger to include inputs, outcomes (success/error), tool call IDs, and deterministic short synopses of outputs, so that reflection has consistent structure to train on.
21. As a Friday developer, I want the delegate tool to be a single file in the tools directory, following the same `tool({ description, inputSchema, execute })` factory pattern as every other tool, so that it fits into the existing tool authoring surface with no special cases.
22. As a Friday developer, I want the wire protocol to use a single `data-delegate-chunk` envelope (plus a distinct `data-delegate-ledger` terminal event), so that when AI SDK ships a new chunk type, the envelope doesn't need updating.
23. As a Friday developer, I want client-side chunk reconstruction to live in one pure reducer function, so that it's easy to unit-test without spinning up a Svelte component tree.

## Implementation Decisions

### Modules built/modified

- **New tool module:** `delegate`, authored under the conversation tools
directory alongside the existing `do_task`. Exposes a factory that takes
session context (workspace id, session id, platform models, logger, abort
signal, user id, parent writer) and a thunk resolving to the parent's
composed tool set, returning an AI SDK `tool({...})` object.
- **New shared factory:** `createAgentTool(atlasAgent, deps)` in the
workspace-chat tools directory (or a new `bundled-agent-tools.ts`).
Takes an `AtlasAgent` plus shared deps (logger, session, platformModels,
abortSignal, env, parent writer) and returns a `tool({...})` wrapper.
Tool name = `agent_<atlasAgent.metadata.id>` (e.g. `agent_web`,
`agent_gh`). Description pulled from `agent.metadata.description`.
The writer parameter flows through to the `CallbackStreamEmitter`
bridge, so agent progress events stream into the card live.
Input = `agent.inputSchema ?? z.object({ prompt: z.string() })`. Output =
the agent's `AgentPayload<TOutput>["output"]` (for `web`: `{ response }`).
Factory returns `AtlasTools` — either `{ [toolName]: tool({...}) }` or
`{}` when `agent.environmentConfig.required[]` has keys missing from the
resolved env — matching `createWebSearchTool`'s shape. Factory constructs
a `CallbackStreamEmitter` whose `emit` calls `writer.write(event)` so the
agent's `stream?.emit({ type: "data-tool-progress", ... })` calls land in
the AI SDK stream as native `data-tool-progress` parts — no mapping layer
needed (type confirmed structurally identical: `AtlasUIMessageChunk` =
`UIMessageChunk<MessageMetadata, AtlasDataEvents>`, same type
`UIMessageStreamWriter<AtlasUIMessage>.write()` accepts).
- **Workspace chat agent:** `do_task` is removed from the primary tools
spread; `delegate` is added in its place. All agents in
`bundledAgents[]` from `@atlas/bundled-agents` are wrapped via
`createAgentTool` and spread into `primaryTools`. The agent's system
prompt is updated to (a) mention `delegate` instead of `do_task`, (b)
note that bundled agents are available as `agent_*` tools, and (c)
include an explicit ranking rubric: "Prefer direct tools
(`web_search`, `gh_list_prs`, …) when they suffice. Fall back to
`agent_*` specialists for multi-step domain tasks (browsing, issue
triage, data analysis). Reserve `delegate` for arbitrary multi-step
work that doesn't map to a specialist." This prevents the LLM from
defaulting to `delegate` when a cheaper path exists.
- **`do_task` tool:** kept on disk, unreferenced from the workspace chat. A
follow-up audit will decide whether any other call sites still need it.
- **Agent SDK messages schema:** add two entries to the
`AtlasDataEventSchemas` record:
  - `delegate-chunk`: `{ delegateToolCallId, chunk }` carrying a namespaced
    AI SDK chunk *or* a synthetic `delegate-end` terminator. This is the
    live-forwarding channel the UI reducer consumes.
  - `delegate-ledger`: `{ delegateToolCallId, toolsUsed: Array<...> }`
    carrying the final structured ledger. Written exactly once per
    delegate, after the child stream completes (or in `finally` on
    abort/throw). Not read by the reducer for UI rendering; consumed by
    the future reflection layer via the persisted parts array.
- **Playground tool-call data model:** extend `ToolCallDisplay` with an
optional `children: ToolCallDisplay[]` field. No other fields change.
- **Playground reducer:** `extractToolCalls` gains a second pass that groups
`data-delegate-chunk` parts by `delegateToolCallId` and runs a small
accumulator to reconstruct each delegate's children. The accumulator
treats the `delegate-end` terminator as authoritative: any pending
children listed in it are forced to `output-error`. As a
belt-and-suspenders fallback for catastrophic crashes where `finally`
never ran, the reducer also treats **parent message `state === "done"`**
as authoritative — any delegate envelope without `delegate-end` under a
completed parent message has its pending children promoted to
`output-error` with an "interrupted" errorText. This handles hard-crash
scenarios where the process died after persistence but before the
`finally` block could write the terminator, without introducing
N-seconds staleness heuristics. `data-delegate-ledger` parts are
ignored by the UI reducer (they exist for reflection-layer consumption).

> **Postscript (2026-04-22, Task #10 closeout):** Investigation after
> shipping found the `parent.state === "done"` rule is dormant under
> current architecture. Persistence is fully batched in
> `createUIMessageStream`'s `onFinish` (`workspace-chat.agent.ts:404-462`),
> so daemon crashes mid-delegate persist nothing — there's no message to
> render and no spinners possible. AI SDK's `processUIMessageStream`
> (`node_modules/ai/dist/index.mjs:5789-5795`) reliably routes
> `data-delegate-chunk` envelopes (including `delegate-end`) into
> `state.message.parts[]`, so any successful `onFinish` includes the
> terminator and the explicit `delegate-end` rule fires correctly on
> reload. The `state === "done"` rule fires in essentially zero realistic
> cases. AI SDK v6's `validateUIMessages` also strips top-level non-schema
> fields, so `state` doesn't survive the persistence round-trip natively
> — the client-side rehydration stamp in `user-chat.svelte` is the only
> path that makes the rule reachable at all. Rule + stamp are kept as
> defense against future architecture changes that introduce incremental
> persistence; they cause no harm dormant.
- **Playground renderer:** the tool card snippet recurses for
`call.children`. New CSS rule adds indentation and a left border for the
nested list. Auto-expand behavior mirrors the existing multi-tool group
disclosure (open while any child is in-flight, collapse on completion),
gated by a `userToggledDelegates` latch so user choice is respected.

### Interfaces modified

- **`delegate` tool input:** `{ goal: string, handoff: string }`. `goal` is
what the sub-agent should accomplish; `handoff` is the distilled context
the parent wants the sub-agent to have.
- **`delegate` tool output (to the parent LLM):** a discriminated union on `ok`:
  - Success: `{ ok: true, answer: string, toolsUsed: Array<{ name: string, outcome: "success" | "error" }> }`
  - Failure: `{ ok: false, reason: string, toolsUsed: Array<{ name: string, outcome: "success" | "error" }> }`
  `answer` is the sub-agent's final assistant text (from the `finish` tool
  on success, or the final streamed text as fallback). `reason` is the
  failure explanation (from the `finish` tool on error, or the caught
  exception message as fallback). `toolsUsed` here is the **outline form**
  — just `{ name, outcome }` pairs, preserving enough signal for the
  parent LLM to reason about retry ("the `agent_web` call failed,
  `web_search` succeeded") while keeping the per-call cost bounded
  (typically <10 tokens per entry vs ~80 for the full form). The full
  structured ledger — with `toolCallId`, `input`, `summary`, `stepIndex`,
  `durationMs` — is emitted once via the `data-delegate-ledger` stream
  event and persisted alongside the chat transcript; the parent LLM does
  not see it in its message history.
- **`data-delegate-chunk` wire event:**
  `{ delegateToolCallId, chunk }` where `chunk` is either (a) a namespaced
  AI SDK v6 `UIMessageChunk` with any `toolCallId` fields prefixed by the
  delegate's own tool call ID to prevent collisions with parent siblings,
  or (b) a synthetic `{ type: "delegate-end", pendingToolCallIds: string[] }`
  terminator written by the delegate's `execute()` in a `finally` block.
- **`data-delegate-ledger` wire event (new):**
  `{ delegateToolCallId, toolsUsed: Array<{ toolCallId, name, input, outcome, summary?, stepIndex, durationMs }> }`.
  Written exactly once per delegate, after the child stream completes or
  in `finally` on abort/throw. Persisted with the chat's `parts[]` array;
  consumed by future reflection layer via direct parts traversal.
- **`ToolCallDisplay`:** adds an optional `children` array. Renderers that
  don't care about nesting can ignore it.
- **Bundled-agent tool surface:** each registered agent surfaces as a tool
  named `agent_<id>`. Input defaults to `{ prompt: string }` unless the
  agent declares its own `inputSchema`. Output matches the agent's
  declared `outputSchema` (e.g. `web` returns `{ response: string }`).
  The tool's `execute()` constructs an `AgentContext` from the call-time
  deps, sets `stream` to a `CallbackStreamEmitter` that bridges to the
  parent's `UIMessageStreamWriter` via `emit → writer.write` (see
  architectural decision), and calls `atlasAgent.execute(input, context)`.
  If the agent's `AgentPayload` is an `err`, the wrapper throws so AI SDK
  surfaces it as `tool-output-error`; success payloads pass through as
  the tool result.

### Ledger Details

The server-side ledger is built by the delegate's `execute()` while
consuming the child's stream. It exists in two forms:

**Outline form** (returned to parent LLM as part of the tool result):

| Field | Source |
|---|---|
| `name` | Tool name from `tool-call` chunk |
| `outcome` | `"success"` on `output-available`, `"error"` on `tool-output-error` |

**Full form** (emitted via `data-delegate-ledger` event, persisted with parts):

| Field | Source |
|---|---|
| `toolCallId` | Child's original AI SDK `toolCallId` (not namespaced) |
| `name` | Tool name from `tool-call` chunk |
| `input` | Parsed arguments from `tool-input-available` |
| `outcome` | `"success"` on `output-available`, `"error"` on `tool-output-error` |
| `summary` | `truncateForLedger(serializedOutput, 200)` — see below |
| `stepIndex` | `step` field from the `tool-call` chunk |
| `durationMs` | `Date.now()` delta from `input-available` to first terminal chunk |

Both forms are derived from the same in-memory accumulator; the outline is
a projection over the full ledger at emission time.

**`truncateForLedger(value, maxChars = 200)`** is a shared utility in
`@atlas/utils` (building on the existing `truncateUnicode` helper).
Behavior:
1. If `value` is a string, truncate to `maxChars` with `"…"` suffix.
2. If `value` is JSON-serializable, `JSON.stringify(value)`, truncate to `maxChars`.
3. If `value` contains `Uint8Array`, `Blob`, `ReadableStream`, or circular references, replace those nodes with `"[binary]"` / `"[stream]"` / `"[circular]"` before stringification.
4. On any serialization failure, return `"[unserializable]"`.

This guarantees every ledger entry has a deterministic, safe summary string
that reflection can train on without encountering garbage or thrown
exceptions.

### Architectural decisions

- **One-level delegation, statically enforced.** The sub-agent's tool set is
the parent's composed tool set minus `delegate`. No depth counters or
runtime recursion guards. If a future requirement emerges for deeper
trees, we can reintroduce them, but the default is flat two-tier.
- **Summary handoff, not shared history.** The sub-agent does not inherit
the parent's message history. The parent is responsible for producing a
`handoff` summary as part of its tool call. This forces the parent to
distill intent and keeps the child's context minimal.
- **In-process, single LLM turn per delegate call.** No thread pool, no
RPC, no signal router. The delegate's `execute()` awaits the child's
`streamText` to completion and returns a value the AI SDK treats like any
other tool result.
- **Compact result + full ledger out-of-band.** The tool result returned
to the parent LLM carries only `{ ok, answer|reason, toolsUsed: [{name, outcome}] }`.
The full per-call ledger (with inputs, summaries, step indices, durations)
is emitted once via a dedicated `data-delegate-ledger` stream event and
persisted alongside the chat's `parts[]`. Rationale: the full ledger is
for humans (UI, expanded disclosure) and the future reflection layer, not
for the parent LLM's next-turn reasoning. Keeping it out of the tool
result prevents ~1-2k tokens of per-delegate ledger bloat from
compounding across chat history while still preserving all data for
reflection. The outline form (name + outcome) is small enough — <10
tokens per entry — that the parent retains enough signal for retry
reasoning ("the `agent_web` call failed, `web_search` succeeded")
without incurring the cost of the full shape.
- **Proxy writer for total nesting.** The delegate rebuilds the child's
tool set by passing a *proxy* `UIMessageStreamWriter` through the tool
factory thunk. The proxy intercepts every `write()` call from either the
child's `toUIMessageStream()` or the child tools' direct custom `data-*`
writes, and wraps each chunk in a `data-delegate-chunk` envelope before
forwarding to the parent's real writer. This guarantees that everything
the child emits — AI-SDK-native or custom — lands under the delegate
card.
- **Proxy writer lifecycle is explicit.** The proxy has three defined
states: *open* (pass-through, every `write()` envelope-wraps and
forwards), *closed* (silently drops writes with a `logger.debug` for
late writes; never throws), and *merging* (inside a `.merge(stream)`
call, reads the stream and envelope-wraps each chunk before forwarding).
The transition from open → closed happens at the end of the delegate's
`execute()`, immediately after the `delegate-end` and `delegate-ledger`
envelopes are emitted. `.merge()` is implemented for symmetry — no
current tool calls it, but leaving it unimplemented would silently break
any future tool that does. The proxy's methods are a strict subset of
`UIMessageStreamWriter`, so any child tool compiled against the
interface receives a structurally-identical object.
- **Child gets an independent step budget.** The child `streamText` uses
`stopWhen: [stepCountIs(40)]` regardless of how many steps the parent has
already consumed. Notably, the parent's second stop condition
(`connectServiceSucceeded()`) is **intentionally excluded** — that
condition fires on OAuth callback completion and is tied to the
parent-turn-level credential flow. A child delegate does not have its
own OAuth context; inheriting that stop condition would let unrelated
credential events silently terminate the child's work.
- **Child gets a minimal system prompt.** The child's system prompt is NOT
the parent's full composed prompt (which includes workspace sections,
skills, integrations, resources, memory, etc.). Instead, it is a short
preamble containing the `goal` and `handoff`, plus the parent's
`datetimeMessage` and the AI SDK's auto-generated tool descriptions. The
child already inherits the parent's full tool set (minus `delegate`), so
capability access is preserved. The minimal prompt prevents the child
from behaving like the parent (e.g., attempting workspace-level reasoning
or re-delegating) and saves tokens for the actual task.
- **Child inherits parent's LLM configuration.** The child `streamText`
call uses the same `platformModels.get("conversational")` model, the same
`experimental_repairToolCall`, and the same provider options as the parent.
Rationale: anything the parent can do, the child can do identically — no
surprising behavior differences. If future workloads demand a cheaper
model tier, we can add it as an optional input field without breaking the
default.
- **Child inherits parent's full tool set unconditionally.** No
`tools?: string[]` allowlist input on `delegate`. Rationale: the child's
minimal system prompt already narrows its behavior; a per-call allowlist
would push allowlist-crafting complexity onto the parent LLM (which
would need to reason about which tools the child needs *before* invoking
it). Betting on LLM tool-selection competence under a minimal prompt.
If profiling shows the child's tool-description token overhead is a
real cost driver, a follow-up can add the optional input non-breakingly.
- **Parent prompt ranks delegation options.** The workspace-chat system
prompt is updated to explicitly rank: (1) direct tools where applicable,
(2) `agent_*` bundled specialists for named multi-step domains, (3)
`delegate` for arbitrary work that doesn't map to a specialist. This
prevents the LLM from defaulting to `delegate` for everything (which
would defeat the purpose of exposing `agent_*` as first-class tools)
and gives a consistent decision tree the parent can learn.
- **Termination via `finish` tool.** The child's tool set includes a
synthetic `finish` tool (invisible to the parent, not forwarded in
`data-delegate-chunk` envelopes). Its schema is a tagged union:
  - `{ ok: true, answer: string }` — task complete, here's the result.
  - `{ ok: false, reason: string }` — task impossible or failed, here's why.

The child's prompt instructs it to call `finish` when done. The delegate's
`execute()` inspects the child's `streamText` result for a `finish` tool
result. If found, it drives the top-level `ok`/`reason`/`answer` fields.
If the child finishes without calling `finish`, the delegate falls back to
using the final streamed text as `answer` (`ok: true`). If the child
throws, the delegate returns `ok: false` with the exception message as
`reason`. This gives the parent LLM a clean discriminated union for
structured reasoning about success vs. failure, while being resilient to
LLMs that occasionally forget explicit termination tools. (Audit
confirmed no existing tool is named `finish`, so no collision risk.)
- **Raw chunk forwarding with a single envelope type.** We chose not to
reify a richer vocabulary (e.g. `delegate-child-started` / `-finished`
events). The envelope is a thin wrapper at a system boundary — the
complexity lives in the delegate tool and the client reducer. Exception:
the `delegate-end` terminator is a synthetic chunk written by the
delegate itself, not an AI SDK chunk, to reconcile abort/crash state.
The separate `data-delegate-ledger` event is also synthetic but is a
sibling data event, not a nested envelope chunk — it does not go
through the proxy writer and is not displayed by the UI reducer.
- **Abort & reconciliation, with a client-side fallback.** The parent's
abort signal is passed directly to the child's `streamText`. The
delegate wraps the entire child stream consumption in `try/finally`.
In `finally` — whether the child completed, errored, or aborted — the
delegate:
  1. Computes the set of `toolCallId`s for which it saw
     `tool-input-available` but not a terminal chunk, and writes a
     `data-delegate-chunk` with a `delegate-end` payload listing those
     IDs. The reducer treats this envelope as authoritative: it promotes
     any listed child to `output-error` with an "interrupted" errorText.
  2. Emits the `data-delegate-ledger` event with the accumulated full
     ledger, then transitions the proxy writer to *closed* state.

  This covers abort and in-JS-process errors. For catastrophic crashes
  (OOM, SIGKILL, IDE host crash) where the `finally` block never runs,
  the client reducer has a **belt-and-suspenders rule**: when it observes
  `parent.state === "done"` on the message, any delegate envelope
  without a `delegate-end` terminator has its pending children promoted
  to `output-error` with an "interrupted" errorText. This uses a concrete
  signal (parent turn ended) rather than an N-seconds heuristic and
  requires no server-side sweep.
- **Single task per call.** The input schema does not accept a batch. If
parallel fan-out becomes a common pattern, a future extension can add a
batch signature without breaking existing calls. Until then, the AI SDK's
native parallel-tool-call protocol is sufficient for the rare case where
the parent wants two delegates at once. (Concurrent delegates are safe
because each has its own proxy writer with its own `delegateToolCallId`
closed over; envelope chunks may interleave on the wire but the reducer
groups them by ID.)
- **Graceful failure.** If the child errors (throws, or calls `finish` with
`ok: false`), the delegate's `execute()` still returns successfully with
`ok: false`, a `reason`, and a populated `toolsUsed` outline. This keeps
the failure trace visible to reflection rather than collapsing it into a
generic tool error.
- **Bundled agents exposed uniformly as `agent_*` tools.** Every
`AtlasAgent` in `@atlas/bundled-agents`'s `bundledAgents[]` export is
wrapped via the same `createAgentTool` factory and added to the
workspace chat's `primaryTools`. Rationale: (a) keeps the v2 "parent
tools ⊇ child tools" symmetry — the child gets them via the delegate's
tool-set thunk for free, (b) makes the bundled-agent registry the
single source of truth (adding to `bundledAgents[]` surfaces
automatically), (c) eliminates the planner/FSM indirection as the only
path to bundled capabilities. Tool name prefix `agent_` disambiguates
wrapped agents from lower-level tools (e.g. `agent_web` vs `web_fetch`
/ `web_search`) and signals to the LLM that these are full sub-agent
invocations, not atomic operations. Env-gating at factory time mirrors
existing practice (`createWebSearchTool` returns `{}` when no search
key is configured) — agents with unmet requirements simply aren't
registered for that turn.
- **StreamEmitter → UIMessageStreamWriter bridge included in first pass.**
The `AgentContext.stream` field (Friday's `StreamEmitter`) emits
`AtlasUIMessageChunk` values — structurally identical to what
`UIMessageStreamWriter.write()` accepts (both resolve to
`UIMessageChunk<MessageMetadata, AtlasDataEvents>`, verified in
`packages/agent-sdk/src/messages.ts:306`). The bridge is a one-liner:
a `CallbackStreamEmitter` whose `emit` calls `writer.write(event)`.
Every bundled agent already emits only `data-tool-progress` and
`data-outline-update` events (41 and 2 call sites respectively), both
of which are valid `AtlasDataEventSchemas` entries. No event-type
mapping or validation is needed. The `createAgentTool` factory
constructs this bridge at call time so the wrapped agent's progress
events flow into the AI SDK stream exactly like native tool progress.
When the agent runs inside a `delegate` child, these events
automatically nest under the delegate card via the proxy writer (no
extra work).

### Module Boundaries

**`delegate` tool**
- **Interface:** `{ goal, handoff } → { ok: true, answer, toolsUsed: [{name, outcome}] } | { ok: false, reason, toolsUsed: [{name, outcome}] }`
  (full ledger emitted out-of-band via `data-delegate-ledger`).
- **Hides:** nested `streamText` lifecycle, system prompt composition
  (minimal preamble + handoff + datetime + tool descriptions), model
  selection (= parent's), step budget (= independent `stepCountIs(40)`,
  deliberately excluding `connectServiceSucceeded()`), tool-set filtering
  (= parent minus `delegate` plus `finish`), proxy writer construction and
  lifecycle (open → merging → closed), chunk forwarding, `toolCallId`
  namespacing, ledger accumulation and dual-form projection (outline +
  full), `truncateForLedger`, abort propagation, `delegate-end`
  reconciliation, `delegate-ledger` emission, persistence tagging.
- **Trust contract:** calling `delegate` with a well-formed goal returns a
  discriminated union. `ok: true` means the child completed the task;
  `ok: false` means it failed or was impossible, with a human-readable
  `reason`. `toolsUsed` in the result is outline-only; the full ledger
  is available to reflection via the persisted `data-delegate-ledger`
  part. On abort or crash, a `delegate-end` envelope (or the client-side
  `parent.state === "done"` fallback) guarantees the persisted stream
  has no perpetually-streaming child cards on reload.

**`finish` tool (child-only)**
- **Interface:** `{ ok: true, answer: string } | { ok: false, reason: string }` → same payload
  (the tool `execute()` is identity — it just returns the input so the
  delegate can read it from `result.toolResults`).
- **Hides:** nothing. It is a pass-through tool whose sole purpose is to
  give the child LLM a structured termination signal.
- **Trust contract:** if the child calls `finish`, the delegate uses its
  payload as the authoritative result. If not, fallback to final text or
  caught error.

**`data-delegate-chunk` wire envelope**
- **Interface:** `{ delegateToolCallId, chunk }` where `chunk` is either a
  namespaced AI SDK `UIMessageChunk` or a synthetic `delegate-end`
  terminator.
- **Hides:** nothing AI-SDK-specific — deliberately a thin wrapper at the
  server-to-client boundary.
- **Trust contract:** chunks arrive in emission order per
  `delegateToolCallId`; any embedded `toolCallId` is already namespaced;
  the envelope's shape is stable across AI SDK chunk-type changes;
  exactly one `delegate-end` chunk is emitted per `delegateToolCallId`
  under the normal (non-crash) path, and it is always the final
  `data-delegate-chunk` for that delegate. On hard crash, the
  terminator may be missing; the reducer's `parent.state === "done"`
  fallback covers this case.

**`data-delegate-ledger` wire event**
- **Interface:** `{ delegateToolCallId, toolsUsed: Array<FullLedgerEntry> }`.
- **Hides:** the projection from in-memory accumulator to serialized
  ledger, `truncateForLedger` invocation, circular-reference handling.
- **Trust contract:** exactly one `delegate-ledger` event per
  `delegateToolCallId` under the normal path; not required for UI
  rendering (reducer ignores it); consumed by future reflection layer
  via direct parts traversal.

**`createAgentTool` factory (bundled-agent wrapper)**
- **Interface:** `(atlasAgent, deps) → AtlasTools` (either
  `{ [agent_<id>]: tool({...}) }` or `{}` when env requirements unmet).
- **Hides:** `AgentContext` construction, env-key resolution and gating,
  AgentPayload → tool-result unwrapping (ok → return output; err → throw
  so AI SDK surfaces `tool-output-error`), StreamEmitter → writer bridge
  construction, input-schema defaulting.
- **Trust contract:** the wrapped tool's execution semantics match
  directly invoking the bundled agent — same output shape, same env
  requirements, same abort behavior. The factory never throws at
  registration time; missing env produces an empty record, not an error.

**Playground reducer (`extractToolCalls`)**
- **Interface:** `(message) → ToolCallDisplay[]` — unchanged from today.
- **Hides:** that some tool calls arrived as forwarded envelopes requiring
  reconstruction; that `data-delegate-ledger` parts exist but are filtered
  out; that `parent.state === "done"` is used as a crash-recovery signal.
  Renderers treat `children` identically to any other field.
- **Trust contract:** partial trees are valid. If a delegate's children
  haven't all arrived yet, `children` contains whatever is accumulated so
  far; renderers must tolerate in-progress children. If a `delegate-end`
  chunk is present, any children it lists as pending are promoted to
  `output-error` with an "interrupted" errorText. If the parent message
  has reached `state: "done"` without a `delegate-end` chunk, all pending
  children under that delegate are promoted to `output-error` with an
  "interrupted" errorText.

### Schema / data

No database schema changes. Chat persistence is unchanged — the existing
opaque `parts` array round-trips the new data events through storage with
no migration needed. (AI SDK's stream processor appends every `data-*`
chunk to `state.message.parts` during streaming, and `appendMessage`
persists the final `parts[]` in `onFinish`.) Both `data-delegate-chunk`
and `data-delegate-ledger` are `data-*` parts; neither is swept by
`closePendingToolParts` (which only touches `tool-*` parts). The
reducer's client-side fallback is what handles the crash-recovery case.

## Testing Decisions

Good tests here mean tests that verify external behavior — what the parent
LLM sees, what the UI renders, what ends up persisted — not internal
plumbing like "did we call `writer.write` three times." The existing do-task
tests in the conversation tools directory are the right prior art for
server-side tool tests; the playground has component tests that are the
right prior art for UI reducer tests.

- **Delegate tool — happy path, server-side.** Given a mock `streamText`
  that produces a canned chunk sequence (text + tool-call + tool-result +
  `finish` call + final text), verify that the tool returns the expected
  `{ ok: true, answer, toolsUsed: [{name, outcome}] }`, that the expected
  `data-delegate-chunk` envelopes were written to the parent writer (with
  namespaced `toolCallId`s), that a final `delegate-end` chunk was written
  listing no pending children, and that a `data-delegate-ledger` event was
  written with the full ledger (including `toolCallId`, `stepIndex`,
  `durationMs` per entry).
- **Delegate tool — ledger outline vs full.** Given a child that calls 3
  tools, verify (a) the tool result's `toolsUsed` contains exactly
  `[{name, outcome}]` triples (no `input`, `summary`, `stepIndex`,
  `durationMs`), (b) the `data-delegate-ledger` event's `toolsUsed`
  contains all seven fields per entry, (c) both forms agree on tool
  count, names, and outcomes.
- **Delegate tool — finish-tool fallback.** Given a mock child that does NOT
  call `finish`, verify the delegate falls back to final streamed text as
  `answer` with `ok: true`.
- **Delegate tool — finish-tool failure.** Given a mock child that calls
  `finish` with `ok: false, reason: "rate limited"`, verify the delegate
  returns `ok: false, reason: "rate limited"` and both ledger forms are
  populated.
- **Delegate tool — throw fallback.** Given a mock child that throws
  mid-stream, verify the delegate returns `ok: false` with the exception
  message as `reason`, the ledger reflects whatever ran before the throw,
  a `delegate-end` envelope lists pending children, and a
  `delegate-ledger` event is still emitted with the partial ledger.
- **Proxy-writer wrapping.** Given a child tool whose `execute()` calls
  `writer.write({ type: "data-tool-progress", data: { ... } })`, verify
  the write lands on the parent writer as a
  `data-delegate-chunk { chunk: { type: "data-tool-progress", ... } }`
  envelope, not as a top-level unwrapped part.
- **Proxy-writer lifecycle — closed state.** After `execute()` returns,
  verify that late `proxy.write(...)` calls are silently dropped (no
  throw, no forward to parent writer) and that a debug log is emitted.
- **Proxy-writer lifecycle — .merge.** Given a child tool that calls
  `proxy.merge(someStream)`, verify each chunk of the merged stream is
  envelope-wrapped and forwarded to the parent writer in order.
- **Abort cascades.** When the parent's `AbortSignal` fires mid-child,
  verify (a) the child's `streamText` receives the abort, (b) the
  delegate's `finally` block writes a `delegate-end` envelope listing the
  in-flight child's `toolCallId`s, (c) the `data-delegate-ledger` event
  is written with the partial ledger, and (d) the returned
  `{ ok: false, reason, toolsUsed }` still resolves (no throw).
- **Crash fallback — reducer.** Given a persisted message with
  `state: "done"` whose parts include a `data-delegate-chunk` for an
  in-progress child but NO `delegate-end` chunk, verify the reducer
  promotes the child to `output-error` with an "interrupted" errorText.
- **Graceful-failure path.** When the child emits a `tool-output-error`,
  the delegate still returns successfully, `ok` is driven by `finish` or
  fallback, the failed call appears in `toolsUsed` with `outcome: "error"`,
  and `delegate-end` lists no pending children.
- **Tool-set filtering.** Verify that the child's `streamText` is called
  with a tool set that does not include `delegate` but does include
  `finish`.
- **Inherited config.** Verify the child `streamText` call uses the same
  model and `repairToolCall` as the parent, but an independent
  `stepCountIs(40)` budget and **does not** inherit
  `connectServiceSucceeded()`. Verify the child's system prompt is the
  minimal preamble (not the parent's full prompt).
- **Client reducer — `extractToolCalls`.** Given a message with a mix of
  top-level tool parts and `data-delegate-chunk` parts (some complete, some
  still streaming, one followed by `delegate-end`, one under a `state: done`
  parent without `delegate-end`), verify the reducer produces a
  `ToolCallDisplay[]` with correct nesting, correct in-progress states for
  partial children, correct `output-error` promotion for children listed
  as pending in `delegate-end`, correct `output-error` promotion for
  orphaned pending children under a completed parent, filtering out of
  `data-delegate-ledger` parts, and stable IDs after chunk ordering.
- **Ledger accumulation.** Given a fixture chunk sequence, verify the
  server-side full ledger (emitted via `data-delegate-ledger`) matches
  what the client-side reducer reconstructs from the same forwarded
  chunks. They should agree on tools called, ordering, `toolCallId`,
  `stepIndex`, `durationMs` (within a tolerance), and outcomes.
- **Persistence round-trip.** Persist a chat with a delegate run (clean-
  finish, aborted, and crash-simulated — where the persisted message has
  no `delegate-end` and `state: "done"` is forced on), reload, and verify
  the rendered tree matches the live-streamed tree in each case. This
  catches any reducer logic that relies on ephemeral state rather than
  the persisted `parts` array, and verifies both reconciliation paths
  (explicit `delegate-end` and implicit `parent.state === "done"`)
  survive the round trip.
- **Parent-prompt tool-ranking rubric.** Given the updated workspace-chat
  system prompt, verify the ranking text is present and correctly
  references `delegate` / `agent_*` / direct tool categories. (Snapshot
  or regex test; not a behavioral test of the LLM.)
- **Bundled-agent registration.** Given `bundledAgents[]` and an env
  with all required keys set for every agent, verify `primaryTools`
  contains a key `agent_<id>` for each entry in `bundledAgents[]`.
- **Env-gating.** Given an agent that declares a required env key and
  an env missing that key, verify the corresponding `agent_<id>` tool
  is *not* registered in `primaryTools`. Pair case: once the env key
  is set, the tool appears.
- **Wrapped-agent invocation.** Mock an `AtlasAgent.execute` that
  returns `ok({ response: "hello" })`. Verify (a) the tool returns
  `{ response: "hello" }` as the tool result, (b) the `AgentContext`
  passed in has the expected session fields and `stream` is a
  `CallbackStreamEmitter` that bridges to the writer, (c) aborting the
  parent cancels the agent call via the shared `AbortSignal`.
- **Wrapped-agent error path.** Mock an agent that returns
  `err("boom")`. Verify the tool throws such that AI SDK emits
  `tool-output-error` with the error text preserved.
- **StreamEmitter → writer bridge.** Given a wrapped agent whose
  handler calls `stream?.emit({ type: "data-tool-progress", data: {
  toolName: "Test", content: "working..." } })`, verify the event
  lands on the parent `UIMessageStreamWriter` as a `data-tool-progress`
  chunk with identical payload — structural identity, no mapping.
- **Child inherits bundled agents.** Via the delegate's tool-set
  thunk, verify the child's `streamText` call is passed a tool set
  that includes every `agent_<id>` the parent has, minus `delegate`,
  plus `finish`.

## Out of Scope

- **Multi-level recursion.** `delegate` inside `delegate` is statically
blocked. Deeper trees are not supported.
- **Batch / fan-out.** `delegate({ tasks: [...] })` is not part of this
change. Parallel delegation relies on the AI SDK's native parallel-tool-
call protocol.
- **Per-call config overrides.** No `model` / `stepBudget` / `promptMode`
input fields. Child inherits parent's configuration. Adding optional
overrides later is non-breaking.
- **Per-call tool allowlist.** No `tools?: string[]` input on `delegate`.
Child inherits parent's full tool set (minus `delegate`, plus `finish`)
unconditionally. Rationale: minimal system prompt already narrows
behavior; pushing allowlist-crafting to the parent LLM adds complexity
before there's evidence of real token-cost pain. If profiling shows
tool-description overhead matters, the input field can be added
non-breakingly later.
- **Server-side persist-time sweep for orphaned delegate envelopes.**
Plan relies on try/finally for the common path and a client-side
reducer rule (`parent.state === "done"` with no `delegate-end`
promotes pending children) for hard-crash recovery. No extension of
`closePendingToolParts` to sweep `data-delegate-chunk` parts at
persist time. Rationale: client-side fallback is a one-liner using a
concrete signal (parent turn ended) rather than an N-seconds
heuristic, and covers every case where the process survives long
enough to persist.
- **Live progress streaming from bundled agents.**
Included in first pass via the `CallbackStreamEmitter` bridge.
Agents that emit `data-tool-progress` events will have those events
appear as live progress inside the tool card. Agents that don't emit
stream events will show spinner + final result as before.
No follow-up needed — the bridge is structural identity (`AtlasUIMessageChunk`
is the same type that `UIMessageStreamWriter.write` accepts).
- **Selective bundled-agent exposure.** First pass registers every
agent in `bundledAgents[]`. No per-agent allowlist, no per-workspace
opt-in. If the LLM picks a bundled agent the user didn't want, the
answer is to unregister it from `bundledAgents[]` or (future) add a
workspace config knob — not to build selective-wiring machinery now.
- **Approval gates.** Destructive tool-call approval (OpenClaw-style) is
out of scope. Friday currently trusts all local tool execution.
- **Removing `do_task` entirely.** This change removes `do_task` from the
workspace chat agent's tool set. Other references (planner-driven
workflows, FSM action handlers) are left untouched; a follow-up pass will
audit and either remove or retain as needed.
- **LLM-generated summaries in the ledger.** `summary` is deterministic
truncation via `truncateForLedger`, not a child-LLM synopsis. Generating
structured summaries could come later if reflection demands it.
- **Programmatic Tool Calling (PTC).** The Hermes-style "scripts reach back
into the parent's tool registry from inside `run_code`" pattern is a
separate, larger effort and not part of `delegate`.
- **Result spill-to-disk with reference paths.** Also called out as a
valuable follow-up in the prior research, but orthogonal to `delegate`.
- **Web-client rendering.** UI changes for `delegate` are scoped to
`tools/agent-playground` only. The production `apps/web-client` will
not render nested delegate cards in v1; it will show `delegate` as a
standard tool call (or ignore unknown `data-*` parts gracefully). A
follow-up unification pass will port the reducer/renderer to the web-
client once the playground design stabilizes.

## Further Notes

- The research document that kicked this off
(`/Users/ericskram/Desktop/tools.md`) framed `delegate` as the smallest of
three complementary upgrades (the others being spill-to-disk and PTC).
This design is intentionally scoped to deliver `delegate` in isolation.
- Memory / reflection is the forcing function behind the full-form
`toolsUsed` ledger. The dual-form decision (outline in the tool result,
full shape via `data-delegate-ledger`) splits the "what does the LLM
see now" concern from the "what can reflection analyze later" concern
cleanly. Adding `toolCallId`, `stepIndex` and `durationMs` in the full
form now is cheap; retrofitting later requires re-parsing the persisted
chunk stream and is lossy on edge cases.
- The single-envelope wire protocol is a deliberate bet: that the coupling
cost of "two places that decode AI SDK chunks" is smaller than the drift
cost of maintaining a parallel protocol. If AI SDK v7 breaks chunk
shapes, we update the reducer. The envelope itself survives.
- An alternative considered but rejected: namespace child `toolCallId`s
as `{parentId}::{childId}` and emit them as top-level `tool-*` parts
(no envelope). This would avoid extending `AtlasDataEventSchemas` and
the reducer. Rejected because (a) it couples the reducer to a string
format, (b) it makes "which delegate is this child under?" an implicit
parse rather than an explicit field, and (c) it can't carry a
`delegate-end` terminator cleanly.
- An alternative considered but rejected: extend `closePendingToolParts`
to scan `data-delegate-chunk` parts at persist time and synthesize a
`delegate-end` when missing. Rejected because (a) the try/finally
pattern covers the overwhelming majority of lifecycle paths, (b) the
client-side `parent.state === "done"` rule is a one-liner using a
concrete signal that covers the remaining hard-crash case, and (c)
server-side sweeping adds persistence-layer complexity for a scenario
the client can handle locally.
- An alternative considered but rejected: add an optional
`tools?: string[]` input to `delegate` that narrows the child's tool
set to an allowlist. Rejected for v1 because (a) the minimal child
system prompt already narrows behavior, (b) allowlist-crafting pushes
additional reasoning onto the parent LLM which would then need to
predict which tools the child needs, (c) there's no profiling evidence
yet that tool-description token overhead is a real cost driver. The
input field can be added non-breakingly later if pain materializes.
- The proxy-writer layer is the load-bearing piece for total nesting.
Without it, any child tool that emits custom `data-*` events (today,
several do) would leak those events to the parent's top-level stream,
and the delegate card's visible tree would silently omit them. This
isn't a theoretical concern — it's the observed behavior of the
existing tool set.
- If the pre-merge audit finds `do_task` is still required elsewhere, the
fallback is to keep both tools but differentiate their descriptions
sharply — `delegate` for in-chat sub-agents, `do_task` for planner-driven
multi-agent workflows — and accept the small LLM-decision cost.
- The `agent_` prefix on wrapped bundled agents is deliberate. Without
it, `web` (wrapping `webAgent`) would collide conceptually with
`web_fetch` and `web_search`, and the LLM would have to infer from
descriptions alone whether a tool is atomic or an entire sub-agent
loop. `agent_web` communicates "this kicks off a multi-step sub-agent
run" in the name itself. Same story for `agent_gh` vs any future
fine-grained git tools.
- Wiring bundled agents as tools is additive — today the workspace
chat can only reach them through `do_task` → planner → FSM. Direct
tool access means the parent can invoke a bundled agent in one step
instead of negotiating a whole plan. This is exactly the payoff the
source research doc called out for "lightweight delegate" but scaled
across the full bundled-agent registry.
- The `finish` tool pattern is borrowed from structured-agent
termination conventions. It gives the parent LLM a clean
discriminated union (`ok`/`reason`) rather than an ambiguous empty
string on failure. The fallback paths (no `finish` called, or exception
thrown) guarantee the delegate never throws, so the parent always has a
structured payload to reason about. Audit confirmed no existing tool
is named `finish`, eliminating collision risk.
- Parent-prompt ranking of delegation options (direct tools > `agent_*`
> `delegate`) is a small but load-bearing detail. Without it, the
three overlapping paths invite inconsistent LLM choices — e.g.,
invoking `delegate` for a task `agent_web` could do in one step. The
ranking trades a few tokens of prompt for decision consistency.

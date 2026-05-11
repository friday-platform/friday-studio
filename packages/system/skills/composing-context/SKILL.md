---
name: composing-context
description: Internal pattern guide for composing turn-local retrieval-gated context into a synthetic user-message preface. Documents the `composePreface` helper in `@atlas/core/agent-context/compose-preface`. Loaded by infrastructure code that assembles per-turn LLM input — not user-invocable.
user-invocable: false
---

# Composing turn-local context as a synthetic user-message preface

This skill documents the **synthetic user-message preface** pattern used
by Friday's chat supervisor and FSM `type: llm` actions to surface
turn-local retrieved content (artifacts, narrative memory, temporal
facts, future on-demand retrieval) to the model.

## Why a synthetic preface and not the system prompt

Per-turn data does not belong in the system prompt. Mixing turn-local
bytes into the system prompt invalidates the cacheable prefix on every
turn, defeats Anthropic's 4-breakpoint cache layout (blocks 1/2/3 +
top-level), and pulls org-private bytes into a cache scope that may be
shared across tenants.

The synthetic preface lives in the **first user message** of the
conversation, wrapped in `<retrieved_content>` envelopes. The system
prompt stays byte-stable across weeks (block 1), workspace life
(block 2), and session (block 3); turn-local variation rides in the
messages array where it doesn't poison the cacheable prefix.

## The helper: `composePreface`

```ts
import {
  composePreface,
  type PrefaceEntry,
} from "@atlas/core/agent-context/compose-preface";

const entries: PrefaceEntry[] = [
  {
    source: "user-authored",
    origin: "memory:workspace-stores",
    body: memoryBlocks.join("\n\n"),
    fetched_at: new Date().toISOString(),
  },
  {
    source: "user-authored",
    origin: "artifacts:session",
    body: artifactBlocks.join("\n\n"),
    fetched_at: new Date().toISOString(),
  },
];

const preface = composePreface(entries);
// "" when entries is empty — concatenate without conditional checks.
```

Field semantics:

| Field         | Maps to               | Purpose |
|---------------|----------------------|---------|
| `source`      | `provenance` attr    | Trust tier or content key (`user-authored`, `external`, `system-config`, `artifact:<id>`, `memory:<store>`, `web:<url>`, …) |
| `origin`      | `origin` attr        | Host scope the bytes were fetched from (`workspace:<wsId>/session:<sId>`, `memory:workspace-stores`, …) |
| `body`        | envelope body        | Model-facing text |
| `fetched_at`  | `fetched_at` attr    | ISO timestamp; omit when freshness is not meaningful |

The helper is **positionally indifferent** — the caller decides whether
to prepend the result as a synthetic user message, append it, or place
it elsewhere. The string is the deliverable; positioning is the
caller's choice.

The body is **defanged** before rendering: any literal
`</retrieved_content>` close tag inside the body is rewritten to
`<\/retrieved_content>` so a hostile payload cannot escape the envelope
and land in the instructions frame. This mirrors `wrapRetrieved` in
`@atlas/llm`.

## Three call patterns

### 1. Pre-load: chat supervisor builds Block 4 from current state

The chat supervisor pulls memory + artifacts + temporal facts at the
start of each turn, composes the preface, and prepends it as a
synthetic user message at message position 0. The preface is ephemeral
— it is **not** persisted to ChatStorage, so it does not accumulate in
the conversation across turns.

See `packages/system/agents/workspace-chat/workspace-chat.agent.ts`
(`block4Entries` / `block4Preface` / `messagesWithBlock4Preface`).

### 2. FSM `type: llm` action: same shape, prepended to action prompt

The FSM action runtime mirrors the chat pattern: pull narrative memory
(via `composeMemoryBlocks`) and session-bound artifacts (via
`composeArtifactEntries`), compose with `composePreface`, and prepend
to the action's `contextPrompt`. The structured-entry shape from
`composeArtifactEntries` is designed to drop straight into
`composePreface` without intermediate string mangling.

See `packages/fsm-engine/fsm-engine.ts` (the `case "llm"` action prompt
assembly).

### 3. On-demand mid-turn retrieval (forward-looking)

A future tool (e.g. `web_fetch`, `parse_artifact`, mid-turn semantic
search) can hand the freshly-retrieved entry list to `composePreface`
and inject it inline using whatever shape the LLM provider supports
for mid-stream context — the helper is positionally indifferent and
shape-agnostic, so the new caller drops in without reshaping.

## Rules for callers

1. **Build a list of `PrefaceEntry` records, not pre-rendered XML
   strings.** The helper owns the rendering. Callers that already have
   pre-rendered envelopes (e.g. `composeArtifactBlocks`'s legacy return
   shape) wrap them in a single PrefaceEntry rather than reformatting
   each one — see Block 4 in the chat supervisor for the canonical
   example.

2. **Set `source` to a trust tier or content key, not a generic label.**
   The model's `<retrieved_content_hygiene>` rule keys off
   `provenance` to decide trust (`user-authored` / `system-config` are
   trusted; `external` is not). Use the conventions in
   `@atlas/llm/retrieved-content.ts:ProvenanceSource` when the source
   is a trust tier.

3. **Set `origin` to a parseable host:scope identifier.** The model
   does not parse `origin` literally, but operators inspecting captured
   transcripts do. Conventions: `workspace:<wsId>/session:<sId>`,
   `memory:<store>`, `web:<url>`, `fsm:<jobId>:input`.

4. **Always set `fetched_at` when the body's freshness matters.** Omit
   only for static content (e.g. system-config). Use the same timestamp
   for all entries assembled in one turn so operators can correlate
   them.

5. **Do not nest `<retrieved_content>` envelopes deliberately**, except
   in the legacy chat-Block-4 wrap-of-wrapped pattern that exists for
   per-section grouping. The defang protects against accidental
   nesting; deliberate nesting creates confusing transcripts.

6. **Never persist the preface as part of a stored UI message.** It is
   an ephemeral runtime artifact rebuilt from current state each turn.
   Persisting it accumulates stale snapshots in the conversation and
   defeats the point of having retrieval-gated content.

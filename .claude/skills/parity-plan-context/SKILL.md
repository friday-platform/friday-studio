---
name: parity-plan-context
description: "Execute tasks from the OpenClaw parity plan. Use the authoritative interface declarations inlined below — DO NOT paraphrase or reshape them. Produce adapter-pattern code against the atlas monorepo mounted at /workspace/atlas."
user-invocable: false
---

# Parity Plan Execution Context

You are executing tasks from the OpenClaw parity plan. The atlas
monorepo is mounted at `/workspace/atlas`.

**LLM agents in this workspace do not have filesystem access** — they
can only see what this skill provides. The authoritative interface
declarations are inlined below under "§ AUTHORITATIVE INTERFACE
DECLARATIONS". Use those exact declarations as `plan_citations` in
your design memo. Copy them verbatim into your files_to_create.

Do not invent, simplify, or reshape these interfaces. The plan's
shapes are load-bearing — deviations break the bucketlist-cs case
and the leapfrog guarantees.

## Phase 1a status (as of commit 2d7aa73f9)

These tasks are **DONE** and committed to the `declaw` branch.
DO NOT recreate them in any task brief — read them as existing
context if your task extends them.

- ✅ **Task 1: Interfaces** —
  `packages/agent-sdk/src/memory-adapter.ts`,
  `scratchpad-adapter.ts`, `skill-adapter.ts`. All five primary
  interfaces (`MemoryAdapter`, `NarrativeCorpus`, `RetrievalCorpus`,
  `DedupCorpus`, `KVCorpus`, `ScratchpadAdapter`, `SkillAdapter`)
  match the parity plan verbatim.
- ✅ **Task 2: Schema boundary helper** —
  `packages/agent-sdk/src/schema-boundary.ts`. `withSchemaBoundary()`
  function takes `{schema, commit, onCommit?}` and `input`, parses
  through Zod, calls commit, fires onCommit. No `as` cast (fixed in
  same commit).
- ✅ **Task 3: Streaming event types** —
  `packages/agent-sdk/src/messages.ts` extended with five new
  schemas: `memory-write`, `memory-rollback`, `scratchpad-write`,
  `skill-write`, `skill-rollback`. Wired into `AtlasDataEventSchemas`
  discriminated union.
- ✅ **15 passing tests** in
  `packages/agent-sdk/src/phase1a-interfaces.test.ts`.

These tasks are **NOT YET DONE** — fair game for new task briefs:

- ⬜ Task 4: `MdNarrativeCorpus` (first real backend, target package
  `packages/adapters-md/`)
- ⬜ Task 5: `InMemoryScratchpadAdapter` (default in-process scratchpad,
  in-sdk file)
- ⬜ Task 6: `MdSkillAdapter` (read-only list/get against existing
  bundled skills)
- ⬜ Task 7: Session bootstrap injection
  (`packages/workspace/src/runtime.ts` calls
  `MemoryAdapter.bootstrap()` and prepends to system prompt)
- ⬜ Phase 1b backends (`sqlite-rag`, `sqlite-ttl`, `sqlite` KV)
- ⬜ Bucketlist migration (the Phase 1 acceptance test)

## § AUTHORITATIVE INTERFACE DECLARATIONS (from parity plan v6)

These blocks come verbatim from
`docs/plans/2026-04-13-openclaw-parity-plan.md` lines 582-686. They
are the source of truth. If your task involves memory, scratchpad,
or skill adapters, your `files_to_create` MUST contain these exact
declarations.

### MemoryAdapter + corpus sub-interfaces
(plan lines 582-634)

```ts
// packages/agent-sdk/src/memory-adapter.ts

export interface MemoryAdapter {
  /** Open or create a named corpus. Backend resolved per-corpus from config. */
  corpus<K extends CorpusKind>(
    workspaceId: string,
    name: string,
    kind: K,
  ): Promise<CorpusOf<K>>;

  /** Enumerate corpora registered in this workspace. */
  list(workspaceId: string): Promise<CorpusMetadata[]>;

  /** Bootstrap block injected into agent system prompt at session start.
   *  A *view* over one or more narrative corpora. */
  bootstrap(workspaceId: string, agentId: string): Promise<string>;

  /** Versioned history — leapfrog dimension #2. */
  history(workspaceId: string, filter?: HistoryFilter): Promise<HistoryEntry[]>;
  rollback(workspaceId: string, corpus: string, toVersion: string): Promise<void>;
}

export type CorpusKind = "narrative" | "retrieval" | "dedup" | "kv";

export interface NarrativeCorpus {
  append(entry: NarrativeEntry): Promise<NarrativeEntry>;
  read(opts?: { since?: string; limit?: number }): Promise<NarrativeEntry[]>;
  search(query: string, opts?: SearchOpts): Promise<NarrativeEntry[]>;
  forget(id: string): Promise<void>;
  render(): Promise<string>;
}

export interface RetrievalCorpus {
  ingest(docs: DocBatch, opts?: IngestOpts): Promise<IngestResult>;
  query(q: RetrievalQuery, opts?: RetrievalOpts): Promise<Hit[]>;
  stats(): Promise<RetrievalStats>;
  reset(): Promise<void>;
}

export interface DedupCorpus {
  append(namespace: string, entry: DedupEntry, ttlHours?: number): Promise<void>;
  filter(namespace: string, field: string, values: unknown[]): Promise<unknown[]>;
  clear(namespace: string): Promise<void>;
}

export interface KVCorpus {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

Supporting types that are referenced but not yet declared in the
plan — create placeholder aliases in the same file for now, to be
filled in by later tasks:

```ts
export type CorpusOf<K extends CorpusKind> =
  K extends "narrative" ? NarrativeCorpus :
  K extends "retrieval" ? RetrievalCorpus :
  K extends "dedup" ? DedupCorpus :
  K extends "kv" ? KVCorpus :
  never;

export interface CorpusMetadata {
  name: string;
  kind: CorpusKind;
  workspaceId: string;
}

export interface NarrativeEntry {
  id: string;
  text: string;
  author?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SearchOpts { limit?: number; }
export interface DocBatch { docs: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>; }
export interface IngestOpts { chunker?: string; embedder?: string; }
export interface IngestResult { ingested: number; skipped: number; }
export interface RetrievalQuery { text: string; topK?: number; }
export interface RetrievalOpts { filter?: Record<string, unknown>; }
export interface Hit { id: string; score: number; text: string; metadata?: Record<string, unknown>; }
export interface RetrievalStats { count: number; sizeBytes: number; }
export interface DedupEntry {
  [field: string]: unknown;
}
export interface HistoryFilter {
  corpus?: string;
  since?: string;
  limit?: number;
}
export interface HistoryEntry {
  version: string;
  corpus: string;
  at: string;
  summary: string;
}
```

### ScratchpadAdapter
(plan lines 653-667)

```ts
// packages/agent-sdk/src/scratchpad-adapter.ts

import type { NarrativeEntry } from "./memory-adapter.ts";

export interface ScratchpadChunk {
  id: string;
  kind: string;
  body: string;
  createdAt: string;
}

export interface ScratchpadAdapter {
  append(sessionKey: string, chunk: ScratchpadChunk): Promise<void>;
  read(sessionKey: string, opts?: { since?: string }): Promise<ScratchpadChunk[]>;
  clear(sessionKey: string): Promise<void>;
  /** Promote a chunk into a narrative corpus. Agent-gated by config. */
  promote(
    sessionKey: string,
    chunkId: string,
    target: { workspaceId: string; corpus: string },
  ): Promise<NarrativeEntry>;
}
```

### SkillAdapter
(plan lines 673-686)

```ts
// packages/agent-sdk/src/skill-adapter.ts

import type { AgentSkill } from "./types.ts";

export interface SkillMetadata {
  name: string;
  description: string;
  version: string;
}

export interface ResolvedSkill extends AgentSkill {
  version: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  referenceFiles?: Record<string, string>;
}

export interface SkillVersion {
  version: string;
  createdAt: string;
  summary: string;
}

export interface SkillAdapter {
  list(workspaceId: string, agentId?: string): Promise<SkillMetadata[]>;
  get(workspaceId: string, name: string): Promise<ResolvedSkill | undefined>;
  create(workspaceId: string, draft: SkillDraft): Promise<ResolvedSkill>;
  update(workspaceId: string, name: string, patch: Partial<SkillDraft>): Promise<ResolvedSkill>;
  /** Versioned history — leapfrog dimension #2. */
  history(workspaceId: string, name: string): Promise<SkillVersion[]>;
  rollback(workspaceId: string, name: string, toVersion: string): Promise<ResolvedSkill>;
  invalidate(workspaceId: string): void;
}
```

`ResolvedSkill` extends the existing `AgentSkill` from
`packages/agent-sdk/src/types.ts:271` — no breaking change.

## § END AUTHORITATIVE INTERFACE DECLARATIONS

## Required reading (do this first, every task)

Use `fs_read_file` on these in order:

1. `docs/plans/2026-04-13-openclaw-parity-plan.md` — the parity plan
   itself. Find the section matching your task (§Phased implementation
   → Phase N). Read the "What Phase N does NOT do" list before you
   start; that bounds your scope.
2. `CLAUDE.md` — hard repo conventions. Zero exceptions.
3. `packages/agent-sdk/src/types.ts` — existing SDK type surface.
   Do not break these; extend them.
4. `packages/agent-sdk/src/adapter.ts` — existing adapter pattern.
   The new adapters follow the same house style.
5. `packages/agent-sdk/src/index.ts` — the export surface. New
   interfaces land here.
6. `packages/agent-sdk/src/result.ts` — `ok()` / `err()` result type.
   All adapter methods that can fail return through this.

If your task touches memory/skills/scratchpad, also read:

7. `docs/plans/2026-04-13-openclaw-parity-plan.md` §"The design" —
   the exact shape of `MemoryAdapter`, `ScratchpadAdapter`,
   `SkillAdapter` and their corpus sub-interfaces.

## Hard rules (from CLAUDE.md — zero exceptions)

These are violations that will fail review:

- **Deno + TypeScript.** Use `node:*` builtins (`node:path`,
  `node:process`), never `Deno.*` APIs — the project is migrating
  away from Deno-specific surface.
- **Zod v4 for all schemas.** `z.strictObject` for required shapes.
  Read the Zod v4 gotchas section of CLAUDE.md before writing any
  new schema.
- **No `any` types.** Use `unknown` or proper types.
- **No `as` assertions.** Exceptions: `as const` on string literals
  for discriminated unions. `!` non-null assertion is banned —
  use `?? fallback` or `if (!x) throw`.
- **Static imports only.** No `import("@pkg")` in type positions.
- **Validate all external input with Zod.**
- **Use `@atlas/logger`, never `console.*`** (except `proto/` and
  `tools/` CLI tools).
- **Dependencies in `package.json`**, not `deno.json`
  (`deno add npm:pkg`).

## Phase 1a critical path (what ships first)

Phase 1 is split into 1a (first) and 1b (after 1a validated). The
first seven units of work, in order:

1. **Interfaces** — `packages/agent-sdk/src/{memory,scratchpad,skill}-adapter.ts`.
   Pure TypeScript types. `MemoryAdapter` router + `NarrativeCorpus`
   / `RetrievalCorpus` / `DedupCorpus` / `KVCorpus` sub-interfaces.
   `ScratchpadAdapter`. `SkillAdapter`. Export from `index.ts`. No
   runtime behavior.

2. **Schema boundary helper** — `packages/agent-sdk/src/schema-boundary.ts`.
   Tiny utility wrapping every adapter write: parse input through
   Zod → commit → emit stream event → return. All backends use it.

3. **Streaming event types** — extend `AtlasDataEvents` in
   `packages/agent-sdk/src/messages.ts` with event types for
   `memory.narrative.append`, `memory.retrieval.ingest`,
   `memory.dedup.append`, `memory.kv.set`, `scratchpad.append`,
   `skill.create`. Pure schema addition.

4. **MdNarrativeCorpus** — new package `packages/adapters-md/`.
   First real backend impl. Implements `NarrativeCorpus` against
   `~/.atlas/workspaces/<id>/MEMORY.md` + `memory/YYYY-MM-DD.md`.
   Uses the schema boundary helper + streaming. Versioning via
   `.history/` snapshot dir.

5. **InMemoryScratchpadAdapter** — `packages/agent-sdk/src/inmemory-scratchpad.ts`
   (lightweight, in-sdk, no new package). Default scratchpad; ring
   buffer; zero persistence.

6. **MdSkillAdapter (read-only list/get)** — `packages/adapters-md/`.
   Reads existing `@tempest/*` skill format from the current
   registry. No `create()` yet — that's Phase 2.

7. **Session bootstrap injection** — modify
   `packages/workspace/src/runtime.ts`. Feature-flagged call to
   `MemoryAdapter.bootstrap(workspaceId, agentId)` that prepends
   the result to the agent's system prompt. Flag off by default.

Each step is a focused unit of work. Do not combine them.

## Adapter pattern house style

The existing `AgentServerAdapter` in `adapter.ts` sets the pattern:

```ts
export interface SomeAdapter {
  methodName(workspaceId: string, input: InputShape): Promise<Output>;
  // or with result type:
  methodName(workspaceId: string, input: InputShape): Promise<AgentPayload<Output>>;
}
```

- Interface with async methods
- Zod schemas for all inputs (defined in the same file or in
  `schemas/`)
- Errors returned as `err()` payloads (see `result.ts`), not thrown,
  when the error is recoverable
- Exports flow through `packages/agent-sdk/src/index.ts`
- Tests alongside source files as `*.test.ts`

## What NOT to do in Phase 1

Explicit out-of-scope items. If your task brief says to do one of
these, push back — it's not Phase 1.

- Do not touch `state_*`, `library_*`, `artifacts_*`, or `fs_*`
  platform tool implementations. Deprecation is a later phase.
- Do not build `sqlite-rag`, `sqlite-ttl`, or `sqlite` KV backends.
  Those are Phase 1b.
- Do not build `skill_create` — Phase 2.
- Do not migrate bucketlist-cs — Phase 1b.
- Do not add FridayHub bits — Phase 3, deferred.
- Do not add new MCP tools without updating `PLATFORM_TOOL_NAMES`
  in `platform-tools.ts`.
- Do not break existing `AgentSkill`, `AgentContext`, or
  `AgentMetadata` shapes — extend them.
- Do not rename `atlas` → `friday` CLI. That's a late-phase cut.

## File placement

- New interfaces → `packages/agent-sdk/src/memory-adapter.ts`,
  `scratchpad-adapter.ts`, `skill-adapter.ts`
- Schema boundary helper → `packages/agent-sdk/src/schema-boundary.ts`
- Streaming event types → extend existing `messages.ts`
- Reference impls (Phase 1a) → new package `packages/adapters-md/`
  with its own `deno.json` and `package.json`
- InMemory scratchpad → `packages/agent-sdk/src/inmemory-scratchpad.ts`
  (in-sdk because it has no deps)
- Tests → alongside source as `*.test.ts`

## Success criteria per task

Before reporting success:

1. `deno check` passes on every file you created or modified
2. `deno lint` passes
3. All new exports are visible from `@atlas/agent-sdk` via
   `index.ts`
4. No existing tests broken (`deno task test` on affected
   packages)
5. The design memo's `files_to_create` list matches exactly what
   you created — no extras, no missing files

If any of these fail, iterate before reporting. Do not report
partial success.
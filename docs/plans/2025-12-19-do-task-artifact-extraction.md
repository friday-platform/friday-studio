# do-task Artifact Extraction

**Goal:** Surface artifacts created by agents during do-task execution to the UI.

**Problem:** When conversation agent invokes `do_task`, agents like web-search create
artifacts (search results, reports) that get buried in `results[].output`. Only the
task summary artifact is returned to the UI.

---

## Design

### 1. Extraction Utility

A single function that handles heterogeneous agent output shapes.

**File:** `packages/mcp-server/src/tools/task/extract-artifacts.ts`

```typescript
import { ArtifactRefSchema, type ArtifactRef } from "@atlas/agent-sdk";
import { z } from "zod";

const OutputWithArtifactsSchema = z.object({
  artifactRef: ArtifactRefSchema.optional(),
  artifactRefs: z.array(ArtifactRefSchema).optional(),
}).passthrough();

const ResultWrapperSchema = z.object({
  ok: z.literal(true),
  data: OutputWithArtifactsSchema,
});

/**
 * Extract artifact references from heterogeneous agent outputs.
 *
 * Handles:
 * - Result wrapper: { ok: true, data: { artifactRef | artifactRefs } }
 * - Direct object: { artifactRef | artifactRefs }
 * - Singular vs plural forms
 *
 * Returns deduplicated array by artifact ID.
 */
export function extractArtifactsFromOutput(output: unknown): ArtifactRef[] {
  if (!output || typeof output !== "object") return [];

  const wrapperParse = ResultWrapperSchema.safeParse(output);
  const data = wrapperParse.success ? wrapperParse.data.data : output;

  const parse = OutputWithArtifactsSchema.safeParse(data);
  if (!parse.success) return [];

  const { artifactRef, artifactRefs = [] } = parse.data;
  const all = artifactRef ? [artifactRef, ...artifactRefs] : artifactRefs;

  const seen = new Set<string>();
  return all.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}
```

### 2. DoTaskResult Type

Add `artifacts` field to the result interface.

**File:** `packages/mcp-server/src/tools/task/do-task.ts`

```typescript
export interface DoTaskResult {
  success: boolean;
  summary?: string;
  plan?: {
    steps: Array<{ agentId?: string; description: string; executionType?: string }>;
    mcpServers: string[];
  };
  results?: Array<{
    step: number;
    agent: string;
    success: boolean;
    output?: unknown;
    error?: string;
  }>;
  error?: string;
  artifactId?: string;
  artifacts?: Array<{ id: string; type: string; summary: string }>;
}
```

### 3. Integration in executeFSMPathDirect

Collect artifacts after FSM execution, include in both success and failure returns.

```typescript
import { extractArtifactsFromOutput } from "./extract-artifacts.ts";

// After executeTaskViaFSMDirect completes:
const artifacts = executionResult.results
  .filter(r => r.success && r.output)
  .flatMap(r => extractArtifactsFromOutput(r.output));

// Include in return (both success and failure paths)
return {
  success,
  summary,
  plan: { ... },
  results: executionResult.results,
  artifacts,
  artifactId,
  error: success ? undefined : `Task failed at step ...`,
};
```

### 4. Integration in executeMVPPath

Same extraction for the MVP fallback path.

```typescript
const artifacts = results
  .filter(r => r.success && r.output)
  .flatMap(r => extractArtifactsFromOutput(r.output));

// Include in createSuccessResponse/createErrorResponse
```

---

## Agent Output Patterns Handled

| Agent | Pattern | Example |
|-------|---------|---------|
| web-search | Result wrapper, singular | `{ ok: true, data: { artifactRef: {...} } }` |
| google-calendar | Direct, plural | `{ response, artifactRefs: [...] }` |
| summary | Direct, plural | `{ artifactRefs: [...] }` |
| slack | Direct, plural | `{ response, artifactRefs: [...] }` |
| email | No artifacts | `{ response }` |
| fathom | No artifacts | `{ response }` |

---

## Result

The UI receives:
- `artifactId`: Task summary artifact (existing behavior)
- `artifacts`: All artifacts created by agents during execution

This allows the UI to render agent-produced artifacts (web search results, calendar
views, etc.) alongside the task summary.

/**
 * Query option factories + mutations for elicitations (Activity surface).
 *
 * Backend lives at `/api/elicitations` (HTTP) and `/api/elicitations/stream`
 * (SSE). Routes are in `apps/atlasd/routes/elicitations/index.ts`.
 *
 * The route file mounts handlers via non-chained `daemonFactory.createApp()`
 * calls, so the Hono RPC client can't infer types — fall back to raw fetch
 * through `/api/daemon/...` plus Zod parsing at the boundary, the same
 * pattern the schedules page uses for `/api/events`.
 *
 * @module
 */
// Import from the model-only subpath (not the umbrella mod). The umbrella
// re-exports `bootstrapElicitationsStream` from `jetstream-adapter.ts` post-L5,
// which transitively pulls `@atlas/logger` → `node:path` into client bundles
// and 500s the playground at `paths.ts`. The model module only depends on zod,
// so it bundles cleanly for browser code.
import { ElicitationSchema, type Elicitation } from "@atlas/core/elicitations/model";
import {
  createMutation,
  queryOptions,
  useQueryClient,
  type QueryClient,
} from "@tanstack/svelte-query";
import { z } from "zod";

// ==============================================================================
// SCHEMAS
// ==============================================================================

const ListResponseSchema = z.object({
  elicitations: z.array(ElicitationSchema),
  count: z.number(),
});

// ==============================================================================
// QUERY KEYS
// ==============================================================================

/**
 * Query key for elicitation list.
 *
 * `workspaceId === null` means "global" (all workspaces). The cache key
 * differs from the workspace-scoped one so the global view never shows
 * scoped data and vice-versa.
 */
export type ElicitationListKey = readonly ["daemon", "elicitations", "list", string | null];

export function elicitationListKey(workspaceId: string | null): ElicitationListKey {
  return ["daemon", "elicitations", "list", workspaceId] as const;
}

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const elicitationQueries = {
  /** Hierarchical-invalidation entry. */
  all: () => ["daemon", "elicitations"] as const,

  /**
   * List elicitations. Pass `null` for the global view (no workspaceId
   * filter). Backend supports `status` + `kind` filters but those are
   * applied client-side here so a single replay drives every filter
   * combination — small payloads (KV-backed; bounded retention).
   */
  list: (workspaceId: string | null) =>
    queryOptions({
      queryKey: elicitationListKey(workspaceId),
      queryFn: async (): Promise<Elicitation[]> => {
        const url = new URL(
          "/api/daemon/api/elicitations",
          globalThis.location?.origin ?? "http://localhost",
        );
        if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`Failed to list elicitations: ${res.status}`);
        const data: unknown = await res.json();
        return ListResponseSchema.parse(data).elicitations;
      },
      staleTime: 5_000,
      refetchInterval: 5_000,
    }),
};

// ==============================================================================
// MUTATIONS
// ==============================================================================

/**
 * POST /api/elicitations/:id/answer.
 *
 * On success we both update the relevant cache entry in place AND invalidate
 * — `setQueryData` keeps the panel snappy for the operator who clicked, and
 * the invalidation catches any other tabs/views still mounted on the same
 * data. The SSE feed (mounted by the page) will independently push the
 * updated envelope; the cache merge there is idempotent on `id`.
 */
export function useAnswerElicitation() {
  const queryClient = useQueryClient();
  return createMutation(() => ({
    mutationFn: async (input: {
      id: string;
      value: string;
      note?: string;
      answeredBy?: string;
    }): Promise<Elicitation> => {
      const { id, ...body } = input;
      const res = await fetch(`/api/daemon/api/elicitations/${encodeURIComponent(id)}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`answer failed: ${res.status} ${text}`);
      }
      return ElicitationSchema.parse(await res.json());
    },
    onSuccess: (next) => mergeAndInvalidate(queryClient, next),
  }));
}

/** POST /api/elicitations/:id/decline. */
export function useDeclineElicitation() {
  const queryClient = useQueryClient();
  return createMutation(() => ({
    mutationFn: async (input: { id: string; note?: string }): Promise<Elicitation> => {
      const { id, ...body } = input;
      const res = await fetch(`/api/daemon/api/elicitations/${encodeURIComponent(id)}/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`decline failed: ${res.status} ${text}`);
      }
      return ElicitationSchema.parse(await res.json());
    },
    onSuccess: (next) => mergeAndInvalidate(queryClient, next),
  }));
}

// ==============================================================================
// CACHE MERGE HELPERS
// ==============================================================================

/**
 * Merge a single elicitation into both the global list cache and the
 * workspace-scoped list cache (if either is mounted). Used by both mutations
 * and the SSE handler — the SSE path delivers envelopes whose status may
 * already be `answered`/`declined`/`expired`.
 *
 * Exported so the page-level SSE handler can reuse the same merge logic.
 */
export function mergeElicitationIntoCache(queryClient: QueryClient, next: Elicitation): void {
  const merge = (prev: Elicitation[] | undefined): Elicitation[] => {
    const list = prev ?? [];
    const idx = list.findIndex((e) => e.id === next.id);
    if (idx === -1) return [next, ...list];
    const copy = list.slice();
    copy[idx] = next;
    return copy;
  };
  queryClient.setQueryData<Elicitation[]>(elicitationListKey(null), merge);
  queryClient.setQueryData<Elicitation[]>(elicitationListKey(next.workspaceId), merge);
}

function mergeAndInvalidate(queryClient: QueryClient, next: Elicitation): void {
  mergeElicitationIntoCache(queryClient, next);
  void queryClient.invalidateQueries({ queryKey: elicitationQueries.all() });
}

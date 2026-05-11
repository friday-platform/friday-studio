<!--
  Shared Activity view used by both `/activity` (global) and
  `/platform/[workspaceId]/activity` (workspace-scoped).

  Two-column: filtered list on the left, detail panel on the right.

  Live updates ride the per-user firehose via the SharedWorker client —
  one EventSource per browser, fanned out by channel. The daemon does
  workspace-scope authz before publishing, so workspace and global views
  consume the same full-envelope frames.

  @component
-->

<script lang="ts">
  import {
    ElicitationKindSchema,
    ElicitationStatusSchema,
    type Elicitation,
    type ElicitationKind,
    type ElicitationStatus,
  } from "@atlas/core/elicitations/model";
  import { PageLayout } from "@atlas/ui";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { countPendingElicitations, effectiveElicitationStatus } from "$lib/elicitation-counts.ts";
  import { workspaceQueries } from "$lib/queries";
  import {
    elicitationQueries,
    mergeElicitationIntoCache,
  } from "$lib/queries/elicitation-queries.ts";
  import { subscribeToWorkspaceElicitations } from "$lib/shared-worker/client.ts";
  import ElicitationDetail from "./elicitation-detail.svelte";
  import ElicitationRow from "./elicitation-row.svelte";

  type Props = {
    /** `null` → global view (no workspaceId filter). String → scoped. */
    workspaceId: string | null;
    /** Title shown at the top of the page. */
    title: string;
  };

  let { workspaceId, title }: Props = $props();

  const queryClient = useQueryClient();

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  const listQuery = createQuery(() => elicitationQueries.list(workspaceId));
  const elicitations = $derived<Elicitation[]>(listQuery.data ?? []);

  // Workspace list — drives the workspace filter dropdown on the
  // global view. Scoped view doesn't render the dropdown so the query
  // is just unused there; TanStack dedupes against the sidebar's copy
  // so this is essentially free.
  const workspacesQuery = createQuery(() => workspaceQueries.enriched());
  const workspaceOptions = $derived(workspacesQuery.data ?? []);

  // ---------------------------------------------------------------------------
  // Live tick — drives the countdown + lazy-expired status
  // ---------------------------------------------------------------------------
  let nowMs = $state<number>(Date.now());
  $effect(() => {
    if (!browser) return;
    const t = setInterval(() => {
      nowMs = Date.now();
    }, 1_000);
    return () => clearInterval(t);
  });

  // ---------------------------------------------------------------------------
  // SSE subscription (replay-then-subscribe; same shape as /schedules)
  // ---------------------------------------------------------------------------
  $effect(() => {
    if (!browser) return;
    if (!listQuery.isSuccess) return;

    if (!workspaceId) return;

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const elicitation of subscribeToWorkspaceElicitations(workspaceId, {
          signal: controller.signal,
        })) {
          mergeElicitationIntoCache(queryClient, elicitation);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Workspace elicitations stream errored", error);
      }
    })();
    return () => controller.abort();
  });

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------
  // `all` is a UI-only sentinel — the underlying schemas only enumerate
  // the four canonical statuses + kinds.
  type StatusFilter = ElicitationStatus | "all";
  type KindFilter = ElicitationKind | "all";

  let statusFilter = $state<StatusFilter>("pending");
  let kindFilter = $state<KindFilter>("all");
  // Only meaningful on the global view. On scoped view this is forced
  // to the route's workspaceId via the prop; the dropdown isn't rendered.
  let workspaceFilter = $state<string>("all");

  // Effective expiry-aware status, matches what the row component shows.
  function effectiveStatus(e: Elicitation): ElicitationStatus {
    return effectiveElicitationStatus(e, nowMs);
  }

  const filtered = $derived.by(() => {
    return (
      elicitations
        .filter((e) => statusFilter === "all" || effectiveStatus(e) === statusFilter)
        .filter((e) => kindFilter === "all" || e.kind === kindFilter)
        .filter((e) => workspaceFilter === "all" || e.workspaceId === workspaceFilter)
        // Most recent first, but pending floats to the top so the operator
        // sees actionable rows without scrolling.
        .sort((a, b) => {
          const ap = effectiveStatus(a) === "pending" ? 0 : 1;
          const bp = effectiveStatus(b) === "pending" ? 0 : 1;
          if (ap !== bp) return ap - bp;
          return b.createdAt.localeCompare(a.createdAt);
        })
    );
  });

  // ---------------------------------------------------------------------------
  // Selection — id is component-local state
  // ---------------------------------------------------------------------------
  let selectedId = $state<string | null>(null);
  const requestedElicitationId = $derived(page.url.searchParams.get("elicitationId"));
  let appliedRequestedId = "";

  $effect(() => {
    const id = requestedElicitationId;
    if (!id || id === appliedRequestedId) return;
    const target = elicitations.find((e) => e.id === id);
    if (!target) return;
    selectedId = id;
    appliedRequestedId = id;

    const targetStatus = effectiveStatus(target);
    if (statusFilter !== "all" && statusFilter !== targetStatus) statusFilter = targetStatus;
    if (kindFilter !== "all" && kindFilter !== target.kind) kindFilter = target.kind;
    if (!workspaceId && workspaceFilter !== "all" && workspaceFilter !== target.workspaceId) {
      workspaceFilter = target.workspaceId;
    }
  });

  // Auto-select first row if nothing's selected (or selection was filtered out).
  $effect(() => {
    if (filtered.length === 0) {
      selectedId = null;
      return;
    }
    if (!selectedId || !filtered.some((e) => e.id === selectedId)) {
      selectedId = filtered[0]?.id ?? null;
    }
  });

  const selected = $derived<Elicitation | null>(
    selectedId ? (elicitations.find((e) => e.id === selectedId) ?? null) : null,
  );

  // ---------------------------------------------------------------------------
  // Filter option lists — kept stable to avoid re-renders inside <select>
  // ---------------------------------------------------------------------------
  // Filter option lists are derived from the model's Zod enums so the
  // UI stays in lockstep with new statuses/kinds without a hand-maintained
  // list — adding a new ElicitationKind to the model lights it up here
  // automatically.
  const STATUS_LABELS: Record<ElicitationStatus, string> = {
    pending: "Pending",
    answered: "Answered",
    declined: "Declined",
    expired: "Expired",
  };
  const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
    { value: "all", label: "All" },
    ...ElicitationStatusSchema.options.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
  ];
  const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
    { value: "all", label: "All kinds" },
    ...ElicitationKindSchema.options.map((k) => ({ value: k, label: k })),
  ];

  function counts(): { pending: number; total: number } {
    return { pending: countPendingElicitations(elicitations, nowMs), total: elicitations.length };
  }
  const summary = $derived(counts());
</script>

<PageLayout.Root>
  <PageLayout.Title>{title}</PageLayout.Title>
  <PageLayout.Body>
    <PageLayout.Content>
      {#if listQuery.isLoading}
        <div class="empty"><p>Loading activity…</p></div>
      {:else if listQuery.isError}
        <div class="empty">
          <p>Failed to load activity.</p>
          <span class="empty-hint">{listQuery.error?.message ?? "Unknown error"}</span>
        </div>
      {:else}
        <div class="filters">
          <label class="filter">
            <span class="filter-label">Status</span>
            <select bind:value={statusFilter}>
              {#each STATUS_OPTIONS as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </label>
          <label class="filter">
            <span class="filter-label">Kind</span>
            <select bind:value={kindFilter}>
              {#each KIND_OPTIONS as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </label>
          {#if workspaceId === null}
            <label class="filter">
              <span class="filter-label">Workspace</span>
              <select bind:value={workspaceFilter}>
                <option value="all">All workspaces</option>
                {#each workspaceOptions as ws (ws.id)}
                  <option value={ws.id}>{ws.displayName}</option>
                {/each}
              </select>
            </label>
          {/if}
          <span class="counts">
            {summary.pending} pending · {summary.total} total
          </span>
        </div>

        {#if filtered.length === 0}
          <div class="empty">
            <p>No elicitations match the current filters.</p>
            {#if elicitations.length === 0}
              <span class="empty-hint">
                Elicitations are raised by FSM jobs (tool-allowlist denials, auth-refresh prompts,
                destructive-action confirmations) and by the <code>request_human_input</code>
                platform tool.
              </span>
            {/if}
          </div>
        {:else}
          <div class="split">
            <div class="list" role="listbox" aria-label="Elicitations">
              {#each filtered as e (e.id)}
                <ElicitationRow
                  elicitation={e}
                  selected={e.id === selectedId}
                  {nowMs}
                  onselect={(id) => (selectedId = id)}
                />
              {/each}
            </div>
            <div class="detail">
              {#if selected}
                {#key selected.id}
                  <ElicitationDetail elicitation={selected} {nowMs} />
                {/key}
              {:else}
                <div class="empty">
                  <p>Select an elicitation.</p>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      {/if}
    </PageLayout.Content>
  </PageLayout.Body>
</PageLayout.Root>

<style>
  .filters {
    align-items: end;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
    margin-block-end: var(--size-3);
    padding-block-end: var(--size-3);
  }

  .filter {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .filter-label {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .filter select {
    background-color: var(--surface, white);
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font: inherit;
    min-inline-size: 8rem;
    padding: var(--size-1) var(--size-2);
  }

  .counts {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
    margin-inline-start: auto;
    padding-block-end: var(--size-1);
  }

  .split {
    column-gap: var(--size-4);
    display: grid;
    grid-template-columns: minmax(20rem, 1fr) minmax(24rem, 1.4fr);
    min-block-size: 0;
  }

  .list {
    border-inline-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding-inline-end: var(--size-2);
  }

  .detail {
    overflow-y: auto;
  }

  .empty {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-12) 0;
    text-align: center;
  }

  .empty-hint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    max-inline-size: 36rem;
  }

  .empty-hint code {
    font-family: monospace;
  }
</style>

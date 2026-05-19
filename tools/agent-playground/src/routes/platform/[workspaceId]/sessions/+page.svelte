<script lang="ts">
  import { extractInitialStateIds, filterNoiseNodes } from "@atlas/config/pipeline-utils";
  import { deriveTopology } from "@atlas/config/topology";
  import { PageLayout } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import SessionProgressCard from "$lib/components/session/session-progress-card.svelte";
  import { sessionQueries, workspaceQueries } from "$lib/queries";

  const workspaceId = $derived(page.params.workspaceId ?? null);

  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));

  const workspaceName = $derived(configQuery.data?.config?.workspace?.name ?? workspaceId ?? "");
  const crumbs = $derived(
    workspaceId
      ? [
          { label: workspaceName, href: `/platform/${workspaceId}` },
          { label: "Runs" },
        ]
      : [{ label: "Runs" }],
  );
  const sessions = createQuery(() => ({
    ...sessionQueries.list(workspaceId),
    refetchInterval: 5_000,
  }));

  /** Topology for session progress cards. */
  const topology = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return null;
    const raw = deriveTopology(data.config);
    const initialIds = extractInitialStateIds(data.config);
    return filterNoiseNodes(raw, initialIds);
  });

  /** Jobs that are internal plumbing — hide from the runs list. */
  const HIDDEN_JOBS = new Set(["handle-chat"]);

  const sortedSessions = $derived.by(() => {
    const data = (sessions.data ?? []).filter((s) => !HIDDEN_JOBS.has(s.jobName));
    const active = data.filter((s) => s.status === "active");
    const rest = data.filter((s) => s.status !== "active");
    return [...active, ...rest];
  });
</script>

<PageLayout.Root>
  <PageLayout.Breadcrumbs {crumbs} />
  <PageLayout.Body>
    <PageLayout.Content>
  {#if !workspaceId}
    <div class="empty-state">
      <p>No workspace selected</p>
    </div>
  {:else if sessions.isPending || configQuery.isLoading}
    <div class="empty-state">
      <p>Loading runs...</p>
    </div>
  {:else if sessions.isError}
    <div class="empty-state">
      <p>Failed to load runs</p>
    </div>
  {:else if sortedSessions.length === 0}
    <div class="empty-state">
      <p>No runs yet</p>
      <span class="empty-hint">Trigger a signal or click Run on a job to start one</span>
    </div>
  {:else if topology}
    <div class="session-list">
      {#each sortedSessions as session (session.sessionId)}
        <SessionProgressCard {session} {topology} {workspaceId} />
      {/each}
    </div>
  {:else}
    <div class="empty-state">
      <p>Loading workspace config...</p>
    </div>
  {/if}
    </PageLayout.Content>
  </PageLayout.Body>
</PageLayout.Root>

<style>
  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-16) 0;

    p {
      font-size: var(--font-size-4);
    }
  }

  .empty-hint {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .session-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }
</style>

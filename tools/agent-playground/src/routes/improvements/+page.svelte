<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import {
    loadImprovements,
    acceptBacklogEntry,
    rejectBacklogEntry,
    acceptNotesEntry,
    rejectNotesEntry,
    dismissNotesEntry,
    type ImprovementEntry,
  } from "$lib/improvements/improvements-loader.ts";
  import type { WorkspaceGroup } from "$lib/improvements/types.ts";
  import {
    acceptFinding,
    rejectFinding,
    dismissFinding,
    rollbackFinding,
  } from "$lib/improvements/apply-action.ts";
  import { workspaceQueries } from "$lib/queries";
  import FindingCard from "$lib/improvements/finding-card.svelte";
  import { z } from "zod";

  const PROXY_BASE = "/api/daemon";

  const queryClient = useQueryClient();

  const workspacesQuery = createQuery(() => workspaceQueries.list());
  const workspaceIds = $derived(
    (workspacesQuery.data ?? []).map((ws) => ws.id),
  );

  const findingsQuery = createQuery(() => ({
    queryKey: ["improvements", "findings", ...workspaceIds] as const,
    queryFn: () => loadImprovements(workspaceIds),
    enabled: workspaceIds.length > 0,
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  }));

  const groups: WorkspaceGroup[] = $derived(findingsQuery.data ?? []);
  const totalCount = $derived(
    groups.reduce(
      (sum, ws) => sum + ws.jobs.reduce((jSum, j) => jSum + j.findings.length, 0),
      0,
    ),
  );

  let pendingAction = $state<string | undefined>(undefined);

  const ConfigResponseSchema = z.object({
    config: z.unknown(),
  }).passthrough();

  const workspaceConfigMap = $state(new Map<string, string>());

  $effect(() => {
    for (const wsGroup of groups) {
      const needsConfig = wsGroup.jobs.some((job) =>
        job.findings.some((f) => f.proposedFullConfig),
      );
      if (needsConfig && !workspaceConfigMap.has(wsGroup.workspaceId)) {
        void fetchWorkspaceConfig(wsGroup.workspaceId);
      }
    }
  });

  async function fetchWorkspaceConfig(wsId: string): Promise<void> {
    try {
      const res = await globalThis.fetch(
        `${PROXY_BASE}/api/workspaces/${encodeURIComponent(wsId)}/config`,
      );
      if (!res.ok) return;
      const data: unknown = await res.json();
      const parsed = ConfigResponseSchema.safeParse(data);
      if (!parsed.success) return;
      workspaceConfigMap.set(wsId, JSON.stringify(parsed.data.config, null, 2));
    } catch {
      /* ignore — config fetch is best-effort */
    }
  }

  type Action = "accept" | "reject" | "dismiss" | "rollback";

  async function handleAction(action: Action, finding: ImprovementEntry): Promise<void> {
    pendingAction = finding.id;
    try {
      // Backlog findings are just autopilot-backlog entries with auto_apply:
      // false. Accept flips auto_apply to true so the planner picks them up;
      // Reject writes a status: rejected entry; Dismiss is a no-op append
      // that's equivalent to reject for now. No /api/improvements route —
      // everything round-trips through the existing memory narrative routes.
      if (finding.source === "backlog") {
        if (action === "accept") {
          await acceptBacklogEntry(finding.id);
        } else if (action === "reject" || action === "dismiss") {
          await rejectBacklogEntry(finding.id);
        }
        // rollback is a no-op for backlog-sourced findings — they haven't
        // been applied yet.
      } else if (finding.source === "notes") {
        // Notes-sourced findings round-trip through the memory narrative
        // route (append a new entry with status: accepted|rejected|dismissed).
        // The /api/improvements/* routes only exist for lifecycle findings.
        if (action === "accept") {
          await acceptNotesEntry(finding.workspaceId, finding);
        } else if (action === "reject") {
          await rejectNotesEntry(finding.workspaceId, finding);
        } else if (action === "dismiss") {
          await dismissNotesEntry(finding.workspaceId, finding);
        }
        // rollback is a no-op for notes-sourced findings — same reason.
      } else {
        // Lifecycle findings go through the apply-action pipeline
        // (POST /api/improvements/...).
        if (action === "accept") {
          await acceptFinding(finding.id, finding.workspaceId, finding.body);
        } else if (action === "reject") {
          await rejectFinding(finding.id, finding.workspaceId);
        } else if (action === "rollback") {
          await rollbackFinding(finding.id, finding.workspaceId);
        } else {
          await dismissFinding(finding.id, finding.workspaceId);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["improvements"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Improvement action "${action}" failed:`, msg);
    } finally {
      pendingAction = undefined;
    }
  }

  async function handleDismissAll(wsGroup: WorkspaceGroup): Promise<void> {
    for (const job of wsGroup.jobs) {
      for (const finding of job.findings) {
        if (finding.source === "backlog") {
          await rejectBacklogEntry(finding.id);
        } else if (finding.source === "notes") {
          await dismissNotesEntry(finding.workspaceId, finding);
        } else {
          await dismissFinding(finding.id, finding.workspaceId);
        }
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["improvements"] });
  }
</script>

<div class="improvements-root">
  <header class="page-header">
    <h1>Improvements</h1>
    <p class="subtitle">
      Pending improvement findings across workspaces
      {#if totalCount > 0}
        <span class="count-badge">{totalCount}</span>
      {/if}
    </p>
  </header>

  {#if workspacesQuery.isLoading || findingsQuery.isLoading}
    <div class="loading">Loading findings…</div>
  {:else if findingsQuery.error}
    <div class="error-banner">
      <span>Failed to load findings: {findingsQuery.error.message}</span>
      <button class="dismiss" onclick={() => findingsQuery.refetch()}>Retry</button>
    </div>
  {:else if groups.length === 0}
    <div class="empty">No pending improvement findings.</div>
  {:else}
    <div class="groups">
      {#each groups as wsGroup (wsGroup.workspaceId)}
        <section class="workspace-section">
          <div class="ws-header">
            <h2 class="ws-heading">{wsGroup.workspaceId}</h2>
            <button
              class="btn-dismiss-all"
              onclick={() => handleDismissAll(wsGroup)}
            >
              Dismiss All
            </button>
          </div>

          {#each wsGroup.jobs as jobGroup (jobGroup.targetJobId)}
            <div class="job-section">
              <h3 class="job-heading">{jobGroup.targetJobId}</h3>
              <div class="findings-list">
                {#each jobGroup.findings as finding (finding.id)}
                  <FindingCard
                    {finding}
                    currentConfig={workspaceConfigMap.get(wsGroup.workspaceId)}
                    onaction={(a) => handleAction(a, finding)}
                    disabled={pendingAction === finding.id}
                  />
                {/each}
              </div>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .improvements-root {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    margin-inline: auto;
    max-inline-size: 800px;
    padding: var(--size-10) var(--size-6);
  }

  .page-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .page-header h1 {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-7);
  }

  .subtitle {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
  }

  .count-badge {
    background: color-mix(in srgb, var(--color-warning, #f59e0b), transparent 80%);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    padding: 0 var(--size-1-5);
  }

  .loading,
  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    padding: var(--size-6);
    text-align: center;
  }

  .error-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-error, #ef4444), transparent 90%);
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
    padding: var(--size-3) var(--size-4);
  }

  .error-banner span {
    color: var(--color-text);
    font-size: var(--font-size-2);
  }

  .dismiss {
    background: none;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2);
  }

  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--size-8);
  }

  .workspace-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .ws-header {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    justify-content: space-between;
    padding-block-end: var(--size-2);
  }

  .ws-heading {
    font-family: var(--font-mono);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
  }

  .btn-dismiss-all {
    background: none;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2);
  }

  .btn-dismiss-all:hover {
    background: var(--color-surface-3);
    color: var(--color-text);
  }

  .job-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .job-heading {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-family: var(--font-mono);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .findings-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }
</style>

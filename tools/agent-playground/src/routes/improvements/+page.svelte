<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import {
    loadImprovements,
    type ImprovementEntry,
    type ImprovementGroup,
  } from "$lib/improvements/improvements-loader.ts";
  import {
    acceptFinding,
    rejectFinding,
    dismissFinding,
  } from "$lib/improvements/apply-action.ts";
  import { computeUnifiedDiff, parseDiffStats } from "$lib/improvements/diff-renderer.ts";
  import { workspaceQueries } from "$lib/queries";

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

  const groups: ImprovementGroup[] = $derived(findingsQuery.data ?? []);
  const totalCount = $derived(
    groups.reduce((sum, g) => sum + g.findings.length, 0),
  );

  let pendingAction = $state<string | undefined>(undefined);

  function getDiff(finding: ImprovementEntry): string {
    if (!finding.beforeYaml) return finding.body;
    return computeUnifiedDiff(finding.beforeYaml, finding.body);
  }

  function getDiffBadge(finding: ImprovementEntry): string {
    const diff = getDiff(finding);
    if (!diff) return "";
    const stats = parseDiffStats(diff);
    return `+${stats.additions} / -${stats.deletions}`;
  }

  type Action = "accept" | "reject" | "dismiss";

  async function handleAction(action: Action, finding: ImprovementEntry): Promise<void> {
    pendingAction = finding.id;
    try {
      if (action === "accept") {
        await acceptFinding(finding.id, finding.workspaceId, finding.body);
      } else if (action === "reject") {
        await rejectFinding(finding.id, finding.workspaceId);
      } else {
        await dismissFinding(finding.id, finding.workspaceId);
      }
      await queryClient.invalidateQueries({ queryKey: ["improvements"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Improvement action "${action}" failed:`, msg);
    } finally {
      pendingAction = undefined;
    }
  }

  async function handleDismissAll(group: ImprovementGroup): Promise<void> {
    for (const finding of group.findings) {
      await dismissFinding(finding.id, finding.workspaceId);
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
      {#each groups as group (group.workspaceId + "::" + group.targetJobId)}
        <section class="workspace-section">
          <div class="ws-header">
            <h2 class="ws-heading">{group.workspaceId}</h2>
            <button
              class="btn btn-dismiss-all"
              onclick={() => handleDismissAll(group)}
            >
              Dismiss All
            </button>
          </div>

          <h3 class="job-heading">{group.targetJobId}</h3>

          <div class="findings-list">
            {#each group.findings as finding (finding.id)}
              <article class="finding-card">
                <header class="card-header">
                  <span class="job-badge">{finding.targetJobId}</span>
                  <time class="timestamp">{finding.createdAt}</time>
                  {#if finding.beforeYaml}
                    <span class="diff-stats">{getDiffBadge(finding)}</span>
                  {/if}
                </header>

                {#if finding.text}
                  <p class="rationale">{finding.text}</p>
                {/if}

                <div class="diff-container">
                  <pre class="diff">{getDiff(finding)}</pre>
                </div>

                <footer class="card-actions">
                  <button
                    class="btn btn-accept"
                    disabled={pendingAction === finding.id}
                    onclick={() => handleAction("accept", finding)}
                  >
                    Accept
                  </button>
                  <button
                    class="btn btn-reject"
                    disabled={pendingAction === finding.id}
                    onclick={() => handleAction("reject", finding)}
                  >
                    Reject
                  </button>
                  <button
                    class="btn btn-dismiss"
                    disabled={pendingAction === finding.id}
                    onclick={() => handleAction("dismiss", finding)}
                  >
                    Dismiss
                  </button>
                </footer>
              </article>
            {/each}
          </div>
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

  .finding-card {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-4);
  }

  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .job-badge {
    background: var(--color-surface-3);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    padding: 1px var(--size-1-5);
  }

  .timestamp {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .diff-stats {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
  }

  .rationale {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
    line-height: 1.5;
  }

  .diff-container {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    max-block-size: 300px;
    overflow: auto;
  }

  .diff {
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    line-height: 1.6;
    margin: 0;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-all;
  }

  .card-actions {
    display: flex;
    gap: var(--size-2);
    justify-content: flex-end;
  }

  .btn {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-1) var(--size-3);
    transition: background 100ms ease;
  }

  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .btn-accept {
    background: color-mix(in srgb, var(--color-success, #22c55e), transparent 85%);
    color: var(--color-text);
  }

  .btn-accept:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-success, #22c55e), transparent 75%);
  }

  .btn-reject {
    background: color-mix(in srgb, var(--color-error, #ef4444), transparent 85%);
    color: var(--color-text);
  }

  .btn-reject:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-error, #ef4444), transparent 75%);
  }

  .btn-dismiss {
    background: none;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .btn-dismiss:hover:not(:disabled) {
    background: var(--color-surface-3);
    color: var(--color-text);
  }
</style>

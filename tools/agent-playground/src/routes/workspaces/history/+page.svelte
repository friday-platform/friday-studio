<script lang="ts">
  import type { Client } from "$lib/client.ts";
  import { getClient } from "$lib/client.ts";
  import type { InferResponseType } from "hono/client";

  type RunsEndpoint = Client["api"]["workspace"]["runs"]["$get"];
  type RunsResponse = InferResponseType<RunsEndpoint>;
  type Run = RunsResponse["runs"][number];

  let runs = $state<Run[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /**
   * Parse a timestamp from the run slug prefix.
   * Slugs are formatted as `2026-03-02T12-34-56-prompt-text`.
   */
  function parseTimestamp(slug: string): string {
    // Extract the ISO-ish prefix: "2026-03-02T12-34-56"
    const match = slug.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (!match) return slug;
    const [, date, h, m, s] = match;
    return new Date(`${date}T${h}:${m}:${s}`).toLocaleString();
  }

  /**
   * Extract the prompt portion from a run slug (everything after the timestamp prefix).
   */
  function parsePrompt(slug: string): string {
    // Remove timestamp prefix "2026-03-02T12-34-56-"
    const stripped = slug.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-?/, "");
    return stripped.replace(/-/g, " ") || "(untitled)";
  }

  async function fetchRuns() {
    loading = true;
    error = null;
    try {
      const res = await getClient().api.workspace.runs.$get();
      if (!res.ok) {
        error = `Failed to load runs (HTTP ${res.status})`;
        return;
      }
      const data = await res.json();
      runs = data.runs;
    } catch {
      error = "Failed to load runs";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    fetchRuns();
  });
</script>

<div class="history-page">
  <header class="page-header">
    <h1>History</h1>
  </header>

  <div class="page-content">
    {#if loading}
      <p class="status-text">Loading runs...</p>
    {:else if error}
      <p class="status-text error">{error}</p>
    {:else if runs.length === 0}
      <div class="empty-state">
        <p class="empty-title">No runs yet</p>
        <p class="empty-description">Execute a workspace pipeline to see results here.</p>
      </div>
    {:else}
      <ul class="run-list">
        {#each runs as run (run.slug)}
          <li>
            <a href="/workspaces?run={encodeURIComponent(run.slug)}" class="run-card">
              <div class="run-header">
                <span class="run-prompt">{parsePrompt(run.slug)}</span>
                <span class="run-tags">
                  {#if run.source === "loaded"}
                    <span class="run-source">Loaded</span>
                  {/if}
                  <span class="run-status" class:run-error={run.hasErrors}>
                    {run.hasErrors ? "Failed" : "Success"}
                  </span>
                </span>
              </div>
              <div class="run-meta">
                <span class="run-timestamp">{parseTimestamp(run.slug)}</span>
                <span class="run-summary">{run.summary}</span>
              </div>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .history-page {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .page-header {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    padding-block: var(--size-4);
    padding-inline: var(--size-5);

    h1 {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-6);
    }
  }

  .page-content {
    flex: 1;
    overflow-y: auto;
    padding-block: var(--size-4);
    padding-inline: var(--size-5);
  }

  .status-text {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
  }

  .status-text.error {
    color: var(--color-danger, #ef4444);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding-block: var(--size-8);
    text-align: center;
  }

  .empty-title {
    color: var(--color-text);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
  }

  .empty-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
  }

  .run-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .run-card {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3) var(--size-4);
    transition: border-color 100ms ease;
  }

  .run-card:hover {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .run-header {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
  }

  .run-prompt {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-tags {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-1);
  }

  .run-source {
    border-radius: var(--radius-1);
    flex-shrink: 0;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-2);
    background-color: color-mix(in srgb, #3b82f6, transparent 85%);
    color: #3b82f6;
  }

  .run-status {
    border-radius: var(--radius-1);
    flex-shrink: 0;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-2);

    /* success default */
    background-color: color-mix(in srgb, #22c55e, transparent 85%);
    color: #22c55e;
  }

  .run-status.run-error {
    background-color: color-mix(in srgb, #ef4444, transparent 85%);
    color: #ef4444;
  }

  .run-meta {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-3);
  }

  .run-timestamp {
    flex-shrink: 0;
  }

  .run-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

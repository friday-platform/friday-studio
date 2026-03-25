<script lang="ts">
  /**
   * Stats bar and trace inspector panel.
   * Shows execution stats after completion and expandable trace entries
   * for each LLM call with token usage and timing details.
   */
  import { Collapsible, IconSmall } from "@atlas/ui";
  import type { DoneStats, TraceEntry } from "$lib/server/lib/sse.ts";

  /** Shape of trace entries as received from SSE (TraceEntry + known extras). */
  type TraceData = TraceEntry & {
    modelId?: string;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  };

  type Props = { traces: TraceData[]; stats: DoneStats | null };

  let { traces, stats }: Props = $props();

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatTokens(n: number): string {
    return n.toLocaleString();
  }

  /** Extract model short name from "provider:model" format. */
  function shortModel(name: string): string {
    const parts = name.split(":");
    return parts.length > 1 ? parts[parts.length - 1] : name;
  }
</script>

{#if stats}
  <div class="stats-bar">
    <div class="stat">
      <span class="stat-label">Duration</span>
      <span class="stat-value">{formatDuration(stats.durationMs)}</span>
    </div>
    {#if stats.totalTokens}
      <div class="stat">
        <span class="stat-label">Tokens</span>
        <span class="stat-value">{formatTokens(stats.totalTokens)}</span>
      </div>
    {/if}
    {#if stats.stepCount}
      <div class="stat">
        <span class="stat-label">Steps</span>
        <span class="stat-value">{stats.stepCount}</span>
      </div>
    {/if}
    {#if traces.length > 0}
      <div class="stat">
        <span class="stat-label">LLM Calls</span>
        <span class="stat-value">{traces.length}</span>
      </div>
    {/if}
  </div>
{/if}

{#if traces.length > 0}
  <div class="trace-list">
    {#each traces as trace, i (trace.spanId)}
      <div class="trace-entry">
        <Collapsible.Root>
          <Collapsible.Trigger size="grow">
            {#snippet children(open)}
              <span class="trace-header">
                <span class="trace-chevron" class:expanded={open}>
                  <IconSmall.CaretRight />
                </span>
                <span class="trace-step">#{i + 1}</span>
                <span class="trace-name">{shortModel(trace.name)}</span>
                <span class="trace-meta">
                  {#if trace.usage}
                    <span class="trace-tokens">{formatTokens(trace.usage.totalTokens)} tok</span>
                  {/if}
                  <span class="trace-duration">{formatDuration(trace.durationMs)}</span>
                </span>
              </span>
            {/snippet}
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div class="trace-details">
              <div class="detail-row">
                <span class="detail-label">Model</span>
                <span class="detail-value">{trace.modelId ?? trace.name}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Duration</span>
                <span class="detail-value">{formatDuration(trace.durationMs)}</span>
              </div>
              {#if trace.usage}
                <div class="detail-row">
                  <span class="detail-label">Input tokens</span>
                  <span class="detail-value">{formatTokens(trace.usage.inputTokens)}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Output tokens</span>
                  <span class="detail-value">{formatTokens(trace.usage.outputTokens)}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Total tokens</span>
                  <span class="detail-value">{formatTokens(trace.usage.totalTokens)}</span>
                </div>
              {/if}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      </div>
    {/each}
  </div>
{/if}

<style>
  .detail-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-size: var(--font-size-1);
    inline-size: 100px;
  }

  .detail-row {
    display: flex;
    gap: var(--size-2);
  }

  .detail-value {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .expanded {
    transform: rotate(90deg);
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  .stat-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .stat-value {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .stats-bar {
    display: flex;
    gap: var(--size-6);
  }

  .trace-chevron {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    display: inline-flex;
    transition: transform 0.15s ease;
  }

  .trace-chevron :global(svg) {
    block-size: 12px;
    inline-size: 12px;
  }

  .trace-details {
    border-block-start: 1px solid var(--color-border-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    padding-block: var(--size-2);
    padding-inline: var(--size-6);
  }

  .trace-duration {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
  }

  .trace-entry {
    border: 1px solid var(--color-border-2);
    border-radius: var(--radius-1);
    overflow: hidden;
  }

  .trace-entry :global(button) {
    padding-block: var(--size-1-5);
    padding-inline: var(--size-2);
    transition: background-color 0.1s;
  }

  .trace-entry :global(button:hover) {
    background-color: var(--color-highlight-1);
  }

  .trace-header {
    align-items: center;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    inline-size: 100%;
    text-align: start;
  }

  .trace-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .trace-meta {
    display: flex;
    gap: var(--size-3);
    margin-inline-start: auto;
  }

  .trace-name {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-family: var(--font-family-monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trace-step {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-weight: var(--font-weight-5);
  }

  .trace-tokens {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-family-monospace);
  }
</style>

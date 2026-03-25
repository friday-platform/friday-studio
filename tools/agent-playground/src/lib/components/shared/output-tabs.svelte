<!--
  Tabbed output container for a single execution run.

  Displays Result, Stream, and Trace tabs with content-aware visibility
  and automatic tab selection based on execution state.

  @component
  @param {SSEEvent[]} events - SSE events from execution stream
  @param {unknown | null} result - Final result payload (null if not yet available)
  @param {TraceEntry[]} traces - LLM call trace entries
  @param {DoneStats | null} stats - Completion stats (null while executing)
  @param {ExecutionStatus} status - Discriminated union execution state
-->

<script lang="ts">
  import { MarkdownRendered, markdownToHTML } from "@atlas/ui";
  import ExecutionStream from "$lib/components/execution/execution-stream.svelte";
  import JsonTree from "$lib/components/shared/json-tree.svelte";
  import TracePanel from "$lib/components/shared/trace-panel.svelte";
  import type { DoneStats, TraceEntry } from "$lib/server/lib/sse.ts";
  import type { SSEEvent } from "$lib/sse-types.ts";
  import type { ExecutionStatus } from "$lib/types/execution-status.ts";

  type Tab = "result" | "stream" | "trace";

  type Props = {
    events: SSEEvent[];
    result: unknown | null;
    traces: TraceEntry[];
    stats: DoneStats | null;
    status: ExecutionStatus;
  };

  let { events, result, traces, stats, status }: Props = $props();

  /** Which tabs have content to show. */
  const hasResult = $derived(result !== null);
  const hasStream = $derived(events.length > 0 || status.state === "running");
  const hasTrace = $derived(traces.length > 0);

  /** Available tabs based on content. */
  const availableTabs = $derived.by((): Tab[] => {
    const tabs: Tab[] = [];
    if (hasResult) tabs.push("result");
    if (hasStream) tabs.push("stream");
    if (hasTrace) tabs.push("trace");
    return tabs;
  });

  /** User-selected tab (null means use auto-selection). */
  let userTab: Tab | null = $state(null);

  /** Auto-selected tab: Result when available, Stream while executing. */
  const autoTab = $derived.by((): Tab => {
    if (hasResult && status.state !== "running") return "result";
    if (hasStream) return "stream";
    return "result";
  });

  /** Active tab resolves user choice if still available, otherwise auto. */
  const activeTab = $derived.by((): Tab => {
    if (userTab && availableTabs.includes(userTab)) return userTab;
    return autoTab;
  });

  function selectTab(tab: Tab) {
    userTab = tab;
  }

  const TAB_LABELS: Record<Tab, string> = { result: "Result", stream: "Stream", trace: "Trace" };
</script>

{#if availableTabs.length > 0}
  <div class="output-tabs">
    <div class="tab-bar" role="tablist">
      {#each availableTabs as tab (tab)}
        <button
          class="tab"
          class:active={activeTab === tab}
          role="tab"
          aria-selected={activeTab === tab}
          onclick={() => selectTab(tab)}
        >
          {TAB_LABELS[tab]}
        </button>
      {/each}
    </div>

    <div class="tab-content" role="tabpanel">
      {#if activeTab === "result" && hasResult}
        <div class="result-pane">
          {#if typeof result === "string"}
            <MarkdownRendered>
              {@html markdownToHTML(result)}
            </MarkdownRendered>
          {:else}
            <JsonTree data={result} defaultExpanded={2} />
          {/if}
        </div>
      {:else if activeTab === "stream" && hasStream}
        <ExecutionStream {events} {status} />
      {:else if activeTab === "trace" && hasTrace}
        <TracePanel {traces} {stats} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .active {
    border-block-end-color: var(--color-text);
    color: var(--color-text);
  }

  .output-tabs {
    display: flex;
    flex-direction: column;
  }

  .result-pane {
    max-block-size: 400px;
    overflow-y: auto;
    padding: var(--size-3);
  }

  .tab {
    background: none;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    padding-block: var(--size-1-5);
    padding-inline: var(--size-3);
    text-transform: uppercase;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .tab:hover:not(.active) {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
  }

  .tab-bar {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-1);
  }

  .tab-content {
    min-block-size: 0;
  }
</style>

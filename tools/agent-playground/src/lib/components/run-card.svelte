<!--
  Collapsible card for a single execution run in the workbench history stack.

  Shows a header with run number, prompt preview, relative timestamp, status dot,
  and stats pills. Expands to reveal tabbed output (Result/Stream/Trace).

  @component
  @param {RunRecord} run - The execution run record
  @param {boolean} [expanded=false] - Initial expand state (latest run auto-expanded)
  @param {(prompt: string) => void} [onRerun] - Called when user clicks Re-run
  @param {(prompt: string) => void} [onCopyPrompt] - Called when user clicks Copy prompt
-->

<script lang="ts" module>
  export type { RunRecord } from "$lib/run-history.ts";
</script>

<script lang="ts">
  import type { RunRecord } from "$lib/run-history.ts";
  import OutputTabs from "./output-tabs.svelte";

  type Props = {
    run: RunRecord;
    expanded?: boolean;
    onRerun?: (prompt: string) => void;
    onCopyPrompt?: (prompt: string) => void;
  };

  let { run, expanded: initialExpanded = false, onRerun, onCopyPrompt }: Props = $props();

  let open = $state(initialExpanded);

  function toggle() {
    open = !open;
  }

  /** Truncate prompt for header preview. */
  function truncatePrompt(prompt: string, max: number): string {
    return prompt.length > max ? prompt.slice(0, max) + "..." : prompt;
  }

  /** Format milliseconds as relative time. */
  function relativeTime(startedAt: number): string {
    const delta = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (delta < 60) return `${delta}s ago`;
    const minutes = Math.floor(delta / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }

  /** Format duration for stats pill. */
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  /** Format token count for stats pill. */
  function formatTokens(n: number): string {
    return `${n.toLocaleString()} tok`;
  }

  let copyFeedback = $state(false);

  async function handleCopyPrompt() {
    if (onCopyPrompt) {
      onCopyPrompt(run.prompt);
    } else {
      await navigator.clipboard.writeText(run.prompt);
    }
    copyFeedback = true;
    setTimeout(() => {
      copyFeedback = false;
    }, 1500);
  }

  const executing = $derived(run.status === "running");
  const cancelled = $derived(run.status === "cancelled");
</script>

<div class="run-card" class:open>
  <button class="header" onclick={toggle} aria-expanded={open}>
    <span class="status-dot status-{run.status}" class:pulse={executing}></span>
    <span class="run-number">#{run.id}</span>
    <span class="prompt-preview">{truncatePrompt(run.prompt, 60)}</span>

    {#if run.stats}
      <span class="pills">
        <span class="pill">{formatDuration(run.stats.durationMs)}</span>
        {#if run.stats.totalTokens}
          <span class="pill">{formatTokens(run.stats.totalTokens)}</span>
        {/if}
        {#if run.stats.stepCount}
          <span class="pill">
            {run.stats.stepCount}
            {run.stats.stepCount === 1 ? "step" : "steps"}
          </span>
        {/if}
      </span>
    {/if}

    <span class="timestamp">{relativeTime(run.startedAt)}</span>
  </button>

  {#if open}
    <div class="body">
      <div class="actions">
        {#if onRerun}
          <button class="action-btn" onclick={() => onRerun(run.prompt)}>Re-run</button>
        {/if}
        <button class="action-btn" onclick={handleCopyPrompt}>
          {copyFeedback ? "Copied!" : "Copy prompt"}
        </button>
      </div>
      <OutputTabs
        events={run.events}
        result={run.result}
        traces={run.traces}
        stats={run.stats}
        {executing}
        {cancelled}
      />
    </div>
  {/if}
</div>

<style>
  .action-btn {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: 0;
  }

  .action-btn:hover {
    color: var(--color-text);
  }

  .actions {
    display: flex;
    gap: var(--size-3);
    padding-block-end: var(--size-2);
    padding-inline: var(--size-3);
  }

  .body {
    border-block-start: 1px solid var(--color-border-1);
    padding-block: var(--size-3);
  }

  .header {
    align-items: center;
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    inline-size: 100%;
    padding: var(--size-2-5) var(--size-3);
    text-align: start;
    transition: background-color 0.1s;
  }

  .header:hover {
    background-color: var(--color-highlight-1);
  }

  .pill {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
  }

  .pills {
    display: flex;
    gap: var(--size-2);
    margin-inline-start: auto;
  }

  .prompt-preview {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pulse {
    animation: dot-pulse 1.5s ease-in-out infinite;
  }

  .run-card {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    overflow: hidden;
  }

  .run-card.open {
    border-color: color-mix(in srgb, var(--color-border-1), var(--color-text) 10%);
  }

  .run-number {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .status-cancelled {
    background-color: var(--color-warning);
  }

  .status-dot {
    block-size: 8px;
    border-radius: var(--radius-round);
    flex-shrink: 0;
    inline-size: 8px;
  }

  .status-error {
    background-color: var(--color-error);
  }

  .status-running {
    background-color: var(--color-info);
  }

  .status-success {
    background-color: var(--color-success);
  }

  .timestamp {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-size: var(--font-size-1);
    white-space: nowrap;
  }

  @keyframes dot-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
</style>

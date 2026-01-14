<script lang="ts">
  import { createCollapsible } from "@melt-ui/svelte";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import { formatDuration } from "$lib/utils/date";
  import type { DigestStep } from "$lib/utils/session-timeline";
  import { slide } from "svelte/transition";

  interface Props {
    step: DigestStep;
    /** Fallback task description when step.task is missing (from session input) */
    fallbackTask?: string;
  }

  let { step, fallbackTask }: Props = $props();

  // Use step.task if available, otherwise fall back to session's input task
  const taskDescription = $derived(step.task ?? fallbackTask ?? "No task description available");

  const duration = $derived(step.durationMs ? formatDuration(0, step.durationMs) : null);
  const isFailed = $derived(step.status === "failed");

  // Details accordion for tool calls (collapsed by default)
  const {
    elements: { root: detailsRoot, trigger: detailsTrigger, content: detailsContent },
    states: { open: detailsOpen },
  } = createCollapsible({ defaultOpen: false });

  const TRUNCATE_LENGTH = 300;

  function formatContent(value: unknown): string {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }

  function truncate(str: string): string {
    if (str.length <= TRUNCATE_LENGTH) return str;
    return str.slice(0, TRUNCATE_LENGTH) + "...";
  }

  let expandedToolCalls = $state<Set<string>>(new Set());

  function toggleToolCall(toolCallId: string) {
    if (expandedToolCalls.has(toolCallId)) {
      expandedToolCalls.delete(toolCallId);
    } else {
      expandedToolCalls.add(toolCallId);
    }
    expandedToolCalls = new Set(expandedToolCalls);
  }
</script>

<div class="step-card">
  <div class="step-header">
    <div class="header-left">
      <span
        class="status-icon"
        class:completed={step.status === "completed"}
        class:failed={isFailed}
        class:in-progress={step.status === "in-progress"}
      >
        {#if step.status === "completed"}
          <IconSmall.Check />
        {:else if isFailed}
          <IconSmall.Close />
        {:else if step.status === "in-progress"}
          <IconSmall.Progress />
        {:else}
          <Icons.DotFilled />
        {/if}
      </span>

      <span class="step-title">Step {step.step}: {step.agent}</span>
    </div>

    <div class="header-right">
      <span class="status-text" class:failed={isFailed}>
        {#if step.status === "completed"}
          Completed
        {:else if isFailed}
          Failed
        {:else if step.status === "in-progress"}
          Running
        {:else}
          Pending
        {/if}
      </span>

      {#if duration}
        <span class="duration">{duration}</span>
      {/if}
    </div>
  </div>

  <div class="step-content">
    <div class="task-section">
      <div class="section-label">Task</div>
      <p class="task-description">{taskDescription}</p>
    </div>

    {#if isFailed && step.error}
      <div class="error-section">
        <pre class="error-message">{step.error}</pre>
      </div>
    {/if}

    {#if step.toolCalls.length > 0}
      <div class="details-accordion" {...$detailsRoot} use:detailsRoot>
        <button class="details-trigger" type="button" {...$detailsTrigger} use:detailsTrigger>
          <span class="details-label">{$detailsOpen ? "Hide" : "Show"} Details</span>
          <span class="details-icon" class:open={$detailsOpen}>
            <IconSmall.CaretRight />
          </span>
        </button>

        {#if $detailsOpen}
          <div
            class="details-content"
            {...$detailsContent}
            use:detailsContent
            transition:slide={{ duration: 200 }}
          >
            <div class="tool-calls-section">
              <div class="section-label">Tool Calls</div>
              <div class="tool-calls-list">
                {#each step.toolCalls as tc (tc.toolCallId)}
                  {@const expanded = expandedToolCalls.has(tc.toolCallId)}
                  {@const argsStr = formatContent(tc.args)}
                  {@const resultStr = tc.result !== undefined ? formatContent(tc.result) : null}

                  <div class="tool-call-item">
                    <button
                      class="tool-call-header"
                      type="button"
                      onclick={() => toggleToolCall(tc.toolCallId)}
                    >
                      <IconSmall.ToolCall />
                      <span class="tool-name">{tc.tool}</span>
                      <span class="expand-icon" class:expanded>▼</span>
                    </button>

                    {#if expanded}
                      <div class="tool-call-details" transition:slide={{ duration: 150 }}>
                        <div class="tool-field">
                          <span class="field-label">Args</span>
                          <pre class="field-value">{argsStr}</pre>
                        </div>
                        {#if resultStr !== null}
                          <div class="tool-field">
                            <span class="field-label">Result</span>
                            <pre class="field-value">{resultStr}</pre>
                          </div>
                        {/if}
                      </div>
                    {:else}
                      <div class="tool-call-preview">
                        <span class="preview-text">{truncate(argsStr)}</span>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .step-card {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
  }

  .step-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
    padding-block: var(--size-3);
    padding-inline: var(--size-4);
  }

  .header-left {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .status-icon {
    color: var(--color-text);
    display: flex;
    opacity: 0.5;
  }

  .status-icon.completed {
    color: var(--color-green-2);
    opacity: 1;
  }

  .status-icon.failed {
    color: var(--color-red);
    opacity: 1;
  }

  .status-icon.in-progress {
    color: var(--color-blue);
    opacity: 1;
  }

  .step-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .header-right {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .status-text {
    color: var(--color-text);
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .status-text.failed {
    color: var(--color-red);
    opacity: 1;
  }

  .duration {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .step-content {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding-block: var(--size-3);
    padding-inline: var(--size-4);
  }

  .section-label {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    margin-block-end: var(--size-1);
    opacity: 0.5;
    text-transform: uppercase;
  }

  .task-description {
    color: var(--color-text);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    opacity: 0.8;
  }

  .error-section {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border-inline-start: 3px solid var(--color-red);
    border-radius: var(--radius-1);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
  }

  .error-message {
    color: var(--color-red);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Details accordion */
  .details-accordion {
    margin-block-start: var(--size-2);
  }

  .details-trigger {
    align-items: center;
    background-color: transparent;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    opacity: 0.6;
    padding: 0;
    text-align: start;
    transition: opacity 150ms ease;
  }

  .details-trigger:hover {
    opacity: 1;
  }

  .details-icon {
    display: flex;
    transition: transform 150ms ease;
  }

  .details-icon.open {
    transform: rotate(90deg);
  }

  .details-content {
    margin-block-start: var(--size-3);
  }

  /* Tool calls */
  .tool-calls-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .tool-call-item {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-2);
  }

  .tool-call-header {
    align-items: center;
    background-color: transparent;
    border: none;
    cursor: pointer;
    display: flex;
    gap: var(--size-2);
    inline-size: 100%;
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
    text-align: start;
  }

  .tool-call-header:hover {
    background-color: var(--color-highlight-1);
  }

  .tool-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .expand-icon {
    color: var(--color-text);
    font-size: var(--font-size-2);
    margin-inline-start: auto;
    opacity: 0.5;
    transform: rotate(-90deg);
    transition: transform 0.15s;
  }

  .expand-icon.expanded {
    transform: rotate(0deg);
  }

  .tool-call-preview {
    padding-block: 0 var(--size-2);
    padding-inline: var(--size-3);
  }

  .preview-text {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .tool-call-details {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding-block: 0 var(--size-2);
    padding-inline: var(--size-3);
  }

  .tool-field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .field-label {
    color: var(--color-text);
    font-size: var(--font-size-1);
    opacity: 0.5;
    text-transform: uppercase;
  }

  .field-value {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    max-block-size: 200px;
    overflow-y: auto;
    padding-block: var(--size-2);
    padding-inline: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>

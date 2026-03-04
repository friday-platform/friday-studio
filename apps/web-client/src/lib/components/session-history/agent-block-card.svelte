<script lang="ts">
  import type { AgentBlock } from "@atlas/core";
  import { IconSmall } from "$lib/components/icons/small";
  import { formatDuration } from "$lib/utils/date";
  import { SvelteSet } from "svelte/reactivity";
  import { slide } from "svelte/transition";

  interface Props {
    block: AgentBlock;
  }

  let { block }: Props = $props();

  const isPending = $derived(block.status === "pending");
  const isSkipped = $derived(block.status === "skipped");
  const isInert = $derived(isPending || isSkipped);

  let open = $derived(block.status === "running");

  const duration = $derived(block.durationMs ? formatDuration(0, block.durationMs) : null);
  const hasToolCalls = $derived(block.toolCalls.length > 0);
  const hasReasoning = $derived(Boolean(block.reasoning));
  const hasOutput = $derived(block.output != null);
  const hasDetails = $derived(
    !isInert &&
      (hasToolCalls || hasReasoning || hasOutput || Boolean(block.task) || Boolean(block.error)),
  );
  const hasEphemeral = $derived(
    block.status === "running" && block.ephemeral && block.ephemeral.length > 0,
  );

  const statusLabel = $derived.by(() => {
    switch (block.status) {
      case "completed":
        return "Succeeded";
      case "failed":
        return "Failed";
      case "pending":
        return "";
      case "skipped":
        return "Skipped";
      default:
        return "Running";
    }
  });

  let expandedToolCalls = new SvelteSet<number>();

  function toggleToolCall(index: number) {
    if (expandedToolCalls.has(index)) {
      expandedToolCalls.delete(index);
    } else {
      expandedToolCalls.add(index);
    }
  }

  const TRUNCATE_LENGTH = 300;

  function formatContent(value: unknown): string {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }

  function truncate(str: string): string {
    if (str.length <= TRUNCATE_LENGTH) return str;
    return str.slice(0, TRUNCATE_LENGTH) + "...";
  }

  /**
   * Convert a kebab-case agent name to a human-readable title.
   * Strips trailing "-output" suffix (naming convention) and title-cases.
   */
  function formatAgentName(name: string): string {
    const cleaned = name.replace(/-output$/, "");
    return cleaned
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  /**
   * Derive a human-readable label from an ephemeral chunk type.
   */
  function getEphemeralLabel(chunk: { type?: string; data?: { content?: string } }): string {
    const type = chunk.type ?? "";
    if (type === "text") return "Typing";
    if (type === "reasoning") return "Reasoning";
    if (type.startsWith("tool-")) return "Calling Tools";
    if (type === "data-tool-progress" && chunk.data?.content) return chunk.data.content;
    if (type === "step-start") return "Processing";
    return "Thinking";
  }
</script>

<div class="agent-row-container">
  <button
    class="agent-row"
    class:open
    class:inert={isInert}
    type="button"
    onclick={() => {
      if (hasDetails) open = !open;
    }}
    disabled={isInert || !hasDetails}
  >
    <span
      class="status-icon"
      class:completed={block.status === "completed"}
      class:failed={block.status === "failed"}
      class:running={block.status === "running"}
      class:pending={isPending}
      class:skipped={isSkipped}
    >
      {#if block.status === "completed"}
        <IconSmall.Check />
      {:else if block.status === "failed"}
        <IconSmall.Close />
      {:else if isPending}
        <IconSmall.Progress />
      {:else if isSkipped}
        <IconSmall.Close />
      {:else}
        <IconSmall.Progress />
      {/if}
    </span>

    <div class="row-info">
      <span class="agent-name">{formatAgentName(block.agentName)}</span>
      {#if isPending && block.task}
        <span class="row-subtitle">{block.task}</span>
      {:else if statusLabel}
        <span class="row-meta">
          {statusLabel}
          {#if duration}
            <span class="meta-dot">&middot;</span>
            Took {duration}
          {/if}
        </span>
      {/if}
    </div>

    {#if hasDetails}
      <span class="row-caret" class:open>
        <IconSmall.CaretRight />
      </span>
    {/if}
  </button>

  {#if hasEphemeral}
    <div class="ephemeral-row">
      <span class="ephemeral-dot"></span>
      <span class="ephemeral-label">
        {getEphemeralLabel(
          block.ephemeral![block.ephemeral!.length - 1] as {
            type?: string;
            data?: { content?: string };
          },
        )}
      </span>
    </div>
  {/if}

  {#if open}
    <div class="row-details" transition:slide={{ duration: 150 }}>
      {#if block.task}
        <div class="detail-section">
          <div class="detail-label">Task</div>
          <p class="detail-text">{block.task}</p>
        </div>
      {/if}

      {#if block.status === "failed" && block.error}
        <div class="error-section">
          <pre class="error-message">{block.error}</pre>
        </div>
      {/if}

      {#if hasOutput}
        <div class="detail-section">
          <div class="detail-label">Output</div>
          <pre class="detail-code">{truncate(formatContent(block.output))}</pre>
        </div>
      {/if}

      {#if hasToolCalls}
        <div class="detail-section">
          <div class="detail-label">Tool Calls</div>
          <div class="tool-calls-list">
            {#each block.toolCalls as tc, index (index)}
              {@const expanded = expandedToolCalls.has(index)}
              {@const argsStr = formatContent(tc.args)}
              {@const resultStr = tc.result !== undefined ? formatContent(tc.result) : null}

              <div class="tool-call-item">
                <button
                  class="tool-call-header"
                  type="button"
                  onclick={(e) => {
                    e.stopPropagation();
                    toggleToolCall(index);
                  }}
                >
                  <IconSmall.ToolCall />
                  <span class="tool-name">{tc.toolName}</span>
                  {#if tc.durationMs != null}
                    <span class="tool-duration">{formatDuration(0, tc.durationMs)}</span>
                  {/if}
                  <span class="expand-icon" class:expanded>
                    <IconSmall.CaretRight />
                  </span>
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
      {/if}

      {#if hasReasoning}
        <div class="detail-section">
          <div class="detail-label">Reasoning</div>
          <pre class="detail-code">{block.reasoning}</pre>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .agent-row {
    align-items: flex-start;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    display: flex;
    font-family: inherit;
    gap: var(--size-3);
    inline-size: 100%;
    padding-block: var(--size-4);
    padding-inline: var(--size-3);
    position: relative;
    text-align: start;
    z-index: 1;

    &::before {
      background-color: var(--color-surface-2);
      border-radius: var(--size-3);
      content: "";
      inset: 0;
      opacity: 0;
      position: absolute;
      transition: all 150ms ease;
      z-index: -1;
    }

    &:hover:not(:disabled)::before {
      opacity: 1;
    }
  }

  .agent-row:disabled {
    cursor: default;
  }

  .agent-row.inert {
    opacity: 0.4;
  }

  .agent-row.inert:hover::before {
    opacity: 0;
  }

  .status-icon {
    display: flex;
    flex: none;
    margin-block-start: var(--size-px);
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

  .status-icon.pending {
    opacity: 0.35;
  }

  .status-icon.skipped {
    opacity: 0.35;
  }

  .status-icon.running {
    animation: spin 1.2s linear infinite;
    color: var(--color-blue);
    opacity: 1;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }

  .row-info {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    min-inline-size: 0;
  }

  .agent-name {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    line-height: var(--font-lineheight-1);
  }

  .row-subtitle {
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-1);
    opacity: 0.7;
  }

  .row-meta {
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-1);
    opacity: 0.5;
  }

  .meta-dot {
    margin-inline: var(--size-0-5);
  }

  .row-caret {
    display: flex;
    flex: none;
    margin-block-start: var(--size-1);
    margin-inline-start: auto;
    opacity: 0.35;
    transition: transform 150ms ease;
  }

  .row-caret.open {
    transform: rotate(90deg);
  }

  /* Ephemeral */
  .ephemeral-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    padding-block: 0 var(--size-3);
    padding-inline-start: calc(var(--size-1) + var(--size-3-5) + var(--size-3));
  }

  .ephemeral-dot {
    animation: pulse 1.5s ease-in-out infinite;
    background-color: var(--color-blue);
    block-size: var(--size-1-5);
    border-radius: var(--radius-round);
    inline-size: var(--size-1-5);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.4;
    }

    50% {
      opacity: 1;
    }
  }

  .ephemeral-label {
    font-size: var(--font-size-2);
    opacity: 0.5;
  }

  /* Expanded details */
  .row-details {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding-block: 0 var(--size-4);
    padding-inline: calc(var(--size-1) + var(--size-3-5) + var(--size-3)) var(--size-1);
  }

  .detail-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .detail-label {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-1);
    opacity: 0.45;
    text-transform: uppercase;
  }

  .detail-text {
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    opacity: 0.7;
  }

  .detail-code {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    max-block-size: var(--size-50);
    overflow-y: auto;
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Error */
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
    color: inherit;
    cursor: pointer;
    display: flex;
    font-family: inherit;
    gap: var(--size-2);
    inline-size: 100%;
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
    text-align: start;
  }

  .tool-call-header:hover {
    background-color: var(--color-highlight-1);
    border-radius: var(--radius-2);
  }

  .tool-name {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .tool-duration {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    opacity: 0.4;
  }

  .expand-icon {
    display: flex;
    margin-inline-start: auto;
    opacity: 0.35;
    transition: transform 150ms ease;
  }

  .expand-icon.expanded {
    transform: rotate(90deg);
  }

  .tool-call-preview {
    padding-block: 0 var(--size-2);
    padding-inline: var(--size-3);
  }

  .preview-text {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    opacity: 0.4;
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
    font-size: var(--font-size-1);
    opacity: 0.4;
    text-transform: uppercase;
  }

  .field-value {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    max-block-size: var(--size-50);
    overflow-y: auto;
    padding-block: var(--size-2);
    padding-inline: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>

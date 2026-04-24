<script lang="ts">
  import type { AgentBlock } from "@atlas/core/session/session-events";
  import { createCollapsible } from "@melt-ui/svelte";
  import { Collapsible } from "$lib/components/collapsible";
  import FormattedData from "$lib/components/formatted-data.svelte";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import JsonHighlight from "$lib/components/json-highlight.svelte";
  import { formatDuration } from "$lib/utils/date";
  import { deepParseJson } from "$lib/utils/deep-parse-json";
  import type { Component } from "svelte";
  import { sineOut } from "svelte/easing";
  import { slide } from "svelte/transition";
  import { parseError } from "./parse-error";
  import ToolCallData from "./tool-call-data.svelte";

  interface Props {
    block: AgentBlock;
    icon?: { type: "component"; src: Component } | { type: "image"; src: string };
    defaultOpen?: boolean;
  }

  let { block, icon, defaultOpen = false }: Props = $props();

  const {
    elements: { root, trigger, content },
    states: { open },
  } = createCollapsible({ forceVisible: true, defaultOpen });

  // When defaultOpen transitions to true (e.g. session finishes streaming), open the collapsible
  let prevDefaultOpen = $state(defaultOpen);
  $effect(() => {
    if (defaultOpen && !prevDefaultOpen) {
      open.set(true);
    }
    prevDefaultOpen = defaultOpen;
  });

  const isRunning = $derived(block.status === "running");
  const isPending = $derived(block.status === "pending");
  const isCompleted = $derived(block.status === "completed");
  const isFailed = $derived(block.status === "failed");

  const duration = $derived(block.durationMs ? formatDuration(0, block.durationMs) : null);
  const hasToolCalls = $derived(block.toolCalls.length > 0);
  const hasReasoning = $derived(Boolean(block.reasoning));
  const hasOutput = $derived(block.output != null);
  const hasInput = $derived(block.input != null && Object.keys(block.input).length > 0);
  const hasCompleteToolCall = $derived(block.toolCalls.some((tc) => tc.toolName === "complete"));
  const hasEphemeral = $derived(
    block.status === "running" && block.ephemeral && block.ephemeral.length > 0,
  );

  const ephemeralLabel = $derived.by(() => {
    if (!block.ephemeral || block.ephemeral.length === 0) return "Thinking";
    const last = block.ephemeral[block.ephemeral.length - 1];
    if (!last) return "Thinking";
    return getEphemeralLabel(last);
  });

  const hasBody = $derived(
    hasEphemeral || hasInput || hasToolCalls || hasOutput || hasReasoning || Boolean(block.error),
  );

  const subtitle = $derived.by(() => {
    if (isRunning) return "Running...";
    if (isPending) return "Not started";
    if (isCompleted && duration) return `Succeeded in ${duration}`;
    if (isFailed && duration) return `Failed after ${duration}`;
    switch (block.status) {
      case "completed":
        return "Succeeded";
      case "failed":
        return "Failed";
      case "skipped":
        return "Skipped";
      case "pending":
        return "Not started";
      default:
        return "Running...";
    }
  });

  const parsedError = $derived(block.error ? parseError(block.error) : null);

  function displayJson(value: unknown): string {
    return JSON.stringify(deepParseJson(value), null, 2).replace(/\\n/g, "\n");
  }

  function formatAgentName(name: string): string {
    const cleaned = name.replace(/-output$/, "");
    return cleaned
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function getEphemeralLabel(chunk: Record<string, unknown>): string {
    const type = typeof chunk.type === "string" ? chunk.type : "";
    if (type === "text") return "Typing";
    if (type === "reasoning") return "Reasoning";
    if (type.startsWith("tool-")) return "Calling Tools";
    if (type === "data-tool-progress") {
      const data = chunk.data as Record<string, unknown> | undefined;
      if (data && typeof data.content === "string") return data.content;
    }
    if (type === "step-start") return "Processing";
    return "Thinking";
  }
</script>

<div class="component" {...$root} use:root>
  <button class="header-row" {...$trigger} use:trigger type="button">
    <span class="icon" class:running={isRunning}>
      {#if isRunning}
        <IconSmall.Progress />
      {:else if icon}
        {#if icon.type === "component"}
          <icon.src />
        {:else}
          <img src={icon.src} alt="" class="icon-image" />
        {/if}
      {:else if isCompleted}
        <Icons.DotFilled />
      {:else if isFailed}
        <Icons.DotFilled />
      {:else}
        <Icons.DotOpen />
      {/if}
    </span>

    <div class="title">
      <h2>
        {formatAgentName(block.agentName)}
        <span class="caret" class:open={$open}>
          <IconSmall.CaretRight />
        </span>
      </h2>
      {#if subtitle}
        <p>{subtitle}</p>
      {/if}
    </div>
  </button>

  {#if $open && hasBody}
    <div
      class="body"
      transition:slide={{ duration: 150, easing: sineOut }}
      {...$content}
      use:content
    >
      {#if hasEphemeral}
        <div class="ephemeral-row">
          <span class="ephemeral-dot"></span>
          <span class="ephemeral-label">
            {ephemeralLabel}
          </span>
        </div>
      {/if}

      <div class="detail-section">
        <h3>Task</h3>
        <p class="detail-text">{block.task || "None available"}</p>

        <FormattedData
          label="Input"
          copyText={hasInput ? JSON.stringify(block.input, null, 2) : undefined}
          maxLines={7}
        >
          <JsonHighlight code={hasInput ? displayJson(block.input) : "No input provided"} />
        </FormattedData>
      </div>

      {#each block.toolCalls as toolCall, index (index)}
        <div class="detail-section">
          <h3>{toolCall.toolName === "complete" ? "Agent Completed" : toolCall.toolName}</h3>
          {#if toolCall.toolName === "complete"}
            <Collapsible.Root>
              <Collapsible.Content animate>
                <FormattedData copyText={JSON.stringify(toolCall.args, null, 2)} maxLines={50}>
                  <JsonHighlight code={displayJson(toolCall.args)} />
                </FormattedData>
              </Collapsible.Content>
              <Collapsible.Trigger>
                {#snippet children(open)}
                  <span class="output-toggle">{open ? "Hide output" : "See output"}</span>
                {/snippet}
              </Collapsible.Trigger>
            </Collapsible.Root>
          {:else}
            <ToolCallData
              args={toolCall.args}
              result={toolCall.result}
              displayArgs={displayJson(toolCall.args)}
              displayResult={toolCall.result != null ? displayJson(toolCall.result) : undefined}
            />
          {/if}
        </div>
      {/each}

      {#if !hasCompleteToolCall && (hasOutput || (isFailed && block.error) || hasReasoning)}
        <div class="detail-section">
          <h3>Agent Completed</h3>

          {#if parsedError && "prefix" in parsedError}
            <p class="error-label">{parsedError.prefix}</p>
          {/if}

          <Collapsible.Root>
            <Collapsible.Content animate>
              <div class="output-content">
                {#if hasOutput}
                  <FormattedData copyText={JSON.stringify(block.output, null, 2)} maxLines={50}>
                    <JsonHighlight code={displayJson(block.output)} />
                  </FormattedData>
                {/if}

                {#if hasReasoning}
                  <FormattedData copyText={block.reasoning}>
                    <pre>{block.reasoning}</pre>
                  </FormattedData>
                {/if}

                {#if parsedError}
                  {#if "reason" in parsedError}
                    <FormattedData variant="error" copyText={parsedError.reason}>
                      <p>{parsedError.reason}</p>
                    </FormattedData>
                  {:else}
                    <FormattedData variant="error" copyText={parsedError.raw}>
                      <pre>{parsedError.raw}</pre>
                    </FormattedData>
                  {/if}
                {/if}
              </div>
            </Collapsible.Content>

            <Collapsible.Trigger>
              {#snippet children(open)}
                <span class="output-toggle">{open ? "Hide output" : "See output"}</span>
              {/snippet}
            </Collapsible.Trigger>
          </Collapsible.Root>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .component {
    border-inline-start: var(--size-px) solid var(--color-border-1);
    margin-inline-start: var(--size-2);
    padding-block: 0 var(--size-6);

    &:last-of-type {
      padding-block: 0;
    }
  }

  .header-row {
    align-items: start;
    display: flex;
    gap: var(--size-2);
    inline-size: 100%;

    &:focus {
      outline: none;
    }

    &:focus-visible {
      border-radius: var(--radius-1);
      outline: 1px solid var(--accent-1);
    }
  }

  .icon {
    align-items: center;
    background-color: var(--color-surface-1);
    block-size: var(--size-8);
    color: color-mix(in srgb, var(--color-text), transparent 70%);
    display: flex;
    flex: none;
    inline-size: var(--size-4);
    justify-content: center;
    margin-inline-start: calc(-1 * calc(var(--size-2) + 0.5px));

    &.running {
      animation: spin 2s linear infinite;
    }
  }

  .icon-image {
    block-size: var(--size-3-5);
    inline-size: var(--size-3-5);
    object-fit: contain;
  }

  .title {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    margin-block-start: var(--size-2);
    min-inline-size: 0;
    text-align: start;

    h2 {
      align-items: center;
      display: flex;
      font-size: var(--font-size-3);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-1);
    }

    p {
      font-size: var(--font-size-2);
      line-height: var(--font-lineheight-1);
      opacity: 0.6;
    }
  }

  .caret {
    align-items: center;
    color: var(--color-text-2);
    display: flex;
    flex: none;
    opacity: 0;
    transition:
      opacity 0.15s ease,
      transform 0.15s ease;

    &.open {
      transform: rotate(90deg);
    }
  }

  .header-row:hover .caret {
    opacity: 0.5;
  }

  .body {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding-inline: var(--size-4);
  }

  /* Ephemeral */
  .ephemeral-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    padding-block: 0 var(--size-3);
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

  .detail-section {
    display: flex;
    flex-direction: column;
    padding-block: var(--size-4) 0;

    h3 {
      color: color-mix(in srgb, var(--color-text) 60%, transparent);
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-4-5);

      position: relative;

      &:before {
        content: "";
        background-color: var(--color-border-1);
        block-size: var(--size-px);
        inline-size: var(--size-3);
        position: absolute;
        inset-inline-start: calc(-1 * var(--size-4-5));
        inset-block-start: 50%;
        transform: translateY(calc(-1 * var(--size-1-5))) rotate(45deg);
      }
    }

    .detail-text {
      font-size: var(--font-size-3);
      line-height: var(--font-lineheight-3);
    }
  }

  .error-label {
    color: var(--red-3);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .output-content {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block-end: var(--size-2);
  }

  .output-toggle {
    color: var(--text-3);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    text-decoration-line: underline;
    text-underline-offset: var(--size-0-5);
  }
</style>

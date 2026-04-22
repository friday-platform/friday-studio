<script lang="ts">
  import FormattedData from "$lib/components/formatted-data.svelte";
  import { IconSmall } from "$lib/components/icons/small";
  import JsonHighlight from "$lib/components/json-highlight.svelte";
  import { deepParseJson } from "$lib/utils/deep-parse-json";
  import type { ToolCallGroupEntry } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message }: { message: ToolCallGroupEntry } = $props();

  let open = $state(false);
  let activeTabs = $state<Record<string, "request" | "response">>({});

  const label = $derived(message.summary ?? message.items.at(-1)?.content ?? "Working...");

  /** Check if details represent an inner tool call with input/result strings */
  function isInnerToolCall(details: unknown): details is { input?: string; result?: string } {
    if (!details || typeof details !== "object") return false;
    return (
      ("input" in details && typeof details.input === "string") ||
      ("result" in details && typeof details.result === "string")
    );
  }

  /** Format a JSON string for display -- deep-parse then pretty-print */
  function formatJson(value: string): string {
    const parsed = deepParseJson(value);
    if (typeof parsed === "string") return parsed;
    return JSON.stringify(parsed, null, 2);
  }

  /** Get display data for non-inner-tool-call items (take_note) */
  function getDisplayData(details: unknown): { text: string; plain: boolean } | undefined {
    if (!details || typeof details !== "object") return undefined;

    // take_note
    if ("input" in details) {
      const input = details.input;
      if (input && typeof input === "object" && "note" in input) {
        return { text: String(input.note), plain: true };
      }
    }

    return undefined;
  }

  function getActiveTab(id: string, hasInput: boolean): "request" | "response" {
    return activeTabs[id] ?? (hasInput ? "request" : "response");
  }

  function setActiveTab(id: string, tab: "request" | "response") {
    activeTabs[id] = tab;
  }
</script>

<MessageWrapper>
  <button type="button" class="toggle" class:open onclick={() => (open = !open)}>
    <span>{label}</span>
    <IconSmall.CaretRight />
  </button>

  {#if open}
    <ul class="tool-list">
      {#each message.items as item (item.id)}
        <li>
          <span class="tool-name">{item.content}</span>
          {#if isInnerToolCall(item.details)}
            {@const input = item.details.input}
            {@const result = item.details.result}
            {#if input || result}
              <div class="tool-call-data">
                <div class="tab-list">
                  {#if input}
                    <button
                      class="tab"
                      class:active={getActiveTab(item.id, !!input) === "request"}
                      onclick={() => setActiveTab(item.id, "request")}
                    >
                      Request
                    </button>
                  {/if}
                  {#if result}
                    <button
                      class="tab"
                      class:active={getActiveTab(item.id, !!input) === "response"}
                      onclick={() => setActiveTab(item.id, "response")}
                    >
                      Response
                    </button>
                  {/if}
                </div>
                {#if input && getActiveTab(item.id, !!input) === "request"}
                  <FormattedData copyText={formatJson(input)} maxLines={7}>
                    <JsonHighlight code={formatJson(input)} />
                  </FormattedData>
                {/if}
                {#if result && getActiveTab(item.id, !!input) === "response"}
                  <FormattedData copyText={formatJson(result)} maxLines={50}>
                    <JsonHighlight code={formatJson(result)} />
                  </FormattedData>
                {/if}
              </div>
            {/if}
          {:else}
            {@const data = getDisplayData(item.details)}
            {#if data}
              <FormattedData copyText={data.text} maxLines={7}>
                {#if data.plain}
                  <pre>{data.text}</pre>
                {:else}
                  <JsonHighlight code={data.text} />
                {/if}
              </FormattedData>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</MessageWrapper>

<style>
  .toggle {
    align-items: center;
    display: flex;
    color: color-mix(in srgb, var(--color-text) 60%, transparent);
    gap: var(--size-1);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    max-inline-size: 100%;
    overflow: hidden;
    text-align: left;
    transition: opacity 250ms ease;

    & :global(svg) {
      flex: none;
      opacity: 0.7;
      transition: transform 150ms ease-in-out;
    }

    span {
      flex-shrink: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &.open :global(svg:last-child) {
      transform: rotate(90deg);
    }
  }

  .tool-list {
    border-inline-start: var(--size-px) solid var(--color-border-1);
    margin-inline-start: var(--size-1-5);
    margin-block-start: var(--size-2);
    padding-inline-start: var(--size-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);

    li {
      font-size: var(--font-size-2);
    }
  }

  .tool-name {
    font-weight: var(--font-weight-5);
    opacity: 0.8;
  }

  .tool-call-data {
    margin-block-start: var(--size-2);
  }

  .tab-list {
    display: flex;
    gap: var(--size-0-5);
  }

  .tab {
    align-items: center;
    background: transparent;
    block-size: var(--size-7);
    border-radius: var(--radius-2) var(--radius-2) 0 0;
    border: none;
    color: color-mix(in srgb, var(--color-text) 60%, transparent);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    justify-content: center;
    line-height: var(--font-lineheight-3);
    padding-inline: var(--size-3);
  }

  .tab.active {
    background: var(--yellow-1);
    color: var(--color-text);
  }

  .tool-call-data :global(.formatted-data) {
    border-start-start-radius: 0;
    margin-block-start: 0;
  }
</style>

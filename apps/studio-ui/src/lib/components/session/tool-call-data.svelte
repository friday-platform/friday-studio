<script lang="ts">
  import { FormattedData, JsonHighlight } from "@atlas/ui";
  import { createTabs } from "@melt-ui/svelte";

  interface Props {
    args: unknown;
    result?: unknown;
    displayArgs: string;
    displayResult?: string;
  }

  let { args, result, displayArgs, displayResult }: Props = $props();

  const hasResult = $derived(result != null);

  const {
    elements: { root, list, content, trigger },
  } = createTabs({ defaultValue: "request" });
</script>

<div class="tool-call-data">
  <div class="tabs" {...$root} use:root>
    <div class="tab-list" {...$list} use:list>
      <button class="tab" {...$trigger("request")} use:trigger>Request</button>
      {#if hasResult}
        <button class="tab" {...$trigger("response")} use:trigger>Response</button>
      {/if}
    </div>

    <div {...$content("request")} use:content>
      <FormattedData copyText={JSON.stringify(args, null, 2)} maxLines={7}>
        <JsonHighlight code={displayArgs} />
      </FormattedData>
    </div>

    {#if hasResult}
      <div {...$content("response")} use:content>
        <FormattedData copyText={JSON.stringify(result, null, 2)} maxLines={50}>
          <JsonHighlight code={displayResult ?? ""} />
        </FormattedData>
      </div>
    {/if}
  </div>
</div>

<style>
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

  .tab[data-state="active"] {
    background: var(--yellow-1);
    color: var(--color-text);
  }

  .tool-call-data :global(.formatted-data) {
    border-start-start-radius: 0;
    margin-block-start: 0;
  }
</style>

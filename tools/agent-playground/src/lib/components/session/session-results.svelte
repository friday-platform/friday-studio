<!--
  Renders the final per-agent results map that lands on the run-detail
  "Complete"/"Failed" roll-up. `query.data.results` is typed as
  `Record<string, unknown>` but in practice the FSM session reducer
  (`packages/core/src/session/session-reducer.ts:90`) only ever assigns
  `block.output` — an *object* — keyed by `block.agentName`. Two shapes
  carry markdown prose in real sessions, the rest fall back to a JSON
  view:

    - `{ response, data? }` — Agent SDK `complete({ response, data })`
                              per `writing-workspace-jobs/SKILL.md:715`.
    - `{ text }`            — workspace-chat / "unknown" agent
                              fall-through (the dominant shape).

  Bare strings and `{error}` envelopes are intentionally NOT handled
  here: the reducer never produces a string output, and session-level
  errors flow through `query.data.error` → the `sessionError` branch in
  the parent page, not through this map.

  Markdown rendering lifts the splitMarkdownByTables + MarkdownRendered
  + TableView pattern from the fullscreen artifact view at
  `/artifacts/[id]/markdown/+page.svelte`.
-->

<script lang="ts">
  import { FormattedData, JsonHighlight, MarkdownRendered, markdownToHTMLSafe } from "@atlas/ui";
  import { splitMarkdownByTables } from "$lib/components/chat/table-parsers.ts";
  import TableView from "$lib/components/chat/table-view.svelte";

  interface Props {
    results: Record<string, unknown>;
  }

  const { results }: Props = $props();

  const entries = $derived(Object.entries(results));

  type ProseSlice = { prose: string; data?: unknown };

  function asProse(v: unknown): ProseSlice | null {
    if (typeof v !== "object" || v === null) return null;
    const obj = v as { response?: unknown; text?: unknown; data?: unknown };
    if (typeof obj.response === "string") return { prose: obj.response, data: obj.data };
    if (typeof obj.text === "string") return { prose: obj.text };
    return null;
  }
</script>

{#if entries.length > 0}
  <div class="results">
    {#each entries as [agentName, value] (agentName)}
      {@const prose = asProse(value)}
      <div class="result-block">
        {#if entries.length > 1}
          <h4 class="result-agent">{agentName}</h4>
        {/if}
        {#if prose}
          <FormattedData copyText={prose.prose} maxLines={20}>
            {#each splitMarkdownByTables(prose.prose) as segment, i (i)}
              {#if segment.kind === "prose"}
                <MarkdownRendered>
                  {@html markdownToHTMLSafe(segment.markdown)}
                </MarkdownRendered>
              {:else}
                <TableView columns={segment.model.columns} rows={segment.model.rows} />
              {/if}
            {/each}
          </FormattedData>
          {#if prose.data !== undefined}
            <FormattedData copyText={JSON.stringify(prose.data, null, 2)} maxLines={7}>
              <JsonHighlight code={JSON.stringify(prose.data, null, 2)} />
            </FormattedData>
          {/if}
        {:else}
          <FormattedData copyText={JSON.stringify(value, null, 2)} maxLines={7}>
            <JsonHighlight code={JSON.stringify(value, null, 2)} />
          </FormattedData>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .results {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    margin-block-start: var(--size-2);
  }

  .result-block {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .result-agent {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.02em;
    margin: 0;
    text-transform: uppercase;
  }
</style>

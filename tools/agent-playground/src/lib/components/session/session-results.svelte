<!--
  Renders the final per-agent results map that lands on the run-detail
  "Complete"/"Failed" roll-up. `query.data.results` is typed as
  `Record<string, unknown>` because agents can emit any shape via
  `complete()`, FSM `outputTo`, or the chat-tool's implicit `{ text }`
  fall-through. This component does the runtime branching so markdown
  prose, structured `{response, data}` payloads, `{text}` envelopes,
  error envelopes, and raw JSON fallbacks all land in the right
  renderer.

  Lifts the splitMarkdownByTables + MarkdownRendered + TableView
  pattern from the fullscreen artifact markdown view
  (`/artifacts/[id]/markdown/+page.svelte`).
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

  type ErrorResult = { error: string };
  type ProseSlice = { prose: string; data?: unknown };

  function isErrorResult(v: unknown): v is ErrorResult {
    return (
      typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string"
    );
  }

  // Pulls the prose payload out of a result entry, regardless of which
  // emit path produced it:
  //   - bare string                — agents that return a raw markdown blob
  //   - { response, data? }        — Agent SDK `complete({ response, data })`
  //   - { text }                   — FSM workspace-chat / "unknown" agent
  //                                   fall-through (the dominant shape)
  // Returns null for anything else so the template can route to the
  // JSON fallback. Errors are caught earlier — don't call this on them.
  function asProse(v: unknown): ProseSlice | null {
    if (typeof v === "string") return { prose: v };
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
      <div class="result-block">
        {#if entries.length > 1}
          <h4 class="result-agent">{agentName}</h4>
        {/if}
        {#if isErrorResult(value)}
          <p class="error-label">{value.error}</p>
        {:else}
          {@const prose = asProse(value)}
          {#if prose}
            {#each splitMarkdownByTables(prose.prose) as segment, i (i)}
              {#if segment.kind === "prose"}
                <MarkdownRendered>
                  {@html markdownToHTMLSafe(segment.markdown)}
                </MarkdownRendered>
              {:else}
                <TableView columns={segment.model.columns} rows={segment.model.rows} />
              {/if}
            {/each}
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

  .error-label {
    color: var(--color-red);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }
</style>

<!--
  Wrapper for the `request_workspace_setup` tool call.

  The agent (or the import-time bootstrap) emits an assistant message with
  a `tool-request_workspace_setup` part whose output carries
  `{ elicitationId, ... }`. This wrapper does the id lookup against the
  elicitation cache and forwards to `<WorkspaceSetupCard>`, mirroring the
  shape that `env-set-tool-card.svelte` uses for `env_set`.

  @component
-->
<script lang="ts">
  import type { Elicitation } from "@atlas/core/elicitations/model";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { elicitationQueries } from "$lib/queries/elicitation-queries.ts";
  import { readElicitationIdFromToolOutput } from "./human-input-matcher.ts";
  import { isInProgress } from "./tool-call-utils.ts";
  import type { ToolCallDisplay } from "./types.ts";
  import WorkspaceSetupCard from "./workspace-setup-card.svelte";

  interface Props {
    call: ToolCallDisplay;
  }

  const { call }: Props = $props();

  const workspaceId = $derived(page.params.workspaceId as string | undefined);
  const listQuery = createQuery(() => elicitationQueries.list(workspaceId ?? null));
  const elicitations = $derived<Elicitation[]>(listQuery.data ?? []);
  const elicitationId = $derived(readElicitationIdFromToolOutput(call));
  const matched = $derived<Elicitation | null>(
    elicitationId ? (elicitations.find((e) => e.id === elicitationId) ?? null) : null,
  );

  // Cold-cache armed refetch — the elicitation is created server-side
  // before the tool returns, so the lookup almost always lands on the
  // first try. The one exception is the import-time bootstrap on a fresh
  // page load, where the elicitations cache may not have populated yet.
  let refetchedForCall = "";
  $effect(() => {
    if (matched || listQuery.isFetching || isInProgress(call.state)) return;
    if (!elicitationId || refetchedForCall === call.toolCallId) return;
    refetchedForCall = call.toolCallId;
    void listQuery.refetch();
  });
</script>

{#if matched && workspaceId}
  <WorkspaceSetupCard elicitation={matched} />
{:else if isInProgress(call.state)}
  <p class="hint">Preparing setup form…</p>
{:else}
  <p class="hint">Syncing with Activity…</p>
{/if}

<style>
  .hint {
    color: var(--text-faded);
    font-size: var(--font-size-1);
    margin: 0;
  }
</style>

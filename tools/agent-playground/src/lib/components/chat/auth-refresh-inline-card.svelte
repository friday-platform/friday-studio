<!--
  Inline chat surface for pending `auth-refresh` elicitations.

  Auth-refresh elicitations are emitted by the createMCPTools retry
  wrapper when an MCP server's credential is briefly unavailable
  (token-refresh window). The Activity page renders the full detail
  panel, but the operator is usually mid-chat — surfacing the same
  Retry/Cancel buttons inline lets them resolve the pause without
  leaving the chat.

  @component
-->

<script lang="ts">
  import type { Elicitation, ElicitationStatus } from "@atlas/core/elicitations/model";
  import { createQuery } from "@tanstack/svelte-query";
  import { effectiveElicitationStatus } from "$lib/elicitation-counts.ts";
  import { elicitationQueries, useAnswerElicitation } from "$lib/queries/elicitation-queries.ts";
  import AuthRefreshCard from "./auth-refresh-card.svelte";

  interface Props {
    workspaceId: string;
  }

  let { workspaceId }: Props = $props();

  const listQuery = createQuery(() => elicitationQueries.list(workspaceId));

  let nowMs = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => {
      nowMs = Date.now();
    }, 1_000);
    return () => clearInterval(timer);
  });

  function isPending(elic: Elicitation): boolean {
    const status: ElicitationStatus = effectiveElicitationStatus(elic, nowMs);
    return status === "pending";
  }

  const pendingAuthRefresh = $derived<Elicitation[]>(
    (listQuery.data ?? [])
      .filter((elic) => elic.kind === "auth-refresh" && isPending(elic))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  );

  const answerMutation = useAnswerElicitation();
  const inFlight = $derived(answerMutation.isPending);
  const errorMessage = $derived(
    answerMutation.isError ? (answerMutation.error?.message ?? "unknown") : undefined,
  );

  function answerWith(id: string, value: "retry" | "cancel") {
    if (inFlight) return;
    answerMutation.mutate({ id, value });
  }
</script>

{#if pendingAuthRefresh.length > 0}
  <div class="auth-refresh-stack">
    {#each pendingAuthRefresh as elic (elic.id)}
      <AuthRefreshCard
        elicitationId={elic.id}
        question={elic.question}
        {inFlight}
        {errorMessage}
        onanswer={(value) => answerWith(elic.id, value)}
      />
    {/each}
  </div>
{/if}

<style>
  .auth-refresh-stack {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }
</style>

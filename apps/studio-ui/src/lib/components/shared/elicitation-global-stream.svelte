<!--
  Subscribes to elicitations across every workspace the user can access
  via the SharedWorker firehose. The worker holds one upstream
  `/api/me/stream` per browser; this component is one of N tabs that
  share it.

  The wrapper yields full `Elicitation` envelopes (the daemon's
  per-event authz filter ensures only accessible workspaces reach us).
  Cache merging uses the same path the workspace-scoped stream uses, so
  the global view and the per-workspace view converge on identical
  data.

  @component
-->
<script lang="ts">
  import { browser } from "$app/environment";
  import { mergeElicitationIntoCache } from "$lib/queries/elicitation-queries.ts";
  import { subscribeToGlobalElicitations } from "$lib/shared-worker/client.ts";
  import type { QueryClient } from "@tanstack/svelte-query";

  let { queryClient }: { queryClient: QueryClient } = $props();

  $effect(() => {
    if (!browser) return;

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const elicitation of subscribeToGlobalElicitations({
          signal: controller.signal,
        })) {
          mergeElicitationIntoCache(queryClient, elicitation);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Global elicitations stream errored", error);
      }
    })();

    return () => controller.abort();
  });
</script>

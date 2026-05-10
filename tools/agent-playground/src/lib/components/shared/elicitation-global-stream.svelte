<script lang="ts">
  import { browser } from "$app/environment";
  import {
    applyElicitationSummaryEvent,
    ElicitationSummarySchema,
  } from "$lib/queries/elicitation-queries.ts";
  import type { QueryClient } from "@tanstack/svelte-query";

  let { queryClient }: { queryClient: QueryClient } = $props();

  $effect(() => {
    if (!browser) return;

    const es = new EventSource("/api/daemon/api/elicitations/stream/global");
    es.addEventListener("message", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch (error) {
        console.error("Failed to parse global elicitation SSE event", error);
        return;
      }
      const parsed = ElicitationSummarySchema.safeParse(raw);
      if (!parsed.success) {
        console.error("Failed to parse global elicitation SSE event", parsed.error);
        return;
      }
      applyElicitationSummaryEvent(queryClient, parsed.data);
    });
    es.addEventListener("error", () => {
      console.warn("Global elicitations SSE feed errored (EventSource will retry)");
    });

    return () => es.close();
  });
</script>

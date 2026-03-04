<script lang="ts">
  import type { Intent } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message }: { message: Intent } = $props();

  const content = $derived(message.content ?? "Working");
</script>

<MessageWrapper>
  <p class="text">{content}</p>
</MessageWrapper>

<style>
  .text {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
  }
</style>

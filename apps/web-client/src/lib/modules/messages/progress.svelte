<script lang="ts">
  import { formatDuration } from "$lib/utils/date";
  import MessageWrapper from "./wrapper.svelte";

  interface Props {
    turnStartedAt?: number | null;
  }

  const { turnStartedAt }: Props = $props();

  const startTime = $derived(turnStartedAt ?? Date.now());
  let endTime = $state(Date.now());

  $effect(() => {
    const interval = setInterval(() => {
      endTime = Date.now();
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  });
</script>

<MessageWrapper>
  <div class="container">
    <span class="thinking">Thinking...</span>

    <footer>
      <time>{formatDuration(startTime, endTime)}</time>
    </footer>
  </div>
</MessageWrapper>

<style>
  .container {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: var(--size-1);
    margin-block-start: var(--size-2);
  }

  .thinking {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
  }

  footer {
    align-items: center;
    display: flex;
    gap: var(--size-1);
    font-size: var(--font-size-1);
    opacity: 0.5;
  }
</style>

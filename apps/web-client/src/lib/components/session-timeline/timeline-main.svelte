<script lang="ts">
  import type { DigestStep } from "$lib/utils/session-timeline";
  import StepCard from "./step-card.svelte";

  interface Props {
    steps?: DigestStep[];
    /** Fallback task description when step.task is missing (from session input) */
    fallbackTask?: string;
  }

  let { steps = [], fallbackTask }: Props = $props();
</script>

<div class="timeline-main">
  {#if steps.length > 0}
    {#each steps as step (step.state)}
      <StepCard {step} {fallbackTask} />
    {/each}
  {:else}
    <div class="empty-state">
      <p>No timeline events found for this session.</p>
    </div>
  {/if}
</div>

<style>
  .timeline-main {
    display: flex;
    flex-direction: column;
    padding-block-start: var(--size-3);
  }

  .empty-state {
    align-items: center;
    color: var(--text-3);
    display: flex;
    font-size: var(--font-size-3);
    justify-content: center;
    padding-block: var(--size-16);
  }
</style>

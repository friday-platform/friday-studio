<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { IconSmall } from "$lib/components/icons/small";
  import type { ErrorEntry } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message }: { message: ErrorEntry } = $props();
  let open = $state(false);
</script>

<MessageWrapper>
  <button
    onclick={() => {
      if (!open) trackEvent(GA4.ERROR_DETAILS_EXPAND);
      open = !open;
    }}
    class:open
  >
    <span class="header">
      An error happened
      <IconSmall.CaretRight />
    </span>

    {#if open}
      <div class="details">
        <p>
          {message.content}
        </p>
      </div>
    {/if}
  </button>
</MessageWrapper>

<style>
  button {
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    text-align: left;

    .header {
      align-items: center;
      color: var(--color-red);
      display: flex;
      gap: var(--size-1-5);
    }

    & :global(svg) {
      transition: transform 150ms ease-in-out;
    }

    &.open :global(svg) {
      transform: rotate(90deg);
    }
  }

  .details {
    p {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-4-5);
      opacity: 0.8;
    }
  }
</style>

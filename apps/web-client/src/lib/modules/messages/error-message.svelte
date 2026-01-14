<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";
  import type { OutputEntry } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message }: { message: OutputEntry } = $props();
  let open = $state(false);
</script>

<MessageWrapper>
  <article class="message">
    <button onclick={() => (open = !open)} class:open>
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
  </article>
</MessageWrapper>

<style>
  .message {
    display: flex;
    inline-size: var(--size-160);
    margin-inline: auto;
    padding-inline: var(--size-8);
  }

  button {
    border-radius: var(--radius-round);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    inline-size: max-content;
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

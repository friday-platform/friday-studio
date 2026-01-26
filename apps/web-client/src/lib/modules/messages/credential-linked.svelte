<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";
  import type { CredentialLinkedEntry } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message }: { message: CredentialLinkedEntry } = $props();

  const displayName = $derived(message.displayName || "service");
</script>

<MessageWrapper>
  <div class="credential-linked">
    <div class="pill">
      <span class="icon"><IconSmall.Check /></span>
      <span class="text">Connected {displayName}</span>
    </div>
  </div>
</MessageWrapper>

<style>
  .credential-linked {
    display: flex;
    justify-content: center;
    padding-block: var(--size-2);
  }

  .pill {
    align-items: center;
    background-color: color-mix(in srgb, var(--color-green) 15%, transparent);
    border-radius: var(--radius-round);
    display: flex;
    gap: var(--size-1-5);
    padding-block: var(--size-1);
    padding-inline: var(--size-3);
  }

  .icon {
    color: var(--color-green-2);
    display: flex;
  }

  .text {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    opacity: 0.8;
  }
</style>

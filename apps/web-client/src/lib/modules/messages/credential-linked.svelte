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
    background-color: var(--accent-1);
    color: var(--accent-3);
    border-radius: var(--radius-round);
    display: flex;
    gap: var(--size-1-5);
    padding-block: var(--size-1);
    padding-inline: var(--size-3);
  }

  .icon {
    display: flex;
  }

  .text {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }
</style>

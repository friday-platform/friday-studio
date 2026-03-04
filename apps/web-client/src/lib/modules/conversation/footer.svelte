<script lang="ts">
  import { getAppContext, handleFileDrop } from "$lib/app-context.svelte";
  import { getConversationContext } from "$lib/modules/conversation/context.svelte";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
  const appCtx = getAppContext();
  const conversation = getConversationContext();
</script>

<div
  class="component"
  role="region"
  aria-label="Drag and drop files to attach them to your conversation"
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => {
    e.preventDefault();
    handleFileDrop(appCtx, Array.from(e.dataTransfer?.files ?? []), conversation.chatId);
  }}
>
  <div class="component-int">
    {@render children()}
  </div>
</div>

<style>
  .component {
    inset-block-end: var(--size-5);
    /* TODO: add back when sidbar is more complete */
    /* inset-inline-end: calc(var(--size-80) + var(--size-1-5) + var(--size-px)); */
    inset-inline-end: calc(var(--size-1-5) + var(--size-px));
    inset-inline-start: calc(var(--size-56) + var(--size-1-5));
    padding-inline: var(--size-8);
    position: fixed;
    transition: all 450ms ease-in-out;
    z-index: var(--layer-2);

    /* TODO: add back when sidbar is more complete */
    /* @media (min-width: 1156px) {
      inset-inline-end: calc(var(--size-96) + var(--size-1-5) + var(--size-px));
    }

    @media (min-width: 1920px) {
      inset-inline-end: calc(var(--size-112) + var(--size-1-5) + var(--size-px));
    } */

    .component-int {
      margin-inline: auto;
      max-inline-size: var(--size-160);
    }
  }
</style>

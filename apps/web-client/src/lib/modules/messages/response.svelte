<script lang="ts">
  import type { AtlasUIMessagePart } from "@atlas/agent-sdk";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import type { TextEntry } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message }: { message: TextEntry; parts: AtlasUIMessagePart[] } = $props();
</script>

<MessageWrapper>
  <article>
    {#if message.content}
      <MarkdownContent content={message.content} />
    {/if}
  </article>
</MessageWrapper>

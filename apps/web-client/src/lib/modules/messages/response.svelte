<script lang="ts">
  import type { AtlasUIMessagePart } from "@atlas/agent-sdk";
  import { client, parseResult } from "@atlas/client/v2";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Dialog } from "$lib/components/dialog";
  import { toast } from "$lib/components/notification/notification.svelte";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import { getConversationContext } from "$lib/modules/conversation/context.svelte";
  import type { TextEntry } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message, parts }: { message: TextEntry; parts: AtlasUIMessagePart[] } = $props();

  const app = getAppContext();
  const conversation = getConversationContext();

  const sessionId = $derived.by(() => {
    const sessionStart = parts.find((p) => p.type === "data-session-start");
    if (sessionStart?.type === "data-session-start") {
      return sessionStart.data.sessionId;
    }
    return undefined;
  });

  let isSending = $state(false);

  async function handleReport(open: { set: (v: boolean) => void }) {
    isSending = true;
    try {
      const result = await parseResult(
        client.report.index.$post({
          json: {
            userId: app.user?.id ?? "unknown",
            chatId: conversation.chatId,
            sessionId: sessionId ?? "unknown",
          },
        }),
      );
      if (result.ok) {
        toast({ title: "Report sent", description: "Thank you for your feedback." });
      } else {
        toast({ title: "Failed to send report", error: true });
      }
      open.set(false);
    } catch {
      toast({ title: "Failed to send report", error: true });
    } finally {
      isSending = false;
    }
  }
</script>

<MessageWrapper>
  <article>
    {#if message.content}
      <MarkdownContent content={message.content} />
    {/if}
  </article>
  <Dialog.Root>
    {#snippet children(open)}
      <Dialog.Trigger>
        <button class="report-issue">Report issue</button>
      </Dialog.Trigger>

      <Dialog.Content>
        <Dialog.Close />

        {#snippet header()}
          <Dialog.Title>Report issue</Dialog.Title>
          <Dialog.Description>
            This will send your user, chat, and session IDs to the Friday support team.
          </Dialog.Description>
        {/snippet}

        {#snippet footer()}
          <div class="buttons">
            <Dialog.Button
              onclick={() => handleReport(open)}
              disabled={isSending}
              closeOnClick={false}
            >
              {isSending ? "Sending..." : "Confirm"}
            </Dialog.Button>
            <Dialog.Cancel>Cancel</Dialog.Cancel>
          </div>
        {/snippet}
      </Dialog.Content>
    {/snippet}
  </Dialog.Root>
</MessageWrapper>

<style>
  :global([data-melt-dialog-trigger]) {
    position: absolute;
    inset-block-start: 100%;
    opacity: 0;
    transition: opacity 200ms;
  }

  article:hover ~ :global([data-melt-dialog-trigger]),
  :global([data-melt-dialog-trigger]:hover),
  :global([data-melt-dialog-trigger]:focus-within) {
    opacity: 1;
  }

  .report-issue {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    color: color-mix(in srgb, var(--color-text) 60%, transparent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  .buttons {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    inline-size: 100%;
  }
</style>

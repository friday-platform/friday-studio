<script lang="ts">
  import type { ChatMessage, ScheduleProposal } from "./types";
  import ScheduleProposalCard from "./schedule-proposal-card.svelte";

  interface Props {
    messages: ChatMessage[];
    onScheduleAction?: (action: "confirm" | "cancel", messageId: string, proposal?: ScheduleProposal) => void;
  }

  const { messages, onScheduleAction }: Props = $props();

  let containerEl: HTMLDivElement | undefined = $state();

  // Auto-scroll to bottom when new messages arrive
  $effect(() => {
    // Access messages.length to create the reactive dependency
    if (messages.length > 0 && containerEl) {
      containerEl.scrollTop = containerEl.scrollHeight;
    }
  });
</script>

<div class="message-list" bind:this={containerEl}>
  {#each messages as message (message.id)}
    {#if message.scheduleProposal}
      <div class="message system" style="align-self: center; max-inline-size: 90%;">
        <ScheduleProposalCard
          proposal={message.scheduleProposal}
          onconfirm={(p) => onScheduleAction?.("confirm", message.id, p)}
          oncancel={() => onScheduleAction?.("cancel", message.id)}
        />
      </div>
    {:else}
      <div class="message" class:user={message.role === "user"} class:assistant={message.role === "assistant"} class:system={message.role === "system"}>
        {#if message.role === "system"}
          <div class="message-content system-content">{message.content}</div>
        {:else}
          <span class="role-badge">{message.role === "user" ? "You" : "Friday"}</span>
          <div class="message-content">{message.content}</div>
        {/if}
      </div>
    {/if}
  {/each}

  {#if messages.length === 0}
    <div class="empty-state">
      <p>Send a message to start a conversation.</p>
      <p class="hint">Friday will match your message to the best workspace, or create a new conversation.</p>
    </div>
  {/if}
</div>

<style>
  .message-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-4);
    overflow-y: auto;
    padding: var(--size-4);
    scrollbar-width: thin;
  }

  .message {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    max-inline-size: 80%;
  }

  .message.user {
    align-self: flex-end;
  }

  .message.assistant {
    align-self: flex-start;
  }

  .role-badge {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .message-content {
    background-color: var(--color-surface-3);
    border-radius: var(--radius-3);
    font-size: var(--font-size-2);
    line-height: 1.55;
    padding: var(--size-2-5) var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .message.user .message-content {
    background-color: var(--color-primary);
    color: white;
  }

  .message.system {
    align-self: center;
    max-inline-size: 90%;
  }

  .system-content {
    background-color: color-mix(in srgb, var(--color-info, #3b82f6), transparent 85%);
    border: 1px solid color-mix(in srgb, var(--color-info, #3b82f6), transparent 70%);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-1);
    font-style: italic;
    text-align: center;
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-2);
    justify-content: center;
    text-align: center;
  }

  .empty-state p {
    font-size: var(--font-size-3);
  }

  .empty-state .hint {
    font-size: var(--font-size-1);
    max-inline-size: 400px;
  }
</style>

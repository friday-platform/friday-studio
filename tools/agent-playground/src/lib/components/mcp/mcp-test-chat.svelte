<!--
  MCP Test Chat — single-turn chat to verify an MCP server works end-to-end.

  Streams SSE events from POST /api/mcp-registry/:id/test-chat and renders
  assistant text, tool calls, and tool results.

  @component
  @prop serverId - The MCP server ID to test
  @prop workspaceId - Optional workspace ID for workspace-scoped credentials
-->

<script lang="ts">
  import { Button, IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { testChatEventStream, type TestChatEvent } from "../../queries/workspace-mcp-queries";
  import { workspaceQueries } from "../../queries";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  let message = $state("");
  let streaming = $state(false);
  let chatError = $state<string | null>(null);
  let assistantText = $state("");
  let toolCalls = $state<Array<{ toolCallId: string; toolName: string; input: unknown }>>([]);
  let toolResults = $state<Array<{ toolCallId: string; output: unknown }>>([]);

  const workspaceListQuery = createQuery(() => workspaceQueries.list());
  const workspaces = $derived(workspaceListQuery.data ?? []);

  let selectedWorkspaceId = $state<string | undefined>(undefined);

  async function send() {
    const text = message.trim();
    if (!text || streaming) return;

    streaming = true;
    chatError = null;
    assistantText = "";
    toolCalls = [];
    toolResults = [];

    try {
      const stream = testChatEventStream(serverId, text, selectedWorkspaceId);
      for await (const event of stream) {
        switch (event.type) {
          case "chunk":
            assistantText += event.text;
            break;
          case "tool_call":
            toolCalls = [
              ...toolCalls,
              {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: event.input,
              },
            ];
            break;
          case "tool_result":
            toolResults = [
              ...toolResults,
              {
                toolCallId: event.toolCallId,
                output: event.output,
              },
            ];
            break;
          case "error":
            chatError = event.error;
            break;
          case "done":
            break;
        }
      }
    } catch (e) {
      chatError = e instanceof Error ? e.message : String(e);
    } finally {
      streaming = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<section class="test-chat-section">
  <h3 class="section-title">Test Chat</h3>

  {#if workspaces.length > 0}
    <div class="workspace-selector">
      <label for="test-chat-workspace">Workspace context</label>
      <select id="test-chat-workspace" bind:value={selectedWorkspaceId}>
        <option value={undefined}>Global (no workspace)</option>
        {#each workspaces as ws (ws.id)}
          <option value={ws.id}>{ws.name || ws.id}</option>
        {/each}
      </select>
    </div>
  {/if}

  <div class="chat-history">
    {#if message.trim() && !streaming && !assistantText && !chatError}
      <!-- Message was sent but no response yet (should be brief) -->
    {/if}

    {#if assistantText || toolCalls.length > 0 || chatError || streaming}
      <div class="assistant-bubble">
        <span class="role-badge">Friday</span>
        {#if assistantText}
          <div class="assistant-text">{assistantText}</div>
        {/if}

        {#if toolCalls.length > 0}
          <div class="tool-calls">
            {#each toolCalls as call (call.toolCallId)}
              <div class="tool-call-row">
                <span class="tool-call-name">{call.toolName}</span>
                <span class="tool-call-status">
                  {#if toolResults.some((r) => r.toolCallId === call.toolCallId)}
                    <IconSmall.CheckCircle />
                    <span>Done</span>
                  {:else if streaming}
                    <span class="spinner"></span>
                    <span>Running…</span>
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {/if}

        {#if chatError}
          <div class="chat-error" role="alert">
            <IconSmall.XCircle />
            <span>{chatError}</span>
          </div>
        {/if}

        {#if streaming && !assistantText && toolCalls.length === 0}
          <div class="thinking-indicator">
            <span class="spinner"></span>
            <span>Thinking…</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="input-row">
    <textarea
      bind:value={message}
      onkeydown={handleKeydown}
      placeholder="Type a test message…"
      rows={2}
      disabled={streaming}
    ></textarea>
    <Button
      variant="primary"
      size="small"
      onclick={() => void send()}
      disabled={streaming || !message.trim()}
    >
      {#snippet prepend()}
        <IconSmall.CheckCircle />
      {/snippet}
      Send
    </Button>
  </div>
</section>

<style>
  .test-chat-section {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block-start: var(--size-4);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .workspace-selector {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .workspace-selector label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    text-transform: uppercase;
  }

  .workspace-selector select {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-2);
    padding: var(--size-1) var(--size-2);
  }

  .chat-history {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    min-block-size: 0;
  }

  .assistant-bubble {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .role-badge {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .assistant-text {
    color: var(--color-text);
    font-size: var(--font-size-2);
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-calls {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .tool-call-row {
    align-items: center;
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    justify-content: space-between;
    padding: var(--size-1) var(--size-2);
  }

  .tool-call-name {
    font-family: var(--font-family-monospace);
    font-weight: var(--font-weight-5);
  }

  .tool-call-status {
    align-items: center;
    color: var(--color-success);
    display: inline-flex;
    gap: 4px;
  }

  .chat-error {
    align-items: center;
    color: var(--color-error);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-1);
  }

  .thinking-indicator {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    display: flex;
    font-style: italic;
    gap: var(--size-2);
  }

  .spinner {
    animation: spin 1s linear infinite;
    block-size: 14px;
    border: 2px solid color-mix(in srgb, var(--color-text), transparent 80%);
    border-block-start-color: var(--color-accent);
    border-radius: 50%;
    display: inline-block;
    inline-size: 14px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .input-row {
    align-items: flex-end;
    display: flex;
    gap: var(--size-2);
  }

  .input-row textarea {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    flex: 1;
    font-family: inherit;
    font-size: var(--font-size-2);
    line-height: 1.5;
    min-block-size: var(--size-8);
    outline: none;
    padding: var(--size-2) var(--size-3);
    resize: vertical;
  }

  .input-row textarea::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  .input-row textarea:focus {
    border-color: var(--color-accent);
  }

  .input-row textarea:disabled {
    opacity: 0.6;
  }
</style>

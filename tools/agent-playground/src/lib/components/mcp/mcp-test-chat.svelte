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
  import { workspaceQueries } from "../../queries";
  import { testChatEventStream } from "../../queries/workspace-mcp-queries";

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
              { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input },
            ];
            break;
          case "tool_result":
            toolResults = [...toolResults, { toolCallId: event.toolCallId, output: event.output }];
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

  <div class="input-stack">
    <textarea
      bind:value={message}
      onkeydown={handleKeydown}
      placeholder="Type a test message…"
      rows={2}
      disabled={streaming}
    ></textarea>
    <div>
      <Button
        variant="primary"
        size="small"
        onclick={() => void send()}
        disabled={streaming || !message.trim()}
      >
        Send
      </Button>
    </div>
  </div>
</section>

<style>
  .test-chat-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .workspace-selector {
    align-items: center;
    display: flex;
    gap: var(--size-2);

    label {
      color: var(--text-faded);
      font-size: var(--font-size-3);
    }

    select {
      all: revert;
      appearance: auto;
      font-size: var(--font-size-3);
    }
  }

  .chat-history {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    min-block-size: 0;
  }

  .assistant-bubble {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .role-badge {
    color: color-mix(in srgb, var(--text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .assistant-text {
    color: var(--text);
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
    background: var(--surface-dark);
    border: 1px solid var(--border);
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
    color: var(--green-primary);
    display: inline-flex;
    gap: 4px;
  }

  .chat-error {
    align-items: center;
    color: var(--red-primary);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-1);
  }

  .thinking-indicator {
    align-items: center;
    color: color-mix(in srgb, var(--text), transparent 30%);
    display: flex;
    font-style: italic;
    gap: var(--size-2);
  }

  .spinner {
    animation: spin 1s linear infinite;
    block-size: 14px;
    border: 2px solid color-mix(in srgb, var(--text), transparent 80%);
    border-block-start-color: var(--purple-primary);
    border-radius: 50%;
    display: inline-block;
    inline-size: 14px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .input-stack {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .input-stack textarea {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-3);
    color: var(--text);
    font-family: inherit;
    font-size: var(--font-size-3);
    inline-size: 100%;
    line-height: 1.5;
    max-inline-size: 60ch;
    outline: none;
    padding: var(--size-3);
    resize: vertical;
  }

  .input-stack textarea::placeholder {
    color: var(--text-faded);
  }

  .input-stack textarea:focus {
    border-color: var(--text);
  }

  .input-stack textarea:disabled {
    opacity: 0.6;
  }
</style>

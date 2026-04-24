<script lang="ts">
  import DisplayArtifact from "$lib/modules/artifacts/display.svelte";
  import WorkspacePlan from "$lib/modules/artifacts/workspace-plan.svelte";
  import { getConversationContext } from "$lib/modules/conversation/context.svelte";
  import ArtifactAttached from "$lib/modules/messages/artifact-attached.svelte";
  import ConnectService from "$lib/modules/messages/connect-service.svelte";
  import ErrorMessage from "$lib/modules/messages/error-message.svelte";
  import { formatMessage, groupToolCalls } from "$lib/modules/messages/format";
  import Progress from "$lib/modules/messages/progress.svelte";
  import Request from "$lib/modules/messages/request.svelte";
  import Response from "$lib/modules/messages/response.svelte";
  import ToolCallGroup from "$lib/modules/messages/tool-call-group.svelte";
  import WorkspaceCreated from "$lib/modules/messages/workspace-created.svelte";

  const conversation = getConversationContext();
</script>

<div
  class="messages-container"
  style:--additional-padding="{conversation.textareaAdditionalSize}px"
  class:has-messages={conversation.hasMessages}
>
  <div class="messages-inner">
    {#each conversation.chat.messages ?? [] as messageContainer, index ((messageContainer.id, index))}
      {@const messages = groupToolCalls(
        messageContainer.parts
          .map((message) => formatMessage(messageContainer, message))
          .filter((part) => part !== undefined),
        messageContainer.parts,
      )}
      {#if messages.length > 0}
        <div class="message-parts">
          {#each messages as message, index (index)}
            {#if message}
              {#if message.type === "request"}
                <Request {message} />
              {:else if message.type === "text"}
                <Response {message} parts={messageContainer.parts} />
              {:else if message.type === "display_artifact" && message.artifactId}
                <DisplayArtifact artifactId={message.artifactId} />
              {:else if message.type === "workspace_planner"}
                <WorkspacePlan
                  artifactId={message.artifactId}
                  onApprove={() => {
                    conversation.chat.sendMessage({
                      text: "Approve this plan and create a workspace",
                    });
                  }}
                  onTest={() => {
                    conversation.chat.sendMessage({
                      text: "Test this plan and show me the result",
                    });
                  }}
                />
              {:else if message.type === "connect_service" && message.provider}
                <ConnectService provider={message.provider} chat={conversation.chat} />
              {:else if message.type === "workspace_creator"}
                <WorkspaceCreated output={message.output} />
              {:else if message.type === "artifact_attached"}
                <ArtifactAttached {message} />
              {:else if message.type === "tool_call_group"}
                <ToolCallGroup {message} />
              {:else if message.type === "error"}
                <ErrorMessage {message} />
              {/if}
            {/if}
          {/each}
        </div>
      {/if}
    {/each}

    {#if conversation.chat.status === "streaming" || conversation.chat.status === "submitted"}
      <Progress turnStartedAt={conversation.turnStartedAt} />
    {/if}
  </div>
</div>

<style>
  .messages-inner {
    block-size: max-content;
    padding-block: 0 calc(var(--size-40) + var(--additional-padding, 0));
  }

  .message-parts {
    display: flex;
    flex-direction: column;
    inline-size: 100%;
    gap: var(--size-1-5);
  }

  .message-parts :global(.component:has(article) + .component:has(.toggle)) {
    margin-block-start: calc(var(--size-6) - var(--size-1-5));
  }

  .messages-inner {
    display: flex;
    flex-direction: column;
    inline-size: 100%;
    gap: var(--size-6);
    margin: 0 auto;
    max-inline-size: var(--size-272);
    overflow: hidden;
    padding-inline: var(--size-16);
  }
</style>

<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import DisplayArtifact from "$lib/modules/artifacts/display.svelte";
  import WorkspacePlan from "$lib/modules/artifacts/workspace-plan.svelte";
  import { getConversationContext } from "$lib/modules/conversation/context.svelte";
  import ArtifactAttached from "$lib/modules/messages/artifact-attached.svelte";
  import ConnectService from "$lib/modules/messages/connect-service.svelte";
  import CredentialLinked from "$lib/modules/messages/credential-linked.svelte";
  import ErrorMessage from "$lib/modules/messages/error-message.svelte";
  import { formatMessage } from "$lib/modules/messages/format";
  import Intent from "$lib/modules/messages/intent.svelte";
  import Progress from "$lib/modules/messages/progress.svelte";
  import Reasoning from "$lib/modules/messages/reasoning.svelte";
  import Request from "$lib/modules/messages/request.svelte";
  import Response from "$lib/modules/messages/response.svelte";
  import ShowDetails from "$lib/modules/messages/show-details.svelte";
  import WorkspaceCreated from "$lib/modules/messages/workspace-created.svelte";
  import { SvelteMap } from "svelte/reactivity";

  const conversation = getConversationContext();

  const actionsAfterLastUser = $derived.by(() => {
    const lastAssistant = (conversation.chat?.messages ?? []).findLast(
      (msg) => msg.role === "assistant",
    );
    return lastAssistant ? lastAssistant.parts : [];
  });

  let showDetails = new SvelteMap<string, boolean>();
</script>

<div
  class="messages-container"
  style:--additional-padding="{conversation.textareaAdditionalSize}px"
  class:has-messages={conversation.hasMessages}
>
  <div class="messages-inner">
    {#each conversation.chat.messages ?? [] as messageContainer, index ((messageContainer.id, index))}
      {@const messages = messageContainer.parts
        .map((message) => formatMessage(messageContainer, message))
        .filter((part) => part !== undefined)}
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
              {:else if message.type === "credential_linked"}
                <CredentialLinked {message} />
              {:else if message.type === "artifact_attached"}
                <ArtifactAttached {message} />
              {:else if message.type === "intent"}
                <Intent {message} />
              {:else if message.type === "error"}
                <ErrorMessage {message} />
              {/if}
            {/if}
          {/each}
          {#if messageContainer.role === "assistant" && messageContainer.parts.some((part) => part.type === "text" && part.state === "done")}
            <div class="show-details" class:open={showDetails.get(messageContainer.id)}>
              <ShowDetails
                open={showDetails.get(messageContainer.id) ?? false}
                onclick={() => {
                  const status = showDetails.get(messageContainer.id) ?? false;
                  if (!status) {
                    trackEvent(GA4.SHOW_DETAILS_EXPAND);
                  }
                  showDetails.set(messageContainer.id, !status);
                }}
              />
            </div>
          {/if}

          {#if showDetails.get(messageContainer.id)}
            <Reasoning parts={messageContainer.parts} />
          {/if}
        </div>
      {/if}
    {/each}

    {#if conversation.chat.status === "streaming" || conversation.chat.status === "submitted"}
      <Progress actions={actionsAfterLastUser} turnStartedAt={conversation.turnStartedAt} />
    {/if}
  </div>
</div>

<div class="spacer" class:has-messages={conversation.hasMessages}></div>

<style>
  .spacer {
    flex: 0;

    &.has-messages {
      flex: 1;
    }
  }

  .messages-container {
    min-block-size: 100%;
  }

  .messages-inner {
    block-size: max-content;
    padding-block: var(--size-8) var(--size-32);
  }

  .message-parts {
    display: flex;
    flex-direction: column;
    inline-size: 100%;
    gap: var(--size-4);
  }

  .show-details {
    opacity: 0;
    visibility: hidden;
    transition: opacity 250ms ease;
  }

  .message-parts:hover .show-details,
  .show-details.open {
    opacity: 1;
    visibility: visible;
  }

  .messages-inner {
    display: flex;
    flex-direction: column;
    inline-size: 100%;
    gap: var(--size-8);
    margin: 0 auto;
    max-inline-size: var(--size-272);
    overflow: hidden;
    padding-inline: var(--size-16);
  }
</style>

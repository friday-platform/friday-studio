<script lang="ts">
import type { Chat } from "@ai-sdk/svelte";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import LinkAuthModal from "./link-auth-modal.svelte";
import MessageWrapper from "./wrapper.svelte";

type Props = { provider: string; chat: Chat<AtlasUIMessage> };

const { provider, chat }: Props = $props();

let providerDetails = $state<{
  id: string;
  type: "oauth" | "apikey";
  displayName: string;
  description: string;
  setupInstructions?: string;
  secretSchema?: { required?: string[] };
} | null>(null);
let error = $state<string | null>(null);

$effect(() => {
  async function fetchProvider() {
    const result = await parseResult(
      client.link.v1.providers[":id"].$get({ param: { id: provider } }),
    );
    if (result.ok) {
      providerDetails = {
        id: result.data.id,
        type: result.data.type,
        displayName: result.data.displayName,
        description: result.data.description,
        setupInstructions: result.data.setupInstructions,
        secretSchema: result.data.secretSchema as { required?: string[] } | undefined,
      };
    } else {
      error = "Failed to load provider details";
    }
  }
  fetchProvider();
});

function startOAuth() {
  const daemonUrl = getAtlasDaemonUrl();
  const url = new URL(`/api/link/v1/oauth/authorize/${provider}`, daemonUrl);
  url.searchParams.set("redirect_uri", window.location.href);
  window.location.href = url.href;
}

function handleModalSuccess(label: string) {
  if (providerDetails) {
    const syntheticMessage = `I've linked my ${providerDetails.displayName} account - ${label}`;
    chat.sendMessage({ text: syntheticMessage });
  }
}
</script>

<MessageWrapper>
	{#if error}
		<div class="link-auth-error">
			<p>{error}</p>
		</div>
	{:else if providerDetails}
		<div class="link-auth-request">
			<div class="header">
				<h3>Connect {providerDetails.displayName}</h3>
				<p class="description">{providerDetails.description}</p>
			</div>
			{#if providerDetails.type === 'oauth'}
				<button class="connect-button" onclick={startOAuth}>
					Connect {providerDetails.displayName}
				</button>
			{:else if providerDetails.type === 'apikey' && providerDetails.secretSchema?.required?.[0]}
				<LinkAuthModal
					provider={providerDetails.id}
					displayName={providerDetails.displayName}
					setupInstructions={providerDetails.setupInstructions}
					secretFieldName={providerDetails.secretSchema.required[0]}
					onSuccess={handleModalSuccess}
				>
					{#snippet triggerContents()}
						<button class="connect-button">
							Connect {providerDetails?.displayName}
						</button>
					{/snippet}
				</LinkAuthModal>
			{:else if providerDetails.type === 'apikey'}
				<p class="error">Provider missing secret schema</p>
			{:else}
				<button class="connect-button" disabled>
					Connect {providerDetails.displayName}
				</button>
			{/if}
		</div>
	{:else}
		<div class="link-auth-loading">
			<p>Loading provider details...</p>
		</div>
	{/if}
</MessageWrapper>

<style>
	.link-auth-request {
		background-color: var(--color-surface-2);
		border-radius: var(--radius-4);
		border: var(--size-px) solid var(--color-border-1);
		padding: var(--size-4);
		display: flex;
		flex-direction: column;
		gap: var(--size-3);
	}

	.header {
		display: flex;
		flex-direction: column;
		gap: var(--size-1);
	}

	.header h3 {
		font-size: var(--font-size-4);
		font-weight: var(--font-weight-6);
		margin: 0;
	}

	.description {
		font-size: var(--font-size-2);
		opacity: 0.7;
		margin: 0;
	}

	.connect-button {
		align-items: center;
		background-color: var(--color-yellow);
		block-size: var(--size-8);
		border-radius: var(--radius-3);
		color: var(--color-white);
		display: flex;
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-5);
		justify-content: center;
		transition: all 200ms ease;
	}

	.connect-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.connect-button:not(:disabled):hover {
		background-color: var(--color-text);
	}

	.link-auth-error,
	.link-auth-loading {
		padding: var(--size-3);
		font-size: var(--font-size-2);
		opacity: 0.7;
	}

	.link-auth-error {
		color: var(--color-red);
	}
</style>

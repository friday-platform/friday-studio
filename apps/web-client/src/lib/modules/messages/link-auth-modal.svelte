<script lang="ts">
import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { Snippet } from "svelte";
import { Dialog } from "$lib/components/dialog";

type Props = {
  provider: string;
  displayName: string;
  secretFieldName: string;
  onSuccess: (label: string) => void;
  triggerContents: Snippet;
};

let { provider, displayName, secretFieldName, onSuccess, triggerContents }: Props = $props();

let label = $state("");
let apiKey = $state("");
let isSubmitting = $state(false);
let error = $state<string | null>(null);

function resetForm() {
  label = "";
  apiKey = "";
  error = null;
}

async function handleSubmit(open: { set: (v: boolean) => void }) {
  if (!label.trim() || !apiKey.trim()) {
    error = "Both label and API key are required";
    return;
  }

  isSubmitting = true;
  error = null;

  try {
    const result = await parseResult(
      client.link.v1.credentials[":type"].$put({
        param: { type: "apikey" },
        json: { provider, label: label.trim(), secret: { [secretFieldName]: apiKey.trim() } },
      }),
    );

    if (result.ok) {
      onSuccess(label.trim());
      open.set(false);
      resetForm();
    } else {
      error = stringifyError(result.error);
    }
  } catch (err) {
    error = stringifyError(err);
  } finally {
    isSubmitting = false;
  }
}
</script>

<Dialog.Root
	onOpenChange={({ next }) => {
		if (!next) resetForm();
		return next;
	}}
>
	{#snippet children(open)}
		<Dialog.Trigger>
			{@render triggerContents()}
		</Dialog.Trigger>

		<Dialog.Content>
			<Dialog.Close />

			{#snippet header()}
				<Dialog.Title>Connect {displayName}</Dialog.Title>
			<Dialog.Description>
				Enter your credentials to connect {displayName}
			</Dialog.Description>
			{/snippet}

			{#snippet footer()}
				<form
					class="form"
					onsubmit={(e) => {
						e.preventDefault();
						handleSubmit(open);
					}}
				>
					<div class="field">
						<label for="label">Label</label>
						<input
							id="label"
							type="text"
							bind:value={label}
							placeholder="e.g., Work Account"
							disabled={isSubmitting}
							required
						/>
					</div>

					<div class="field">
						<label for="apikey">API Key</label>
						<input
							id="apikey"
							type="password"
							bind:value={apiKey}
							placeholder="Enter your API key"
							disabled={isSubmitting}
							required
						/>
					</div>

					{#if error}
						<div class="error">
							{error}
						</div>
					{/if}

					<div class="buttons">
						<Dialog.Button type="submit" disabled={isSubmitting} closeOnClick={false}>
							{isSubmitting ? "Connecting..." : "Connect"}
						</Dialog.Button>
						<Dialog.Cancel onclick={resetForm}>Cancel</Dialog.Cancel>
					</div>
				</form>
			{/snippet}
		</Dialog.Content>
	{/snippet}
</Dialog.Root>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--size-4);
		inline-size: 100%;
		max-inline-size: var(--size-96);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--size-1-5);
		text-align: start;
	}

	label {
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-5);
		opacity: 0.7;
	}

	input {
		background-color: var(--color-surface-2);
		block-size: var(--size-9);
		border-radius: var(--radius-3);
		border: var(--size-px) solid var(--color-border-1);
		color: var(--color-text);
		font-size: var(--font-size-3);
		padding-inline: var(--size-3);
		transition: all 200ms ease;
	}

	input:focus {
		border-color: var(--color-yellow);
		outline: none;
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	input::placeholder {
		color: color-mix(in oklch, var(--color-text) 50%, transparent);
	}

	.error {
		background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
		border-radius: var(--radius-2);
		border: var(--size-px) solid var(--color-red);
		color: var(--color-red);
		font-size: var(--font-size-2);
		padding: var(--size-2) var(--size-3);
	}

	.buttons {
		align-items: center;
		display: flex;
		flex-direction: column;
		gap: var(--size-1-5);
		inline-size: 100%;
	}

</style>

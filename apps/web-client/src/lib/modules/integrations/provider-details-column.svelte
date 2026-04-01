<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { invalidateAll } from "$app/navigation";
  import { Dialog } from "$lib/components/dialog";
  import { formatFullDate } from "$lib/utils/date";
  import { stripSlackAppId } from "$lib/modules/integrations/utils";

  type Props = {
    name: string;
    label?: string;
    displayName?: string | null;
    date: string;
    credentialId: string;
    isDefault?: boolean;
    provider?: string;
  };

  let { name, label, displayName, date, credentialId, isDefault, provider }: Props = $props();

  const isSlackApp = $derived(provider === "slack-app");
  const rawLabel = $derived(displayName ?? label);
  const displayLabel = $derived(rawLabel && isSlackApp ? stripSlackAppId(rawLabel) : rawLabel);
  const currentName = $derived(displayName ?? label ?? "");

  let inputValue = $state("");
  let isSaving = $state(false);
  let errorMessage = $state("");

  function resetForm() {
    inputValue = currentName;
    errorMessage = "";
  }

  async function handleSave(open: { set: (v: boolean) => void }) {
    const trimmed = inputValue.trim();

    if (!trimmed) {
      errorMessage = "Display name cannot be empty";
      return;
    }

    if (trimmed.length > 100) {
      errorMessage = "Display name must be 100 characters or less";
      return;
    }

    isSaving = true;
    errorMessage = "";

    try {
      const res = await parseResult(
        client.link.v1.credentials[":id"].$patch({
          param: { id: credentialId },
          json: { displayName: trimmed },
        }),
      );

      if (!res.ok) {
        errorMessage = "Failed to update credential name";
        return;
      }

      trackEvent(GA4.CREDENTIAL_RENAME, { credential_id: credentialId });
      await invalidateAll();
      open.set(false);
    } catch {
      errorMessage = "Failed to update credential name";
    } finally {
      isSaving = false;
    }
  }
</script>

<Dialog.Root
  onOpenChange={({ next }) => {
    if (next) resetForm();
    return next;
  }}
>
  {#snippet children(open)}
    <div class="component">
      <div class="header">
        <span class="provider">{name}</span>
        {#if displayLabel}
          <span>•</span>
          {#if isSlackApp}
            <span class="account">{displayLabel}</span>
          {:else}
            <Dialog.Trigger>
              <span class="account">{displayLabel}</span>
            </Dialog.Trigger>
          {/if}
        {/if}
        {#if isDefault && provider !== "slack-app"}
          <span class="default-badge">Default</span>
        {/if}
      </div>
      {#if date}
        <time datetime={date}>{formatFullDate(date)}</time>
      {/if}
    </div>

    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Rename credential</Dialog.Title>
        <Dialog.Description>
          <p>Change the display name for this credential</p>
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <form
          class="form"
          onsubmit={(e) => {
            e.preventDefault();
            handleSave(open);
          }}
        >
          <div class="field">
            <label for="displayName-{credentialId}">Name</label>
            <input
              id="displayName-{credentialId}"
              type="text"
              bind:value={inputValue}
              placeholder="Enter display name"
              disabled={isSaving}
              maxlength={100}
              required
            />
          </div>

          {#if errorMessage}
            <div class="error">
              {errorMessage}
            </div>
          {/if}

          <div class="buttons">
            <Dialog.Button type="submit" disabled={isSaving} closeOnClick={false}>
              {isSaving ? "Saving..." : "Save"}
            </Dialog.Button>
            <Dialog.Cancel>Cancel</Dialog.Cancel>
          </div>
        </form>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .component {
    display: flex;
    flex-direction: column;
  }

  span,
  time {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .header {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .provider {
    font-size: var(--font-size-3);
    opacity: 1;
    font-weight: var(--font-weight-5);
  }

  .account {
    cursor: pointer;
    font-size: var(--font-size-2);
    opacity: 0.6;
    transition: opacity 150ms ease;

    &:hover {
      opacity: 1;
    }
  }

  .default-badge {
    background-color: var(--accent-1);
    border-radius: var(--radius-round);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    opacity: 1;
    padding-block: var(--size-0-5);
    padding-inline: var(--size-2);
  }

  time {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

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

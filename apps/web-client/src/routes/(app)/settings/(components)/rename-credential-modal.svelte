<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { invalidateAll } from "$app/navigation";
  import Button from "$lib/components/button.svelte";
  import { Dialog } from "$lib/components/dialog";

  interface Props {
    credentialId: string;
    currentName: string;
  }

  let { credentialId, currentName }: Props = $props();

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
    <Dialog.Trigger>
      <Button size="small">Rename</Button>
    </Dialog.Trigger>

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
            <label for="displayName">Name</label>
            <input
              id="displayName"
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

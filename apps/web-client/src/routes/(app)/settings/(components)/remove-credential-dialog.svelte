<script lang="ts">
  import Button from "$lib/components/button.svelte";
  import { Dialog } from "$lib/components/dialog";

  interface Props {
    credentialId: string;
    provider: string;
    displayName: string;
    onRemove: (id: string, provider: string) => Promise<void>;
  }

  let { credentialId, provider, displayName, onRemove }: Props = $props();

  let isDeleting = $state(false);

  async function handleDelete(open: { set: (v: boolean) => void }) {
    isDeleting = true;
    try {
      await onRemove(credentialId, provider);
      open.set(false);
    } finally {
      isDeleting = false;
    }
  }
</script>

<Dialog.Root>
  {#snippet children(open)}
    <Dialog.Trigger>
      <Button size="small">Delete</Button>
    </Dialog.Trigger>

    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Delete Credential</Dialog.Title>
        <Dialog.Description>
          <span>{provider} • {displayName}</span>
          <p>Existing workspaces may be affected by this change.</p>
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <div class="buttons">
          <Dialog.Button
            onclick={() => handleDelete(open)}
            disabled={isDeleting}
            closeOnClick={false}
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </Dialog.Button>
          <Dialog.Cancel>Cancel</Dialog.Cancel>
        </div>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  p {
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  span {
    font-size: var(--font-size-3);
    opacity: 0.6;
  }

  p {
    margin-block-start: var(--size-3);
  }

  .buttons {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    inline-size: 100%;
  }
</style>

<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { invalidateAll } from "$app/navigation";
  import { Dialog } from "$lib/components/dialog";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { toast } from "$lib/components/notification/notification.svelte";

  type Props = {
    credentialId: string;
    provider: string;
    displayName: string;
    isDefault: boolean;
    onRemove: (id: string, provider: string) => Promise<void>;
  };

  let { credentialId, provider, displayName, isDefault, onRemove }: Props = $props();

  let isSettingDefault = $state(false);
  let isDeleting = $state(false);

  async function handleSetDefault() {
    isSettingDefault = true;
    try {
      const res = await parseResult(
        client.link.v1.credentials[":id"].default.$patch({ param: { id: credentialId } }),
      );

      if (!res.ok) {
        toast({ title: "Failed to set default credential", error: true });
        return;
      }

      trackEvent(GA4.CREDENTIAL_SET_DEFAULT, { credential_id: credentialId, provider });
      toast({ title: "Default credential updated" });
      await invalidateAll();
    } catch {
      toast({ title: "Failed to set default credential", error: true });
    } finally {
      isSettingDefault = false;
    }
  }

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

<DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
  <DropdownMenu.Trigger aria-label="Credential actions">
    <div class="trigger">
      <Icons.TripleDots />
    </div>
  </DropdownMenu.Trigger>

  <DropdownMenu.Content>
    {#if !isDefault}
      <DropdownMenu.Item onclick={handleSetDefault} disabled={isSettingDefault}>
        {isSettingDefault ? "Setting..." : "Set as default"}
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
    {/if}

    <Dialog.Root>
      {#snippet children(open)}
        <DropdownMenu.Item accent="destructive" onclick={() => open.set(true)}>
          {#snippet prepend()}
            <Icons.Trash />
          {/snippet}
          Remove
        </DropdownMenu.Item>

        <Dialog.Content>
          <Dialog.Close />

          {#snippet header()}
            <Dialog.Title>Delete credential</Dialog.Title>
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
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  .trigger {
    align-items: center;
    border-radius: var(--radius-2);
    color: var(--color-text);
    display: flex;
    justify-content: center;
    opacity: 0.5;
    padding: var(--size-1);
    transition: opacity 150ms ease;

    &:hover {
      opacity: 1;
    }
  }

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

<script lang="ts">
  import Button from "$lib/components/button.svelte";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import type { AvailableCredential } from "./types";

  type Props = {
    credentials: AvailableCredential[];
    selectedId: string | null;
    onselect: (credentialId: string) => void;
    onAddNew?: () => void;
  };

  let { credentials, selectedId, onselect, onAddNew }: Props = $props();

  const selectedCredential = $derived(credentials.find((c) => c.id === selectedId));
  const selectedLabel = $derived(
    selectedCredential
      ? (selectedCredential.displayName ??
          selectedCredential.userIdentifier ??
          selectedCredential.label)
      : "Select credential",
  );
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    <Button size="small" variant="secondary" isDropdown>
      {selectedLabel}
    </Button>
  </DropdownMenu.Trigger>

  <DropdownMenu.Content>
    {#each credentials as credential (credential.id)}
      <DropdownMenu.Item
        radio
        checked={credential.id === selectedId}
        onclick={() => onselect(credential.id)}
      >
        <span class="credential-option">
          <span class="credential-name">
            {credential.displayName ?? credential.userIdentifier ?? credential.label}
          </span>
          {#if credential.isDefault}
            <span class="default-badge">Default</span>
          {/if}
        </span>
      </DropdownMenu.Item>
    {/each}
    {#if onAddNew}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onclick={onAddNew}>Add new</DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  .credential-option {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
  }

  .credential-name {
    font-size: var(--font-size-2);
  }

  .default-badge {
    background-color: var(--accent-1);
    border-radius: var(--radius-round);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1-5);
  }
</style>

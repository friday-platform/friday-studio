<!--
  Manual config setup — two-section form for entries the doctor left without a
  Link provider (verdict `clean` or `unknown`).

  Credentials rows go to a new Link provider; settings rows go to the entry's
  startup.env as plain strings. Both lists may be empty — the user might know
  only credentials, only settings, or a mix. Submit posts the combined payload
  via `useManualConfigMCP`.

  @component
  @prop serverId - Server identifier the config applies to
  @prop onDone - Called after a successful save (to collapse the inline panel)
-->

<script lang="ts">
  import { Button, IconSmall, toast } from "@atlas/ui";
  import {
    type ManualConfigInput,
    useManualConfigMCP,
  } from "$lib/queries/mcp-queries";

  interface Props {
    serverId: string;
    onDone?: () => void;
  }

  let { serverId, onDone }: Props = $props();

  // ---------------------------------------------------------------------------
  // Editable rows — local UI state, not query data, so plain $state is correct.
  // ---------------------------------------------------------------------------

  interface CredentialRow {
    name: string;
    description: string;
    isRequired: boolean;
  }

  interface SettingRow {
    name: string;
    description: string;
    default: string;
  }

  let credentials = $state<CredentialRow[]>([]);
  let settings = $state<SettingRow[]>([]);

  function addCredential(): void {
    credentials.push({ name: "", description: "", isRequired: true });
  }

  function removeCredential(index: number): void {
    credentials.splice(index, 1);
  }

  function addSetting(): void {
    settings.push({ name: "", description: "", default: "" });
  }

  function removeSetting(index: number): void {
    settings.splice(index, 1);
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const manualConfigMut = useManualConfigMCP();

  // A submit is meaningful only when at least one named row exists.
  const hasNamedRows = $derived(
    credentials.some((c) => c.name.trim().length > 0) ||
      settings.some((s) => s.name.trim().length > 0),
  );

  async function handleSave(): Promise<void> {
    if (manualConfigMut.isPending) return;

    const config: ManualConfigInput = {
      credentials: credentials
        .filter((c) => c.name.trim().length > 0)
        .map((c) => ({
          name: c.name.trim(),
          description: c.description.trim() || undefined,
          isRequired: c.isRequired,
        })),
      settings: settings
        .filter((s) => s.name.trim().length > 0)
        .map((s) => ({
          name: s.name.trim(),
          description: s.description.trim() || undefined,
          default: s.default.trim() || undefined,
        })),
    };

    try {
      await manualConfigMut.mutateAsync({ id: serverId, config });
      toast({
        title: "Configuration saved",
        description: "Credentials and settings have been applied to this server.",
      });
      credentials = [];
      settings = [];
      onDone?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Configuration failed", description: message, error: true });
    }
  }
</script>

<div class="manual-config">
  <!-- Credentials -->
  <section class="config-section">
    <div class="section-head">
      <h4 class="section-name">Credentials</h4>
      <p class="section-hint">
        Secret values (tokens, keys) the server needs. Each one becomes a field
        in a credential record. Credential schema is frozen once saved —
        changing it later means uninstall and re-add.
      </p>
    </div>

    {#if credentials.length > 0}
      <div class="rows">
        {#each credentials as cred, index (index)}
          <div class="row">
            <div class="row-fields">
              <input
                class="row-input row-name"
                type="text"
                placeholder="Env var name (e.g. BITBUCKET_TOKEN)"
                bind:value={cred.name}
                disabled={manualConfigMut.isPending}
              />
              <input
                class="row-input"
                type="text"
                placeholder="Description (optional)"
                bind:value={cred.description}
                disabled={manualConfigMut.isPending}
              />
              <label class="row-check">
                <input
                  type="checkbox"
                  bind:checked={cred.isRequired}
                  disabled={manualConfigMut.isPending}
                />
                Required
              </label>
            </div>
            <Button
              variant="none"
              size="icon"
              aria-label="Remove credential"
              onclick={() => removeCredential(index)}
              disabled={manualConfigMut.isPending}
            >
              <IconSmall.TrashBin />
            </Button>
          </div>
        {/each}
      </div>
    {/if}

    <Button
      variant="secondary"
      size="small"
      onclick={addCredential}
      disabled={manualConfigMut.isPending}
    >
      {#snippet prepend()}
        <IconSmall.Plus />
      {/snippet}
      Add credential
    </Button>
  </section>

  <!-- Settings -->
  <section class="config-section">
    <div class="section-head">
      <h4 class="section-name">Settings</h4>
      <p class="section-hint">
        Non-secret values with a default — written as plain environment
        variables. Editable per workspace later.
      </p>
    </div>

    {#if settings.length > 0}
      <div class="rows">
        {#each settings as setting, index (index)}
          <div class="row">
            <div class="row-fields">
              <input
                class="row-input row-name"
                type="text"
                placeholder="Env var name (e.g. BITBUCKET_URL)"
                bind:value={setting.name}
                disabled={manualConfigMut.isPending}
              />
              <input
                class="row-input"
                type="text"
                placeholder="Description (optional)"
                bind:value={setting.description}
                disabled={manualConfigMut.isPending}
              />
              <input
                class="row-input"
                type="text"
                placeholder="Default value (optional)"
                bind:value={setting.default}
                disabled={manualConfigMut.isPending}
              />
            </div>
            <Button
              variant="none"
              size="icon"
              aria-label="Remove setting"
              onclick={() => removeSetting(index)}
              disabled={manualConfigMut.isPending}
            >
              <IconSmall.TrashBin />
            </Button>
          </div>
        {/each}
      </div>
    {/if}

    <Button
      variant="secondary"
      size="small"
      onclick={addSetting}
      disabled={manualConfigMut.isPending}
    >
      {#snippet prepend()}
        <IconSmall.Plus />
      {/snippet}
      Add setting
    </Button>
  </section>

  <div class="save-bar">
    <Button
      variant="primary"
      size="small"
      onclick={handleSave}
      disabled={manualConfigMut.isPending || !hasNamedRows}
    >
      {manualConfigMut.isPending ? "Saving…" : "Save"}
    </Button>
  </div>
</div>

<style>
  .manual-config {
    background: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
    padding: var(--size-4);
  }

  .config-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .section-head {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .section-name {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .section-hint {
    color: var(--text-faded);
    font-size: var(--font-size-1);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 64ch;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .row {
    align-items: flex-start;
    display: flex;
    gap: var(--size-2);
  }

  .row-fields {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .row-input {
    background: var(--surface-bright);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    flex: 1;
    font-size: var(--font-size-2);
    min-inline-size: 12ch;
    padding: var(--size-1-5) var(--size-2);
  }

  .row-input:focus {
    outline: 2px solid var(--purple-primary);
    outline-offset: -2px;
  }

  .row-name {
    font-family: var(--font-family-monospace);
  }

  .row-check {
    align-items: center;
    color: var(--text-faded);
    display: flex;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    gap: var(--size-1);
  }

  .save-bar {
    display: flex;
    justify-content: flex-end;
  }
</style>

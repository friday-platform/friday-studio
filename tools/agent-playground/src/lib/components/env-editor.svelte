<script lang="ts">
  /**
   * Dynamic key-value editor for agent environment variables.
   * Pre-populates required/optional keys from agent metadata.
   * Values are password-masked by default with a reveal toggle.
   */

  import { Button, Icons } from "@atlas/ui";

  type ConfigField = { key: string; description: string; default?: string };

  type Props = {
    requiredConfig?: ConfigField[];
    optionalConfig?: ConfigField[];
    onEnvChange: (env: Record<string, string>) => void;
  };

  type Row = {
    id: number;
    key: string;
    value: string;
    description: string;
    required: boolean;
    revealed: boolean;
  };

  let { requiredConfig = [], optionalConfig = [], onEnvChange }: Props = $props();

  let idCounter = 0;

  function buildRows(required: ConfigField[], optional: ConfigField[]): Row[] {
    idCounter = 0;
    const result: Row[] = [];
    for (const field of required) {
      result.push({
        id: idCounter++,
        key: field.key,
        value: "",
        description: field.description,
        required: true,
        revealed: false,
      });
    }
    for (const field of optional) {
      result.push({
        id: idCounter++,
        key: field.key,
        value: field.default ?? "",
        description: field.description,
        required: false,
        revealed: false,
      });
    }
    return result;
  }

  // eslint-disable-next-line svelte/prefer-writable-derived -- rows needs $state proxy for in-place mutations (.push, element property writes)
  let rows = $state<Row[]>([]);

  /** Rebuild rows when config props change (agent selection changed). */
  $effect(() => {
    rows = buildRows(requiredConfig, optionalConfig);
  });

  /** Emit non-empty values whenever rows change. */
  $effect(() => {
    const env: Record<string, string> = {};
    for (const row of rows) {
      const k = row.key.trim();
      const v = row.value.trim();
      if (k && v) {
        env[k] = v;
      }
    }
    onEnvChange(env);
  });

  /** Count of required keys missing a value. */
  let missingCount = $derived(rows.filter((r) => r.required && !r.value.trim()).length);

  function addRow() {
    rows.push({
      id: idCounter++,
      key: "",
      value: "",
      description: "",
      required: false,
      revealed: false,
    });
  }

  function removeRow(id: number) {
    rows = rows.filter((r) => r.id !== id);
  }

  function toggleReveal(id: number) {
    const row = rows.find((r) => r.id === id);
    if (row) {
      row.revealed = !row.revealed;
    }
  }
</script>

<div class="env-editor" role="group" aria-label="Environment variables">
  {#if rows.length > 0}
    <div class="rows">
      {#each rows as row (row.id)}
        <div class="row" class:warning={row.required && !row.value.trim()}>
          <div class="row-key">
            {#if row.required}
              <input
                class="input key-input"
                type="text"
                value={row.key}
                readonly
                aria-label="Variable name"
                title={row.description}
              />
            {:else if row.description}
              <input
                class="input key-input"
                type="text"
                value={row.key}
                readonly
                aria-label="Variable name"
                title={row.description}
              />
            {:else}
              <input
                class="input key-input"
                type="text"
                bind:value={row.key}
                placeholder="KEY"
                aria-label="Variable name"
              />
            {/if}
            {#if row.required}
              <span class="badge required-badge">required</span>
            {/if}
          </div>

          <div class="row-value">
            <input
              class="input value-input"
              type={row.revealed ? "text" : "password"}
              bind:value={row.value}
              placeholder={row.description || "Value"}
              aria-label="Variable value for {row.key}"
            />
            <Button
              variant="secondary"
              size="small"
              aria-label={row.revealed ? "Hide value" : "Show value"}
              onclick={() => toggleReveal(row.id)}
            >
              {#if row.revealed}
                <Icons.Eye />
              {:else}
                <Icons.EyeClosed />
              {/if}
            </Button>
            {#if !row.required && !row.description}
              <Button
                variant="secondary"
                size="small"
                aria-label="Remove variable"
                onclick={() => removeRow(row.id)}
              >
                <Icons.Close />
              </Button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="footer">
    <Button variant="secondary" size="small" onclick={addRow}>
      {#snippet prepend()}<Icons.Plus />{/snippet}
      Add variable
    </Button>
    {#if missingCount > 0}
      <span class="missing-hint">
        {missingCount} required {missingCount === 1 ? "key" : "keys"} missing
      </span>
    {/if}
  </div>
</div>

<style>
  .env-editor {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .row {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-2);
  }

  .row.warning {
    border-color: var(--color-error);
  }

  .row-key {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
  }

  .row-value {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .input {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    inline-size: 100%;
    padding-block: var(--size-1);
    padding-inline: var(--size-2);
  }

  .input:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 50%);
    outline: none;
  }

  .input[readonly] {
    cursor: default;
    opacity: 0.7;
  }

  .key-input {
    flex: 1;
    font-weight: var(--font-weight-5);
  }

  .value-input {
    flex: 1;
  }

  .badge {
    border-radius: var(--radius-1);
    flex-shrink: 0;
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-1);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1-5);
    text-transform: uppercase;
  }

  .required-badge {
    background-color: color-mix(in srgb, var(--color-error), transparent 85%);
    color: var(--color-error);
  }

  .footer {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
  }

  .missing-hint {
    color: var(--color-error);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }
</style>

<!--
  Controlled view that renders one row per declared workspace variable:
  label / description / input / inline error / Reset-to-default button.

  Parent owns the form state map (so identity + variables share the same
  Save / Discard, dirty tracking, and seeding cycle). This component only
  reports user intent through `onChange(name, value | null)`:

  - `string` — the user typed this value.
  - `null` — the user clicked "Reset to default" on a row that declares
    `schema.default`. The parent should DELETE the env key on Save, after
    which the resolver falls back to the schema default.

  Renders nothing (no heading, no wrapper) when `variables` is empty —
  the Settings page should look identical to a workspace that doesn't
  declare any variables at all.

  Validation lives in the parent: the `errors` map is consulted on blur
  only, so the user isn't yelled at while they're still typing.

  @component
-->
<script lang="ts">
  import type { VariableState } from "@atlas/workspace";
  import { isSecretKey } from "$lib/workspace-variables/validate.ts";

  interface Props {
    variables: VariableState[];
    values: Record<string, string | null>;
    errors: Record<string, string | undefined>;
    onChange: (name: string, value: string | null) => void;
  }

  const { variables, values, errors, onChange }: Props = $props();

  // Per-row touched flag — gates the inline error so validation messages
  // surface on blur, not on every keystroke. Local UX state, never
  // observed by the parent.
  let touched = $state<Record<string, boolean>>({});

  function inputValueFor(v: VariableState): string {
    const local = values[v.name];
    if (typeof local === "string") return local;
    if (local === null) {
      // Reset clicked — surface the schema default immediately so the row
      // doesn't briefly flash the soon-to-be-deleted env value.
      return v.declaration.schema.default?.toString() ?? "";
    }
    // Untouched: render whatever the resolver decided was effective
    // (env value, default fallback, or empty).
    return v.effective_value ?? v.declaration.schema.default?.toString() ?? "";
  }

  function labelFor(v: VariableState): string {
    return v.declaration.display_name ?? v.name;
  }

  function inputType(name: string): "password" | "text" {
    return isSecretKey(name) ? "password" : "text";
  }

  function hasDefault(v: VariableState): boolean {
    return v.declaration.schema.default !== undefined;
  }
</script>

{#if variables.length > 0}
  <div class="var-list" data-testid="workspace-variables-fields">
    {#each variables as variable (variable.name)}
      {@const visibleError = touched[variable.name] ? errors[variable.name] : undefined}
      {@const inputId = `workspace-var-${variable.name}`}
      <div class="var-group" class:invalid={visibleError !== undefined}>
        <label class="var-label" for={inputId}>{labelFor(variable)}</label>
        {#if variable.declaration.description}
          <p class="var-description">{variable.declaration.description}</p>
        {/if}
        <div class="var-input-row">
          <input
            id={inputId}
            class="var-input"
            type={inputType(variable.name)}
            autocomplete="off"
            spellcheck="false"
            value={inputValueFor(variable)}
            oninput={(e) => onChange(variable.name, e.currentTarget.value)}
            onblur={() => {
              touched = { ...touched, [variable.name]: true };
            }}
          />
          {#if hasDefault(variable)}
            <button
              type="button"
              class="reset-btn"
              onclick={() => onChange(variable.name, null)}
              data-testid={`reset-${variable.name}`}
            >
              Reset to default
            </button>
          {/if}
        </div>
        {#if visibleError !== undefined}
          <p class="validation-error" role="alert">{visibleError}</p>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .var-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    max-inline-size: 60ch;
  }

  .var-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .var-label {
    color: var(--text-bright);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .var-description {
    color: color-mix(in srgb, var(--text), transparent 25%);
    font-size: var(--font-size-2);
    line-height: 1.4;
    margin: 0;
  }

  .var-input-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .var-input {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    flex: 1;
    font: inherit;
    font-size: var(--font-size-3);
    padding: var(--size-2) var(--size-3);
  }

  .var-input:focus {
    border-color: var(--blue-primary);
    outline: none;
  }

  .var-group.invalid .var-input {
    border-color: var(--red-primary);
  }

  .reset-btn {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    cursor: pointer;
    flex-shrink: 0;
    font: inherit;
    font-size: var(--font-size-2);
    padding: var(--size-1-5) var(--size-2-5);
  }

  .reset-btn:hover {
    background-color: color-mix(in srgb, var(--text), transparent 92%);
  }

  .validation-error {
    color: var(--red-primary);
    font-size: var(--font-size-2);
    line-height: 1.35;
    margin: 0;
  }
</style>

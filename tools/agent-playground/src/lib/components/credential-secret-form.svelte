<!--
  CredentialSecretForm — presentational form for API-key credential secrets.

  Renders dynamic fields from a provider's JSON secretSchema and supports
  both add-new mode (editable label) and replace mode (static label).

  @component
  @prop secretSchema - JSON Schema shape with properties and required fields
  @prop initialLabel - Static label to display in replace mode (optional)
  @prop submitting - Whether a submission is in progress (disables inputs)
  @prop error - Inline error message to display (optional)
  @prop onSubmit - Called with (label, secret) after client-side validation
-->

<script lang="ts">
  import { Button } from "@atlas/ui";
  import { z } from "zod";

  // ─── Props ─────────────────────────────────────────────────────────────────

  interface Props {
    secretSchema: {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    initialLabel?: string;
    submitting: boolean;
    error: string | null;
    onSubmit: (label: string, secret: Record<string, string>) => void;
    onCancel?: () => void;
  }

  let {
    secretSchema,
    initialLabel,
    submitting,
    error,
    onSubmit,
    onCancel,
  }: Props = $props();

  // ─── State ─────────────────────────────────────────────────────────────────

  let label = $state("");
  let fieldValues = $state<Record<string, string>>({});
  let validationError = $state<string | null>(null);

  // ─── Derived ─────────────────────────────────────────────────────────────────

  const schemaShape = $derived.by(() => {
    const shape = z.object({
      properties: z.record(z.string(), z.object({}).passthrough()).optional(),
      required: z.array(z.string()).optional(),
    });
    const parsed = shape.safeParse(secretSchema);
    if (!parsed.success) return null;
    return parsed.data;
  });

  const secretFields = $derived.by(() => {
    if (!schemaShape?.properties) return [];
    const required = new Set(schemaShape.required ?? []);
    return Object.keys(schemaShape.properties).map((key) => ({
      key,
      label: secretKeyToLabel(key),
      required: required.has(key),
    }));
  });

  const isAddMode = $derived(initialLabel === undefined);

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function secretKeyToLabel(key: string): string {
    const upperWords = new Set(["api", "id", "url", "uri", "sql", "ssh"]);
    return key
      .split("_")
      .map((w) =>
        upperWords.has(w.toLowerCase())
          ? w.toUpperCase()
          : w.charAt(0).toUpperCase() + w.slice(1),
      )
      .join(" ");
  }

  function isSensitiveField(key: string): boolean {
    return /password|secret|token|key/i.test(key);
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    validationError = null;

    const submitLabel = isAddMode ? label.trim() : initialLabel ?? "";

    if (isAddMode && !submitLabel) {
      validationError = "Label is required";
      return;
    }

    const missing = secretFields.filter(
      (f) => f.required && !fieldValues[f.key]?.trim(),
    );
    if (missing.length > 0) {
      validationError = `Required: ${missing.map((f) => f.label).join(", ")}`;
      return;
    }

    const secret: Record<string, string> = {};
    for (const field of secretFields) {
      const value = fieldValues[field.key]?.trim();
      if (value) secret[field.key] = value;
    }

    onSubmit(submitLabel, secret);
  }

  function handleCancel() {
    label = "";
    fieldValues = {};
    validationError = null;
    onCancel?.();
  }
</script>

<form class="credential-secret-form" onsubmit={handleSubmit}>
  {#if isAddMode}
    <div class="field">
      <label for="credential-label">Label</label>
      <input
        id="credential-label"
        type="text"
        bind:value={label}
        placeholder="e.g., Work Account"
        disabled={submitting}
        required
      />
    </div>
  {:else}
    <div class="field static-label">
      <span class="label-text">Label</span>
      <span class="value-text">{initialLabel}</span>
    </div>
  {/if}

  {#each secretFields as field (field.key)}
    <div class="field">
      <label for="credential-{field.key}">{field.label}</label>
      <input
        id="credential-{field.key}"
        type={isSensitiveField(field.key) ? "password" : "text"}
        bind:value={fieldValues[field.key]}
        placeholder={field.required
          ? `Enter ${field.label.toLowerCase()}`
          : `${field.label} (optional)`}
        disabled={submitting}
        required={field.required}
      />
    </div>
  {/each}

  {#if error}
    <div class="form-error">{error}</div>
  {/if}

  {#if validationError}
    <div class="form-error">{validationError}</div>
  {/if}

  <div class="form-actions">
    {#if isAddMode}
      <Button
        variant="secondary"
        size="small"
        onclick={handleCancel}
        disabled={submitting}
      >
        Cancel
      </Button>
    {/if}
    <Button variant="primary" size="small" type="submit" disabled={submitting}>
      {submitting ? "Saving…" : isAddMode ? "Connect" : "Replace"}
    </Button>
  </div>
</form>

<style>
  .credential-secret-form {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .field label,
  .field .label-text {
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-4);
    color: var(--color-text);
  }

  .field input {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
    width: 100%;
  }

  .field input:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .static-label {
    background: var(--color-surface-3);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    padding: var(--size-2) var(--size-3);
  }

  .static-label .value-text {
    font-size: var(--font-size-2);
    color: var(--color-text);
  }

  .form-error {
    background: color-mix(in srgb, var(--color-error), transparent 90%);
    border: 1px solid var(--color-error);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-1);
    padding: var(--size-2) var(--size-3);
  }

  .form-actions {
    display: flex;
    gap: var(--size-2);
    justify-content: flex-end;
  }
</style>

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
    onSubmit: (
      label: string,
      secret: Record<string, string | number>,
    ) => void;
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

  /**
   * Mirrors `SecretPropertySchema` from `link-provider-queries.ts`: the JSON
   * Schema property descriptor that the Link service emits. `type` widens to
   * include `integer`/`number` so providers with numeric fields (e.g. the
   * github-app App ID / installation_id) parse. `format: "multiline"` is a
   * Friday convention surfaced via `.meta()` on the Zod side so the form can
   * render a textarea (e.g. PEM private keys). Unknown keys pass through so
   * older providers that ship a bare `{ type: "string" }` still parse cleanly.
   */
  const PropertyShape = z.looseObject({
    type: z.enum(["string", "integer", "number"]),
    description: z.string().optional(),
    format: z.union([z.literal("password"), z.literal("multiline"), z.string()]).optional(),
    writeOnly: z.boolean().optional(),
  });

  const schemaShape = $derived.by(() => {
    const shape = z.object({
      properties: z.record(z.string(), PropertyShape).optional(),
      required: z.array(z.string()).optional(),
    });
    const parsed = shape.safeParse(secretSchema);
    if (!parsed.success) return null;
    return parsed.data;
  });

  type FieldType = "string" | "integer" | "number";

  const secretFields = $derived.by(() => {
    if (!schemaShape?.properties) return [];
    const required = new Set(schemaShape.required ?? []);
    return Object.entries(schemaShape.properties).map(([key, prop]) => {
      const type: FieldType = prop.type ?? "string";
      const multiline = prop.format === "multiline";
      return {
        key,
        label: secretKeyToLabel(key),
        description: prop.description ?? "",
        required: required.has(key),
        type,
        multiline,
        // Single-line text-mode sensitive fields render as `<input type="password">`.
        // Multiline (PEM) fields use a textarea regardless.
        masked: !multiline && (prop.format === "password" || isSensitiveField(key)),
      };
    });
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

  /**
   * Heuristic fallback for hardcoded providers (and pre-descriptor installs)
   * that don't emit `format` on the JSON Schema property — keeps existing
   * masking behavior unchanged when `format === "password"` is absent.
   */
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

    const secret: Record<string, string | number> = {};
    for (const field of secretFields) {
      const value = fieldValues[field.key]?.trim();
      if (!value) continue;

      if (field.type === "integer" || field.type === "number") {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          validationError = `${field.label} must be a number`;
          return;
        }
        if (field.type === "integer" && !Number.isInteger(num)) {
          validationError = `${field.label} must be an integer`;
          return;
        }
        secret[field.key] = num;
      } else {
        secret[field.key] = value;
      }
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
      <label for="credential-{field.key}">
        <span class="label-text">{field.label}</span>
        {#if !field.required}
          <span class="tag" data-tone="neutral">optional</span>
        {/if}
      </label>
      {#if field.multiline}
        <textarea
          id="credential-{field.key}"
          class="multiline"
          bind:value={fieldValues[field.key]}
          placeholder={field.required
            ? `Enter ${field.label.toLowerCase()}`
            : `${field.label} (optional)`}
          disabled={submitting}
          required={field.required}
          rows="6"
        ></textarea>
      {:else}
        <input
          id="credential-{field.key}"
          type={field.masked ? "password" : "text"}
          inputmode={field.type === "integer" || field.type === "number"
            ? "numeric"
            : undefined}
          pattern={field.type === "integer" ? "[0-9]*" : undefined}
          bind:value={fieldValues[field.key]}
          placeholder={field.required
            ? `Enter ${field.label.toLowerCase()}`
            : `${field.label} (optional)`}
          disabled={submitting}
          required={field.required}
        />
      {/if}
      {#if field.description}
        <p class="field-help">{field.description}</p>
      {/if}
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

  .field label {
    align-items: baseline;
    display: flex;
    gap: var(--size-1-5);
  }

  .field-help {
    color: var(--color-text-muted, var(--color-text));
    font-size: var(--font-size-1);
    line-height: 1.4;
    margin: 0;
    opacity: 0.75;
  }

  .tag {
    background-color: var(--highlight);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-1-5);
    white-space: nowrap;
  }

  .field input,
  .field textarea {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
    width: 100%;
  }

  .field textarea.multiline {
    font-family: var(--font-family-monospace);
    resize: vertical;
  }

  .field input:focus,
  .field textarea:focus {
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

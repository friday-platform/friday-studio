<!--
  Dynamic form for agents with structured JSON input (gh, bb, jira).
  Renders operation dropdown from oneOf schema variants and dynamic fields
  per selected operation. Includes raw JSON toggle for power users.

  @component
  @param {object} schema - JSON Schema with oneOf variants (discriminated union)
  @param {(value: string) => void} onInput - Called with serialized JSON on every change
-->
<script lang="ts">
  import {
    getFieldRendering,
    humanizeFieldName,
    parseFieldDef,
    type FieldDef,
  } from "$lib/utils/field-helpers";

  type Variant = { operation: string; properties: Record<string, unknown>; required: Set<string> };

  type Props = { schema: Record<string, unknown>; onInput: (value: string) => void };

  let { schema, onInput }: Props = $props();

  let rawMode = $state(false);
  let rawJson = $state("");
  let rawError = $state<string | null>(null);
  let formData = $state<Record<string, unknown>>({});
  let selectedOperation = $state("");

  /** Parse oneOf variants from JSON Schema. */
  const variants = $derived.by((): Variant[] => {
    const oneOf = schema["oneOf"];
    if (!Array.isArray(oneOf)) return [];

    const result: Variant[] = [];
    for (const variant of oneOf) {
      if (typeof variant !== "object" || variant === null) continue;
      if (
        !("properties" in variant) ||
        typeof variant.properties !== "object" ||
        !variant.properties
      )
        continue;
      const props = variant.properties;
      if (!("operation" in props) || typeof props.operation !== "object" || !props.operation)
        continue;
      if (!("const" in props.operation) || typeof props.operation.const !== "string") continue;

      const req =
        "required" in variant && Array.isArray(variant.required)
          ? new Set<string>(
              variant.required.filter((r: unknown): r is string => typeof r === "string"),
            )
          : new Set<string>();

      result.push({ operation: props.operation.const, properties: { ...props }, required: req });
    }
    return result;
  });

  /** Auto-select first operation when variants change. */
  $effect(() => {
    if (variants.length > 0 && !variants.some((v) => v.operation === selectedOperation)) {
      selectedOperation = variants[0].operation;
      formData = {};
    }
  });

  const activeVariant = $derived(variants.find((v) => v.operation === selectedOperation));

  /** Fields for the active variant, excluding the auto-set "operation" field. */
  const fields = $derived.by((): [string, FieldDef, unknown][] => {
    if (!activeVariant) return [];
    return Object.entries(activeVariant.properties)
      .filter(([key]) => key !== "operation")
      .map(([key, val]) => [key, parseFieldDef(val), val]);
  });

  /** Serialize current form state to JSON and notify parent. */
  function emitJson() {
    const payload: Record<string, unknown> = { operation: selectedOperation };
    for (const [key] of fields) {
      const val = formData[key];
      if (val !== undefined && val !== "") {
        payload[key] = val;
      }
    }
    const json = JSON.stringify(payload, null, 2);
    rawJson = json;
    onInput(json);
  }

  /** Emit on every form change. */
  $effect(() => {
    // Subscribe to reactive deps
    void selectedOperation;
    void formData;
    void fields;
    emitJson();
  });

  function handleOperationChange(op: string) {
    selectedOperation = op;
    formData = {};
  }

  function toggleRawMode() {
    if (rawMode) {
      // Switching from raw -> form: parse JSON back into form state
      try {
        const parsed: unknown = JSON.parse(rawJson);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "operation" in parsed &&
          typeof parsed.operation === "string"
        ) {
          const op = parsed.operation;
          if (variants.some((v) => v.operation === op)) {
            selectedOperation = op;
            const newData: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(parsed)) {
              if (key !== "operation") newData[key] = val;
            }
            formData = newData;
          }
        }
        rawError = null;
      } catch {
        rawError = "Invalid JSON — form state not updated";
      }
    }
    rawMode = !rawMode;
  }

  function handleRawInput(value: string) {
    rawJson = value;
    rawError = null;
    try {
      JSON.parse(value);
      onInput(value);
    } catch {
      rawError = "Invalid JSON";
    }
  }

  /**
   * Determine if a field should render as a textarea (arrays/objects that
   * can't be represented with a simple input).
   */
  function isComplexField(rawSchema: unknown): boolean {
    if (typeof rawSchema !== "object" || rawSchema === null) return false;
    if (!("type" in rawSchema)) return false;
    return rawSchema.type === "array" || rawSchema.type === "object";
  }

  /** Build a placeholder hint for complex fields. */
  function complexPlaceholder(rawSchema: unknown): string {
    if (typeof rawSchema !== "object" || rawSchema === null || !("type" in rawSchema))
      return "Enter JSON";
    if (rawSchema.type === "array") {
      if ("items" in rawSchema && typeof rawSchema.items === "object" && rawSchema.items !== null) {
        if ("type" in rawSchema.items && rawSchema.items.type === "string")
          return '["value1", "value2"]';
      }
      return "[...]";
    }
    return "{...}";
  }
</script>

<div class="operation-form">
  <div class="header">
    <label class="section-label" for="operation-select">Operation</label>
    <button class="toggle-raw" type="button" onclick={toggleRawMode}>
      {rawMode ? "Form" : "Raw JSON"}
    </button>
  </div>

  {#if rawMode}
    <textarea
      class="raw-editor"
      value={rawJson}
      oninput={(e) => handleRawInput(e.currentTarget.value)}
      spellcheck={false}
    ></textarea>
    {#if rawError}
      <div class="error">{rawError}</div>
    {/if}
  {:else}
    <select
      id="operation-select"
      bind:value={selectedOperation}
      onchange={(e) => handleOperationChange(e.currentTarget.value)}
    >
      {#each variants as variant (variant.operation)}
        <option value={variant.operation}>{variant.operation}</option>
      {/each}
    </select>

    {#if activeVariant}
      {#each fields as [fieldName, fieldDef, rawSchema] (fieldName)}
        {@const fieldId = `op-field-${fieldName}`}
        {@const isRequired = activeVariant.required.has(fieldName)}
        {@const rendering = getFieldRendering(fieldDef)}
        {@const fieldLabel = fieldDef.title ?? humanizeFieldName(fieldName)}
        {@const isUrl = fieldDef.format === "uri"}
        {@const complex = isComplexField(rawSchema)}
        <div class="field">
          {#if rendering !== "boolean"}
            <label for={fieldId}>
              {fieldLabel}
              {#if isRequired}<span class="required">*</span>{/if}
            </label>
          {/if}
          {#if fieldDef.description}
            <span class="field-description">{fieldDef.description}</span>
          {/if}
          {#if rendering === "boolean"}
            <label class="checkbox-label">
              <input
                id={fieldId}
                type="checkbox"
                checked={formData[fieldName] === true}
                onchange={(e) => {
                  formData[fieldName] = e.currentTarget.checked;
                }}
              />
              <span>{fieldLabel}</span>
            </label>
          {:else if complex}
            <textarea
              id={fieldId}
              class="complex-field"
              value={typeof formData[fieldName] === "string" ? formData[fieldName] : ""}
              placeholder={complexPlaceholder(rawSchema)}
              oninput={(e) => {
                const val = e.currentTarget.value;
                try {
                  formData[fieldName] = JSON.parse(val);
                } catch {
                  formData[fieldName] = val;
                }
              }}
              spellcheck={false}
            ></textarea>
          {:else if rendering === "number"}
            <input
              id={fieldId}
              type="number"
              value={formData[fieldName] ?? ""}
              placeholder={`Enter ${fieldLabel.toLowerCase()}`}
              oninput={(e) => {
                const val = e.currentTarget.value;
                formData[fieldName] = val === "" ? undefined : Number(val);
              }}
              required={isRequired}
              step={fieldDef.type === "integer" ? "1" : "any"}
            />
          {:else}
            <input
              id={fieldId}
              type={isUrl ? "url" : "text"}
              value={formData[fieldName] ?? ""}
              placeholder={isUrl ? "https://..." : `Enter ${fieldLabel.toLowerCase()}`}
              oninput={(e) => {
                formData[fieldName] = e.currentTarget.value;
              }}
              required={isRequired}
            />
          {/if}
        </div>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .operation-form {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .toggle-raw {
    background: none;
    border: none;
    color: var(--color-accent);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: 0;
  }

  .toggle-raw:hover {
    text-decoration: underline;
  }

  select {
    appearance: none;
    background-color: var(--color-surface-2);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' viewBox='0 0 12 12'%3E%3Cpath stroke='%239ca3af' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='m3 4.5 3 3 3-3'/%3E%3C/svg%3E");
    background-position: right var(--size-2) center;
    background-repeat: no-repeat;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    font-size: var(--font-size-3);
    inline-size: 100%;
    padding-block: var(--size-2);
    padding-inline: var(--size-2-5);
    padding-inline-end: var(--size-8);
  }

  select:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    outline: none;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  label {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    opacity: 0.7;
  }

  .required {
    color: var(--color-red);
  }

  .field-description {
    color: var(--color-text);
    font-size: var(--font-size-2);
    opacity: 0.5;
    overflow-wrap: break-word;
  }

  input[type="text"],
  input[type="url"],
  input[type="number"] {
    background-color: var(--color-surface-2);
    block-size: var(--size-9);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: var(--color-text);
    font-size: var(--font-size-3);
    padding-inline: var(--size-3);
    transition: all 200ms ease;
  }

  input[type="text"]:focus,
  input[type="url"]:focus,
  input[type="number"]:focus {
    border-color: var(--color-accent);
    outline: none;
  }

  input[type="text"]::placeholder,
  input[type="url"]::placeholder,
  input[type="number"]::placeholder {
    color: color-mix(in oklch, var(--color-text) 50%, transparent);
  }

  .checkbox-label {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-weight: var(--font-weight-4);
    gap: var(--size-2);
    opacity: 1;
  }

  textarea,
  .raw-editor {
    background-color: var(--color-surface-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--font-size-2);
    min-block-size: var(--size-24);
    padding: var(--size-3);
    resize: vertical;
    transition: border-color 200ms ease;
  }

  .raw-editor {
    min-block-size: var(--size-48);
  }

  textarea:focus,
  .raw-editor:focus {
    border-color: var(--color-accent);
    outline: none;
  }

  .complex-field {
    min-block-size: var(--size-16);
  }

  .error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border: var(--size-px) solid var(--color-red);
    border-radius: var(--radius-2);
    color: var(--color-red);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
  }
</style>

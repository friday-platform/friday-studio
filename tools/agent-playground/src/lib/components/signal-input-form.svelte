<!--
  Schema-driven form for signal input payloads. Renders typed form fields
  from JSON Schema properties. Supports string, number, boolean, and
  complex (object/array as JSON textarea) field types.

  @component
  @param {Record<string, unknown>} schema - JSON Schema with properties/required
  @param {Record<string, unknown>} [values] - Current form values
  @param {(values: Record<string, unknown>) => void} onChange - Called on every field change
  @param {boolean} [compact] - Render fields inline horizontally
-->
<script lang="ts">
  import {
    getFieldRendering,
    humanizeFieldName,
    parseFieldDef,
    type FieldDef,
  } from "$lib/utils/field-helpers";
  import { generateExamplePayload } from "$lib/generate-example-payload";

  type Props = {
    schema: Record<string, unknown>;
    values?: Record<string, unknown>;
    onChange: (values: Record<string, unknown>) => void;
    compact?: boolean;
  };

  let { schema, values = {}, onChange, compact = false }: Props = $props();

  let formData = $state<Record<string, unknown>>({});

  /** Sync external values into local form state. */
  $effect(() => {
    formData = { ...values };
  });

  const schemaProperties = $derived.by((): [string, FieldDef, unknown][] => {
    const props = schema["properties"];
    if (!props || typeof props !== "object") return [];
    return Object.entries(props).map(([k, v]) => [k, parseFieldDef(v), v]);
  });

  const requiredFields = $derived.by(() => {
    const req = schema["required"];
    if (!Array.isArray(req)) return new Set<string>();
    return new Set(req.filter((v): v is string => typeof v === "string"));
  });

  const examplePayload = $derived(generateExamplePayload(schema));

  function emit() {
    onChange({ ...formData });
  }

  function handleTextInput(fieldName: string, value: string) {
    formData[fieldName] = value;
    emit();
  }

  function handleNumberInput(fieldName: string, value: string) {
    formData[fieldName] = value === "" ? undefined : Number(value);
    emit();
  }

  function handleBooleanInput(fieldName: string, checked: boolean) {
    formData[fieldName] = checked;
    emit();
  }

  function handleComplexInput(fieldName: string, value: string) {
    try {
      formData[fieldName] = JSON.parse(value);
    } catch {
      formData[fieldName] = value;
    }
    emit();
  }

  /** Determine if a field should render as a textarea (arrays/objects). */
  function isComplexField(rawSchema: unknown): boolean {
    if (typeof rawSchema !== "object" || rawSchema === null) return false;
    if (!("type" in rawSchema)) return false;
    return rawSchema.type === "array" || rawSchema.type === "object";
  }

  /** Build a placeholder hint for complex fields. */
  function complexPlaceholder(rawSchema: unknown): string {
    if (typeof rawSchema !== "object" || rawSchema === null) return "Enter JSON";
    if (!("type" in rawSchema)) return "Enter JSON";
    if (rawSchema.type === "array") {
      if ("items" in rawSchema && typeof rawSchema.items === "object" && rawSchema.items !== null) {
        if ("type" in rawSchema.items && rawSchema.items.type === "string") {
          return '["value1", "value2"]';
        }
      }
      return "[...]";
    }
    return "{...}";
  }

  /** Get a placeholder for a simple field from the example payload. */
  function getPlaceholder(fieldName: string, fieldLabel: string): string {
    const example = examplePayload[fieldName];
    if (typeof example === "string" && example.length > 0) return example;
    return `Enter ${fieldLabel.toLowerCase()}`;
  }
</script>

{#if schemaProperties.length > 0}
  <div class="signal-input-form" class:compact>
    {#each schemaProperties as [fieldName, fieldDef, rawSchema] (fieldName)}
      {@const fieldId = `signal-field-${fieldName}`}
      {@const isRequired = requiredFields.has(fieldName)}
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
        {#if fieldDef.description && !compact}
          <span class="field-description">{fieldDef.description}</span>
        {/if}
        {#if rendering === "boolean"}
          <label class="checkbox-label">
            <input
              id={fieldId}
              type="checkbox"
              checked={formData[fieldName] === true}
              onchange={(e) => handleBooleanInput(fieldName, e.currentTarget.checked)}
            />
            <span>
              {fieldLabel}
              {#if isRequired}<span class="required">*</span>{/if}
            </span>
          </label>
        {:else if complex}
          <textarea
            id={fieldId}
            class="complex-field"
            value={typeof formData[fieldName] === "string" ? formData[fieldName] : ""}
            placeholder={complexPlaceholder(rawSchema)}
            oninput={(e) => handleComplexInput(fieldName, e.currentTarget.value)}
            spellcheck={false}
          ></textarea>
        {:else if rendering === "number"}
          <input
            id={fieldId}
            type="number"
            value={formData[fieldName] ?? ""}
            placeholder={getPlaceholder(fieldName, fieldLabel)}
            oninput={(e) => handleNumberInput(fieldName, e.currentTarget.value)}
            required={isRequired}
            step={fieldDef.type === "integer" ? "1" : "any"}
          />
        {:else}
          <input
            id={fieldId}
            type={isUrl ? "url" : "text"}
            value={formData[fieldName] ?? ""}
            placeholder={isUrl ? "https://..." : getPlaceholder(fieldName, fieldLabel)}
            oninput={(e) => handleTextInput(fieldName, e.currentTarget.value)}
            required={isRequired}
          />
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .signal-input-form {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    inline-size: 100%;
  }

  .signal-input-form.compact {
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .compact .field {
    flex: 1 1 auto;
    min-inline-size: var(--size-32);
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
    border-color: var(--color-text);
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

  textarea {
    background-color: var(--color-surface-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--font-size-2);
    min-block-size: var(--size-16);
    padding: var(--size-3);
    resize: vertical;
    transition: border-color 200ms ease;
  }

  textarea:focus {
    border-color: var(--color-text);
    outline: none;
  }
</style>

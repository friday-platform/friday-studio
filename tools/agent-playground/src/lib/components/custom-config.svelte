<script lang="ts">
  /**
   * Custom agent configuration panel.
   * Composes model selector (provider + model ID), system prompt textarea,
   * and MCP server picker. Exposes all config state to parent via callbacks.
   */
  import { Button } from "@atlas/ui";
  import McpPicker from "./mcp-picker.svelte";

  type Provider = "anthropic" | "openai" | "google" | "groq";

  type Props = {
    env: Record<string, string>;
    onConfigChange: (config: {
      provider: Provider;
      model: string;
      systemPrompt: string;
      mcpServerIds: string[];
    }) => void;
    onToolsResolved: (
      tools: Array<{ name: string; description: string; inputSchema: unknown }>,
    ) => void;
  };

  let { env, onConfigChange, onToolsResolved }: Props = $props();

  const MODEL_PRESETS: Record<Provider, string[]> = {
    anthropic: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-opus-4-20250514"],
    openai: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
    google: ["gemini-2.0-flash", "gemini-2.0-pro"],
    groq: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
  };

  const PROVIDERS: Provider[] = ["anthropic", "openai", "google", "groq"];

  let provider = $state<Provider>("anthropic");
  let model = $state("claude-sonnet-4-20250514");
  let systemPrompt = $state("");
  let mcpServerIds = $state<string[]>([]);

  const presets = $derived(MODEL_PRESETS[provider]);
  const showPresets = $derived(presets.length > 0 && !presets.includes(model));

  /** Emit config whenever any field changes. */
  $effect(() => {
    onConfigChange({ provider, model, systemPrompt, mcpServerIds });
  });

  function handleProviderChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    const next = target.value as Provider;
    provider = next;
    model = MODEL_PRESETS[next][0];
  }

  function handleServersChange(ids: string[]) {
    mcpServerIds = ids;
  }
</script>

<div class="custom-config">
  <div class="model-section">
    <label class="section-label" for="provider-select">Model</label>
    <div class="model-row">
      <select id="provider-select" value={provider} onchange={handleProviderChange}>
        {#each PROVIDERS as p (p)}
          <option value={p}>{p}</option>
        {/each}
      </select>

      <input
        class="model-input"
        type="text"
        bind:value={model}
        placeholder="Model ID"
        aria-label="Model ID"
      />
    </div>

    {#if showPresets}
      <div class="presets">
        {#each presets as preset (preset)}
          <Button variant="secondary" size="small" onclick={() => (model = preset)}>
            {preset}
          </Button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="prompt-section">
    <label class="section-label" for="system-prompt">System Prompt</label>
    <textarea
      id="system-prompt"
      class="prompt-textarea"
      bind:value={systemPrompt}
      placeholder="You are a helpful assistant..."
      rows="4"
    ></textarea>
  </div>

  <McpPicker {env} onServersChange={handleServersChange} {onToolsResolved} />
</div>

<style>
  .custom-config {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
  }

  .model-input {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    flex: 1;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    min-inline-size: 0;
    padding-block: var(--size-2);
    padding-inline: var(--size-2-5);
  }

  .model-input:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    outline: none;
  }

  .model-row {
    display: flex;
    gap: var(--size-2);
  }

  .model-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .prompt-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .prompt-textarea {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    padding: var(--size-2-5);
    resize: vertical;
  }

  .prompt-textarea:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    outline: none;
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
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
    padding-block: var(--size-2);
    padding-inline: var(--size-2-5);
    padding-inline-end: var(--size-8);
  }

  select:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    outline: none;
  }
</style>

<script lang="ts">
import { advanceStep, writeKeys } from "../lib/installer.ts";
import { type ProviderId, store } from "../lib/store.svelte.ts";

// Provider catalog. `recommended: true` decorates the dropdown option AND
// the inline "Recommended" badge on the form. Each provider maps to a
// single env-var name on the Rust side via writeKeys().
type ProviderConfig = {
  id: ProviderId;
  label: string;
  recommended?: boolean;
  placeholder: string;
  keyPrefix: string;
  consoleUrl: string;
  consoleLabel: string;
};

const PROVIDERS: ProviderConfig[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    recommended: true,
    placeholder: "sk-ant-api03-…",
    keyPrefix: "sk-ant-",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    consoleLabel: "console.anthropic.com",
  },
  {
    id: "openai",
    label: "OpenAI",
    placeholder: "sk-…",
    keyPrefix: "sk-",
    consoleUrl: "https://platform.openai.com/api-keys",
    consoleLabel: "platform.openai.com",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    placeholder: "AIza…",
    keyPrefix: "AIza",
    consoleUrl: "https://aistudio.google.com/app/apikey",
    consoleLabel: "aistudio.google.com",
  },
  {
    id: "groq",
    label: "Groq",
    placeholder: "gsk_…",
    keyPrefix: "gsk_",
    consoleUrl: "https://console.groq.com/keys",
    consoleLabel: "console.groq.com",
  },
];

const providerById = new Map(PROVIDERS.map((p) => [p.id, p]));

let saving = $state(false);
let saveError = $state<string | null>(null);

const current = $derived(providerById.get(store.selectedProvider) ?? PROVIDERS[0]);

// Soft-validate: warn when the key doesn't match the provider's prefix,
// but don't block submission — providers occasionally rotate formats.
const trimmedKey = $derived(store.apiKey.trim());
const prefixMismatch = $derived(trimmedKey.length > 0 && !trimmedKey.startsWith(current.keyPrefix));

const canContinue = $derived(trimmedKey.length > 0 && !saving);

async function handleContinue() {
  saving = true;
  saveError = null;
  try {
    await writeKeys();
    advanceStep();
  } catch (err) {
    saveError = err instanceof Error ? err.message : String(err);
  } finally {
    saving = false;
  }
}

async function handleSkip() {
  const previous = store.apiKey;
  store.apiKey = "";
  saving = true;
  saveError = null;
  try {
    await writeKeys();
    advanceStep();
  } catch (err) {
    saveError = err instanceof Error ? err.message : String(err);
    store.apiKey = previous;
  } finally {
    saving = false;
  }
}
</script>

<div class="screen">
  <div class="header">
    <h2>API Key</h2>
    <p class="subtitle">
      Pick an AI provider and paste your API key. The key is stored locally
      on your device and never sent to Friday servers.
    </p>
  </div>

  <div class="form">
    <div class="field">
      <label for="provider">Provider</label>
      <div class="select-wrap">
        <select id="provider" bind:value={store.selectedProvider}>
          {#each PROVIDERS as p (p.id)}
            <option value={p.id}>
              {p.label}{p.recommended ? "  (Recommended)" : ""}
            </option>
          {/each}
        </select>
      </div>
    </div>

    <div class="field">
      <label for="api-key">
        {current.label} API Key
        {#if current.recommended}<span class="badge">Recommended</span>{/if}
      </label>
      <input
        id="api-key"
        type="password"
        placeholder={current.placeholder}
        bind:value={store.apiKey}
        autocomplete="off"
        spellcheck="false"
      />
      <p class="field-hint">
        Get your key at <a href={current.consoleUrl} target="_blank" rel="noreferrer">
          {current.consoleLabel}
        </a>
      </p>
      {#if prefixMismatch}
        <p class="warn">
          Heads up: keys for {current.label} usually start with
          <code>{current.keyPrefix}</code>. Continue if you're sure.
        </p>
      {/if}
    </div>

    {#if saveError !== null}
      <div class="error">{saveError}</div>
    {/if}
  </div>

  <div class="footer">
    <button class="primary" disabled={!canContinue} onclick={handleContinue}>
      {saving ? "Saving…" : "Continue"}
    </button>
    <button class="skip" disabled={saving} onclick={handleSkip}>
      Skip for now
    </button>
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 28px 48px 24px;
    gap: 24px;
  }

  h2 {
    font-size: 20px;
    font-weight: 700;
    color: #f0f0f0;
    margin-bottom: 6px;
  }

  .subtitle {
    font-size: 13px;
    color: #777;
    line-height: 1.5;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 20px;
    flex: 1;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 500;
    color: #ccc;
  }

  .badge {
    font-size: 10px;
    font-weight: 600;
    background: rgba(107, 114, 240, 0.2);
    color: #8b91f8;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  input,
  select {
    background: #1a1a1a;
    border: 1px solid #2e2e2e;
    border-radius: 7px;
    color: #f0f0f0;
    font-size: 13px;
    padding: 9px 12px;
    outline: none;
    transition: border-color 0.15s;
    width: 100%;
  }

  input {
    font-family: monospace;
  }

  input:focus,
  select:focus {
    border-color: #6b72f0;
  }

  input::placeholder {
    color: #444;
  }

  /* Custom dropdown chevron via background image (CSS-only, no JS) */
  .select-wrap {
    position: relative;
  }
  .select-wrap::after {
    content: "";
    position: absolute;
    right: 14px;
    top: 50%;
    width: 8px;
    height: 8px;
    border-right: 1.5px solid #888;
    border-bottom: 1.5px solid #888;
    transform: translateY(-70%) rotate(45deg);
    pointer-events: none;
  }
  select {
    appearance: none;
    -webkit-appearance: none;
    padding-right: 32px;
    cursor: pointer;
  }

  .field-hint {
    font-size: 12px;
    color: #555;
  }

  .field-hint a {
    color: #6b72f0;
    text-decoration: none;
  }

  .field-hint a:hover {
    text-decoration: underline;
  }

  .warn {
    font-size: 12px;
    color: #d4a52a;
    background: rgba(212, 165, 42, 0.08);
    border: 1px solid rgba(212, 165, 42, 0.25);
    border-radius: 6px;
    padding: 8px 12px;
    margin-top: 4px;
  }

  .warn code {
    font-family: monospace;
    background: rgba(212, 165, 42, 0.15);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .error {
    font-size: 13px;
    color: #f87171;
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.2);
    border-radius: 6px;
    padding: 10px 14px;
  }

  .footer {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  button {
    padding: 10px 28px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }

  .primary {
    background: #6b72f0;
    color: #fff;
  }

  .primary:hover:not(:disabled) {
    background: #5a62e0;
  }

  .primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .skip {
    background: transparent;
    color: #555;
    font-size: 13px;
    padding: 10px 0;
  }

  .skip:hover:not(:disabled) {
    color: #888;
  }

  .skip:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>

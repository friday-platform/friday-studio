<script lang="ts">
  import { store } from "../lib/store.svelte.ts";
  import { advanceStep, writeKeys } from "../lib/installer.ts";

  let saving = $state(false);
  let saveError = $state<string | null>(null);

  const canContinue = $derived(
    store.anthropicKey.trim().length > 0 || store.openaiKey.trim().length > 0,
  );

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
</script>

<div class="screen">
  <div class="header">
    <h2>API Keys</h2>
    <p class="subtitle">
      Add at least one API key to power Friday Studio's AI features. Keys are
      stored locally on your device and never sent to Friday servers.
    </p>
  </div>

  <div class="form">
    <div class="field">
      <label for="anthropic-key">
        Anthropic API Key
        <span class="badge">Recommended</span>
      </label>
      <input
        id="anthropic-key"
        type="password"
        placeholder="sk-ant-…"
        bind:value={store.anthropicKey}
        autocomplete="off"
        spellcheck="false"
      />
      <p class="field-hint">
        Get your key at <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noreferrer">console.anthropic.com</a
        >
      </p>
    </div>

    <div class="field">
      <label for="openai-key">OpenAI API Key</label>
      <input
        id="openai-key"
        type="password"
        placeholder="sk-…"
        bind:value={store.openaiKey}
        autocomplete="off"
        spellcheck="false"
      />
      <p class="field-hint">
        Get your key at <a
          href="https://platform.openai.com/api-keys"
          target="_blank"
          rel="noreferrer">platform.openai.com</a
        >
      </p>
    </div>

    {#if saveError !== null}
      <div class="error">{saveError}</div>
    {/if}
  </div>

  <div class="footer">
    <button
      class="primary"
      disabled={!canContinue || saving}
      onclick={handleContinue}
    >
      {saving ? "Saving…" : "Continue"}
    </button>
    <button
      class="skip"
      onclick={() => {
        store.anthropicKey = "__skip__";
        void handleContinue();
        store.anthropicKey = "";
      }}
    >
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

  input {
    background: #1a1a1a;
    border: 1px solid #2e2e2e;
    border-radius: 7px;
    color: #f0f0f0;
    font-size: 13px;
    font-family: monospace;
    padding: 9px 12px;
    outline: none;
    transition: border-color 0.15s;
    width: 100%;
  }

  input:focus {
    border-color: #6b72f0;
  }

  input::placeholder {
    color: #444;
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

  .skip:hover {
    color: #888;
  }
</style>

<script lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { onMount } from "svelte";

interface Props {
  open?: boolean;
  onclose?: () => void;
}

let { open = $bindable(false), onclose }: Props = $props();
let dialog: HTMLDialogElement | undefined = $state();
let envVars = $state<{ key: string; value: string; id: number }[]>([]);
let hasChanges = $state(false);
let isSaving = $state(false);
let isRestarting = $state(false);
let message = $state("");
let messageType = $state<"success" | "error" | "">("");
let nextId = 1;

// Check if all entries have both key and value (no empty or whitespace-only)
let isValid = $derived(
  envVars.every((entry) => entry.key.trim() !== "" && entry.value.trim() !== ""),
);

$effect(() => {
  if (dialog && open) {
    dialog.showModal();
    loadEnvVars();
  } else if (dialog && !open) {
    dialog.close();
  }
});

async function loadEnvVars() {
  try {
    const result = await invoke<Record<string, string>>("read_env_file");
    // Sort entries by key alphabetically
    envVars = Object.entries(result)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value, id: nextId++ }));
    hasChanges = false;
  } catch (err) {
    console.error("Failed to load env vars:", err);
    showMessage("Failed to load environment variables", "error");
  }
}

function addEntry() {
  envVars = [...envVars, { key: "", value: "", id: nextId++ }];
  hasChanges = true;
}

function removeEntry(id: number) {
  envVars = envVars.filter((v) => v.id !== id);
  hasChanges = true;
}

function updateEntry(id: number, field: "key" | "value", value: string) {
  // Prevent leading spaces - trim them immediately
  const trimmedValue = value.startsWith(" ") ? value.trimStart() : value;
  envVars = envVars.map((v) => (v.id === id ? { ...v, [field]: trimmedValue } : v));
  hasChanges = true;
}

async function saveChanges() {
  // Double-check validation before saving - all entries must have both key and value
  const invalidEntries = envVars.filter(
    (v) =>
      (v.key.trim() !== "" && v.value.trim() === "") ||
      (v.key.trim() === "" && v.value.trim() !== ""),
  );

  if (invalidEntries.length > 0) {
    showMessage("All entries must have both key and value", "error");
    return;
  }

  isSaving = true;
  try {
    // Only save entries that have both key and value
    const validEntries = envVars.filter((v) => v.key.trim() !== "" && v.value.trim() !== "");
    const envObject: Record<string, string> = {};

    for (const entry of validEntries) {
      envObject[entry.key.trim()] = entry.value;
    }

    await invoke("write_env_file", { envVars: envObject });
    hasChanges = false;
    showMessage("Environment variables saved successfully", "success");
    // Reload the env vars to show the saved state (sorted)
    await loadEnvVars();
  } catch (err) {
    console.error("Failed to save env vars:", err);
    showMessage("Failed to save environment variables", "error");
  } finally {
    isSaving = false;
  }
}

async function saveAndRestart() {
  await saveChanges();
  if (messageType === "success") {
    isRestarting = true;
    try {
      const result = await invoke<string>("restart_atlas_daemon");
      showMessage(result, "success");
      // Dialog stays open after restart, same as with save
    } catch (err) {
      console.error("Failed to restart daemon:", err);
      showMessage("Failed to restart Atlas daemon", "error");
    } finally {
      isRestarting = false;
    }
  }
}

function showMessage(msg: string, type: "success" | "error") {
  message = msg;
  messageType = type;
  setTimeout(() => {
    message = "";
    messageType = "";
  }, 5000);
}

function handleClose() {
  if (hasChanges) {
    if (!confirm("You have unsaved changes. Are you sure you want to close?")) {
      return;
    }
  }
  open = false;
  onclose?.();
}

function handleBackdropClick(event: MouseEvent) {
  if (event.target === dialog) {
    handleClose();
  }
}
</script>

<dialog
  bind:this={dialog}
  class="settings-dialog"
  onclick={handleBackdropClick}
>
  <div class="dialog-content" onclick={(e) => e.stopPropagation()}>
    <button class="close-button" onclick={handleClose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </button>

    <h2>Settings</h2>
    <p class="subtitle">Manage Atlas environment variables</p>

    <div class="env-list">
      <div class="env-header">
        <span>Key</span>
        <span>Value</span>
        <span></span>
      </div>

      {#each envVars as entry (entry.id)}
        <div class="env-entry">
          <input
            type="text"
            placeholder="KEY"
            value={entry.key}
            oninput={(e) => updateEntry(entry.id, "key", e.currentTarget.value)}
            class="key-input"
          />
          <input
            type="text"
            placeholder="value"
            value={entry.value}
            oninput={(e) => updateEntry(entry.id, "value", e.currentTarget.value)}
            class="value-input"
          />
          <button
            class="remove-button"
            onclick={() => removeEntry(entry.id)}
            aria-label="Remove entry"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      {/each}

      <button class="add-button" onclick={addEntry}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1V13M1 7H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        Add Variable
      </button>
    </div>

    {#if message}
      <div class="message {messageType}">
        {message}
      </div>
    {/if}

    <div class="actions">
      <button class="cancel-button" onclick={handleClose}>
        Cancel
      </button>
      <button
        class="save-button"
        onclick={saveChanges}
        disabled={!hasChanges || isSaving || !isValid}
      >
        {isSaving ? "Saving..." : "Save"}
      </button>
      <button
        class="save-restart-button"
        onclick={saveAndRestart}
        disabled={!hasChanges || isSaving || isRestarting || !isValid}
      >
        {isRestarting ? "Restarting..." : "Save & Restart Daemon"}
      </button>
    </div>
  </div>
</dialog>

<style>
  .settings-dialog {
    position: fixed;
    inset: 0;
    padding: 0;
    margin: auto;
    border: none;
    background: transparent;
    max-inline-size: 650px;
    max-block-size: 80vh;
    overflow: visible;
  }

  .settings-dialog::backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(3px);
  }

  .dialog-content {
    position: relative;
    background: var(--color-surface-2, #1e1e1e);
    border: 1px solid var(--color-border-1, #333);
    border-radius: 12px;
    padding: 24px;
    width: 600px;
    max-block-size: calc(80vh - 40px);
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  }

  .close-button {
    position: absolute;
    top: 16px;
    right: 16px;
    background: none;
    border: none;
    color: var(--text-2, #888);
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s;
  }

  .close-button:hover {
    color: var(--text-1, #fff);
  }

  h2 {
    margin: 0 0 4px 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--text-1, #fff);
  }

  .subtitle {
    margin: 0 0 24px 0;
    font-size: 14px;
    color: var(--text-3, #666);
  }

  .env-list {
    border: 1px solid var(--color-border-1, #333);
    border-radius: 8px;
    background: var(--color-surface-1, #161616);
    padding: 12px;
    margin-bottom: 20px;
    flex: 1;
    min-height: 200px;
    overflow-y: auto;
  }

  .env-header {
    display: grid;
    grid-template-columns: 1fr 2fr 40px;
    gap: 12px;
    padding: 0 0 12px 0;
    border-bottom: 1px solid var(--color-border-1, #333);
    margin-bottom: 12px;
  }

  .env-header span {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-3, #666);
    text-transform: uppercase;
  }

  .env-entry {
    display: grid;
    grid-template-columns: 1fr 2fr 40px;
    gap: 12px;
    margin-bottom: 8px;
  }

  .key-input, .value-input {
    background: var(--color-surface-2, #1e1e1e);
    border: 1px solid var(--color-border-1, #333);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 14px;
    color: var(--text-1, #fff);
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
    transition: border-color 0.2s;
  }


  .key-input:focus, .value-input:focus {
    outline: none;
    border-color: var(--accent-1, #007bff);
  }

  .remove-button {
    background: none;
    border: 1px solid var(--color-border-1, #333);
    border-radius: 6px;
    color: var(--text-3, #666);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .remove-button:hover {
    color: #ff4444;
    border-color: #ff4444;
  }

  .add-button {
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: 1px dashed var(--color-border-1, #333);
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--text-3, #666);
    font-size: 14px;
    cursor: pointer;
    margin-top: 12px;
    width: 100%;
    justify-content: center;
    transition: all 0.2s;
  }

  .add-button:hover {
    color: var(--accent-1, #007bff);
    border-color: var(--accent-1, #007bff);
  }

  .message {
    padding: 12px;
    border-radius: 6px;
    margin-bottom: 20px;
    font-size: 14px;
  }

  .message.success {
    background: rgba(40, 167, 69, 0.1);
    color: #28a745;
    border: 1px solid rgba(40, 167, 69, 0.2);
  }

  .message.error {
    background: rgba(220, 53, 69, 0.1);
    color: #dc3545;
    border: 1px solid rgba(220, 53, 69, 0.2);
  }

  .actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    padding-top: 20px;
    border-top: 1px solid var(--color-border-1, #333);
    flex-shrink: 0;
  }

  button {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    border: none;
  }

  .cancel-button {
    background: var(--color-surface-1, #161616);
    color: var(--text-2, #888);
    border: 1px solid var(--color-border-1, #333);
  }

  .cancel-button:hover {
    background: var(--color-surface-2, #1e1e1e);
  }

  .save-button {
    background: var(--accent-1, #007bff);
    color: white;
  }

  .save-button:hover:not(:disabled) {
    background: var(--accent-2, #0056b3);
  }

  .save-restart-button {
    background: #28a745;
    color: white;
  }

  .save-restart-button:hover:not(:disabled) {
    background: #218838;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
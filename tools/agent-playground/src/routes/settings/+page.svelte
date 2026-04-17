<!--
  Settings — minimal view of what the daemon has already made configurable.

  Today that's the `~/.atlas/.env` surface (API keys, paths, CORS allowlist,
  tool binaries) via GET/PUT `/api/config/env`. Every value is a free-text
  string; the daemon is the source of truth for which keys actually matter.

  This page is intentionally small: list the keys, let the user edit or add
  rows, save back. Admin-style scoping, model routing, etc. land later as
  separate surfaces — per 4.2 in docs/plans/2026-04-16-chat-ux-and-fast-
  improvements.md, "don't over-design upfront."

  @component
-->
<script lang="ts">
  import { Button } from "@atlas/ui";

  interface EnvRow {
    key: string;
    value: string;
  }

  let rows: EnvRow[] = $state([]);
  let loading = $state(true);
  let saving = $state(false);
  let error: string | null = $state(null);
  let success: string | null = $state(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch("/api/daemon/api/config/env");
      if (!res.ok) {
        error = `Failed to load settings (HTTP ${res.status})`;
        return;
      }
      const data: unknown = await res.json();
      if (
        typeof data === "object" &&
        data !== null &&
        "envVars" in data &&
        typeof (data as { envVars: unknown }).envVars === "object" &&
        (data as { envVars: unknown }).envVars !== null
      ) {
        const envVars = (data as { envVars: Record<string, unknown> }).envVars;
        rows = Object.entries(envVars)
          .map(([key, value]) => ({ key, value: String(value ?? "") }))
          .sort((a, b) => a.key.localeCompare(b.key));
      } else {
        rows = [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load settings";
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<void> {
    saving = true;
    error = null;
    success = null;
    try {
      const payload: Record<string, string> = {};
      for (const row of rows) {
        const k = row.key.trim();
        if (k.length === 0) continue;
        payload[k] = row.value;
      }
      const res = await fetch("/api/daemon/api/config/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envVars: payload }),
      });
      if (!res.ok) {
        const body = await res.text();
        error = `Save failed (HTTP ${res.status}): ${body}`;
        return;
      }
      success = "Saved. Changes take effect after daemon restart.";
    } catch (err) {
      error = err instanceof Error ? err.message : "Save failed";
    } finally {
      saving = false;
    }
  }

  function addRow(): void {
    rows = [...rows, { key: "", value: "" }];
  }

  function removeRow(index: number): void {
    rows = rows.filter((_, i) => i !== index);
  }

  $effect(() => {
    void load();
  });

  const isSecretKey = (k: string): boolean => {
    const upper = k.toUpperCase();
    return (
      upper.includes("KEY") ||
      upper.includes("TOKEN") ||
      upper.includes("SECRET") ||
      upper.includes("PASSWORD")
    );
  };
</script>

<div class="settings-root">
  <header class="page-header">
    <h1>Settings</h1>
    <p class="subtitle">
      Environment variables from <code>~/.atlas/.env</code>. The daemon reads these at
      startup; editing here writes to the file, but a restart is required before changes
      take effect.
    </p>
  </header>

  {#if loading}
    <div class="loading">Loading settings…</div>
  {:else if error}
    <div class="error-banner" role="alert">
      <span>{error}</span>
      <button class="dismiss" onclick={() => load()}>Retry</button>
    </div>
  {:else}
    {#if success}
      <div class="success-banner">{success}</div>
    {/if}

    <div class="env-table">
      <div class="env-header">
        <span class="col-key">Key</span>
        <span class="col-value">Value</span>
        <span class="col-action"></span>
      </div>
      {#each rows as row, i (i)}
        <div class="env-row">
          <input
            class="col-key"
            type="text"
            bind:value={row.key}
            placeholder="VARIABLE_NAME"
            autocomplete="off"
            spellcheck="false"
          />
          <input
            class="col-value"
            type={isSecretKey(row.key) ? "password" : "text"}
            bind:value={row.value}
            placeholder="value"
            autocomplete="off"
            spellcheck="false"
          />
          <button
            class="col-action remove"
            onclick={() => removeRow(i)}
            aria-label="Remove row"
          >
            ✕
          </button>
        </div>
      {/each}

      {#if rows.length === 0}
        <div class="empty">No settings yet. Add one below.</div>
      {/if}
    </div>

    <div class="actions">
      <Button variant="secondary" onclick={addRow} disabled={saving}>Add variable</Button>
      <Button variant="primary" onclick={save} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  {/if}
</div>

<style>
  .settings-root {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
    max-inline-size: 900px;
    padding: var(--size-6) var(--size-7);
  }

  .page-header h1 {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    margin-block-end: var(--size-1);
  }

  .subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-2);
    line-height: 1.5;
  }

  .subtitle code {
    background-color: var(--color-surface-3);
    border-radius: var(--radius-1);
    font-size: var(--font-size-1);
    padding: 0 var(--size-1);
  }

  .loading,
  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-2);
    padding: var(--size-4);
    text-align: center;
  }

  .error-banner {
    align-items: center;
    background-color: color-mix(in srgb, var(--color-error), transparent 85%);
    border-radius: var(--radius-2);
    color: var(--color-error);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-3);
    justify-content: space-between;
    padding: var(--size-3);
  }

  .success-banner {
    background-color: color-mix(in srgb, var(--color-success, #4ade80), transparent 85%);
    border-radius: var(--radius-2);
    color: var(--color-success, #4ade80);
    font-size: var(--font-size-2);
    padding: var(--size-3);
  }

  .dismiss {
    background: transparent;
    border: 1px solid currentColor;
    border-radius: var(--radius-1);
    color: inherit;
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2);
  }

  .env-table {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .env-header,
  .env-row {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: grid;
    gap: var(--size-2);
    grid-template-columns: minmax(180px, 1fr) minmax(220px, 2fr) 32px;
    padding: var(--size-2) var(--size-3);
  }

  .env-row:last-child {
    border-block-end: none;
  }

  .env-header {
    background-color: var(--color-surface-3);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .env-row input {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--font-size-2);
    inline-size: 100%;
    padding: var(--size-1) var(--size-2);
  }

  .env-row input:focus {
    border-color: var(--color-accent, var(--blue-2));
    outline: none;
  }

  .col-action.remove {
    background: transparent;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    cursor: pointer;
    font-size: var(--font-size-2);
    padding: var(--size-1);
    transition: color 150ms ease;
  }

  .col-action.remove:hover {
    color: var(--color-error);
  }

  .actions {
    display: flex;
    gap: var(--size-2);
    justify-content: flex-end;
  }
</style>

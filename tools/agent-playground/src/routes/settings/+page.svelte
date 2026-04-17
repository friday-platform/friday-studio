<!--
  Settings — Models (editable, writes to friday.yml) + env vars (collapsed).

  Models section hits `GET /api/config/models` for the currently-resolved
  (and configured) per-role model, and `PUT /api/config/models` to write
  back. The PUT runs the same `createPlatformModels` validation the daemon
  uses at boot, so bad provider/model IDs surface as a 400 with a message
  instead of silently corrupting friday.yml. Changes take effect on next
  daemon restart.

  Env vars section is the existing `~/.atlas/.env` editor, collapsed by
  default so it doesn't dominate the viewport.

  @component
-->
<script lang="ts">
  import { Button } from "@atlas/ui";

  interface EnvRow {
    key: string;
    value: string;
  }
  type ModelRole = "labels" | "classifier" | "planner" | "conversational";
  interface ModelInfo {
    role: ModelRole;
    resolved: { provider: string; modelId: string };
    configured: string | null;
  }

  let rows: EnvRow[] = $state([]);
  let models: ModelInfo[] = $state([]);
  // Per-role editable value. Empty string is the sentinel for "use default chain".
  let modelEdits: Record<ModelRole, string> = $state({
    labels: "",
    classifier: "",
    planner: "",
    conversational: "",
  });
  let loadingEnv = $state(true);
  let loadingModels = $state(true);
  let savingModels = $state(false);
  let saving = $state(false);
  let envError: string | null = $state(null);
  let modelsError: string | null = $state(null);
  let modelsSuccess: string | null = $state(null);
  let success: string | null = $state(null);

  async function loadEnv(): Promise<void> {
    loadingEnv = true;
    envError = null;
    try {
      const res = await fetch("/api/daemon/api/config/env");
      if (!res.ok) {
        envError = `Failed to load env (HTTP ${res.status})`;
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
      envError = err instanceof Error ? err.message : "Failed to load env";
    } finally {
      loadingEnv = false;
    }
  }

  async function loadModels(): Promise<void> {
    loadingModels = true;
    modelsError = null;
    try {
      const res = await fetch("/api/daemon/api/config/models");
      if (!res.ok) {
        modelsError = `Failed to load models (HTTP ${res.status})`;
        return;
      }
      const data: unknown = await res.json();
      if (
        typeof data === "object" &&
        data !== null &&
        "models" in data &&
        Array.isArray((data as { models: unknown }).models)
      ) {
        models = (data as { models: ModelInfo[] }).models;
        // Seed the editor with whatever's in friday.yml (null = default).
        for (const m of models) {
          modelEdits[m.role] = m.configured ?? "";
        }
      } else {
        models = [];
      }
    } catch (err) {
      modelsError = err instanceof Error ? err.message : "Failed to load models";
    } finally {
      loadingModels = false;
    }
  }

  async function saveModels(): Promise<void> {
    savingModels = true;
    modelsError = null;
    modelsSuccess = null;
    try {
      // Null means "clear this field", empty string in the input also means that.
      // Send both so an operator who types a value then clears it reverts to default.
      const payload: Record<ModelRole, string | null> = {
        labels: modelEdits.labels.trim() || null,
        classifier: modelEdits.classifier.trim() || null,
        planner: modelEdits.planner.trim() || null,
        conversational: modelEdits.conversational.trim() || null,
      };
      const res = await fetch("/api/daemon/api/config/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: payload }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${res.status}`;
        modelsError = msg;
        return;
      }
      modelsSuccess =
        "Saved to friday.yml. Restart the daemon for changes to take effect.";
      await loadModels();
    } catch (err) {
      modelsError = err instanceof Error ? err.message : "Save failed";
    } finally {
      savingModels = false;
    }
  }

  async function saveEnv(): Promise<void> {
    saving = true;
    envError = null;
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
        envError = `Save failed (HTTP ${res.status}): ${body}`;
        return;
      }
      success = "Saved. Changes take effect after daemon restart.";
    } catch (err) {
      envError = err instanceof Error ? err.message : "Save failed";
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
    void loadEnv();
    void loadModels();
  });

  const ROLE_DESCRIPTIONS: Record<ModelInfo["role"], string> = {
    labels: "Short text generation (session titles, progress strings).",
    classifier: "Structured output decisions (triage, routing).",
    planner: "Multi-step synthesis with tool calls (workflow planning).",
    conversational: "Streaming chat with tools and multi-turn memory.",
  };

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
      What the daemon resolved at startup. Per-role models come from <code>friday.yml</code>;
      environment variables come from <code>~/.atlas/.env</code>. Both take effect on the
      next daemon restart.
    </p>
  </header>

  <!-- Models section -->
  <section class="section">
    <header class="section-header">
      <h2>Models</h2>
      <p class="section-sub">
        Per-role routing. Format: <code>provider:model</code> (e.g.
        <code>anthropic:claude-sonnet-4-6</code>). Leave blank to use the default chain.
        Known providers: <code>anthropic</code>, <code>openai</code>, <code>google</code>,
        <code>groq</code>, <code>claude-code</code>. Saved to <code>friday.yml</code>;
        restart the daemon to apply.
      </p>
    </header>

    {#if loadingModels}
      <div class="loading">Loading models…</div>
    {:else if modelsError}
      <div class="error-banner" role="alert">
        <pre class="error-text">{modelsError}</pre>
        <button class="dismiss" onclick={() => { modelsError = null; }}>Dismiss</button>
      </div>
    {:else if models.length === 0}
      <div class="empty">No models resolved.</div>
    {:else}
      {#if modelsSuccess}
        <div class="success-banner">{modelsSuccess}</div>
      {/if}
      <div class="models-grid">
        {#each models as m (m.role)}
          <div class="model-card">
            <div class="model-role">{m.role}</div>
            <p class="model-desc">{ROLE_DESCRIPTIONS[m.role]}</p>
            <label class="model-label">
              <span class="label-text">Configured value</span>
              <input
                type="text"
                class="model-input"
                bind:value={modelEdits[m.role]}
                placeholder="(using default — blank)"
                autocomplete="off"
                spellcheck="false"
                disabled={savingModels}
              />
            </label>
            <div class="model-resolved">
              <span class="resolved-label">Currently active:</span>
              <span class="resolved-value">
                {m.resolved.provider} / {m.resolved.modelId}
              </span>
            </div>
          </div>
        {/each}
      </div>
      <div class="actions">
        <Button variant="primary" onclick={saveModels} disabled={savingModels}>
          {savingModels ? "Saving…" : "Save models"}
        </Button>
      </div>
    {/if}
  </section>

  <!-- Env vars section (collapsed by default) -->
  <section class="section">
    <details class="env-details">
      <summary class="env-summary">
        <span class="section-h">Environment variables</span>
        <span class="env-count">
          {loadingEnv ? "…" : `${rows.length} keys`}
        </span>
      </summary>

      <p class="section-sub">
        From <code>~/.atlas/.env</code>. Secrets (<em>KEY</em>, <em>TOKEN</em>,
        <em>SECRET</em>, <em>PASSWORD</em>) render as password inputs.
      </p>

      {#if loadingEnv}
        <div class="loading">Loading environment…</div>
      {:else if envError}
        <div class="error-banner" role="alert">
          <span>{envError}</span>
          <button class="dismiss" onclick={() => loadEnv()}>Retry</button>
        </div>
      {:else}
        {#if success}
          <div class="success-banner">{success}</div>
        {/if}

        <div class="env-table">
          <div class="env-table-header">
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
          <Button variant="primary" onclick={saveEnv} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      {/if}
    </details>
  </section>
</div>

<style>
  .settings-root {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    max-inline-size: 900px;
    padding: var(--size-6) var(--size-7);
  }

  .page-header h1 {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    margin-block-end: var(--size-1);
  }

  .subtitle,
  .section-sub {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-2);
    line-height: 1.5;
  }

  .subtitle code,
  .section-sub code {
    background-color: var(--color-surface-3);
    border-radius: var(--radius-1);
    font-size: var(--font-size-1);
    padding: 0 var(--size-1);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .section-header h2,
  .section-h {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
  }

  /* ─── Models ─────────────────────────────────────────────────────── */

  .models-grid {
    display: grid;
    gap: var(--size-3);
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  }

  .model-card {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-3);
  }

  .model-role {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .model-desc {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    line-height: 1.5;
  }

  .model-label {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .label-text {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .model-input {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--font-size-2);
    inline-size: 100%;
    padding: var(--size-1) var(--size-2);
  }

  .model-input:focus {
    border-color: var(--color-accent, var(--blue-2));
    outline: none;
  }

  .model-input:disabled {
    opacity: 0.5;
  }

  .model-resolved {
    background-color: var(--color-surface-3);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-1);
    gap: var(--size-0-5);
    padding: var(--size-1-5) var(--size-2);
  }

  .resolved-label {
    font-weight: var(--font-weight-5);
    opacity: 0.7;
  }

  .resolved-value {
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .error-text {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    margin: 0;
    white-space: pre-wrap;
  }

  /* ─── Env vars ───────────────────────────────────────────────────── */

  .env-details {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    padding: var(--size-3);
  }

  .env-details[open] {
    padding-block-end: var(--size-4);
  }

  .env-summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: var(--size-2);
    list-style: none;
    user-select: none;
  }

  .env-summary::-webkit-details-marker {
    display: none;
  }

  .env-summary::before {
    content: "▶";
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: 0.75em;
    transition: transform 150ms ease;
  }

  .env-details[open] > .env-summary::before {
    transform: rotate(90deg);
  }

  .env-count {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    margin-inline-start: auto;
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
    margin-block-start: var(--size-3);
    padding: var(--size-3);
  }

  .success-banner {
    background-color: color-mix(in srgb, var(--color-success, #4ade80), transparent 85%);
    border-radius: var(--radius-2);
    color: var(--color-success, #4ade80);
    font-size: var(--font-size-2);
    margin-block-start: var(--size-3);
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
    margin-block-start: var(--size-3);
    overflow: hidden;
  }

  .env-table-header,
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

  .env-table-header {
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
    margin-block-start: var(--size-3);
  }
</style>

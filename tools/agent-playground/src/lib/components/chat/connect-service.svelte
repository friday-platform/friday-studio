<!--
  ConnectService — interactive credential card for the chat message list.

  Mirrors the web-client connect-service flow:
  - Fetches provider details from Link
  - Renders OAuth button, app-install button, or API-key inline form
  - Opens popup for OAuth/app-install; submits inline form for API keys
  - Calls onConnected() on success so the parent can nudge the agent

  @component
-->
<script lang="ts">
  import { Button, MarkdownRendered, markdownToHTML } from "@atlas/ui";
  import { browser } from "$app/environment";
  import DOMPurify from "dompurify";
  import {
    listenForOAuthCallback,
    startAppInstallFlow,
    startOAuthFlow,
  } from "$lib/oauth-popup.ts";
  import { EXTERNAL_DAEMON_URL } from "$lib/daemon-url.ts";
  import { z } from "zod";

  // ─── Types ───────────────────────────────────────────────────────────────

  interface Props {
    provider: string;
    onConnected?: () => void;
  }

  type ProviderType = "oauth" | "apikey" | "app_install";

  interface ProviderDetails {
    id: string;
    type: ProviderType;
    displayName: string;
    description: string;
    setupInstructions?: string;
    secretSchema?: z.infer<typeof SecretSchemaShape>;
  }

  const SecretSchemaShape = z.object({
    properties: z.record(z.string(), z.object({}).passthrough()).optional(),
    required: z.array(z.string()).optional(),
  });

  const ProviderResponseSchema = z.object({
    id: z.string(),
    type: z.enum(["oauth", "apikey", "app_install"]),
    displayName: z.string(),
    description: z.string(),
    setupInstructions: z.string().optional(),
    secretSchema: SecretSchemaShape.optional(),
  });

  // ─── Props ─────────────────────────────────────────────────────────────────

  let { provider, onConnected }: Props = $props();

  // ─── State ─────────────────────────────────────────────────────────────────

  let details = $state<ProviderDetails | null>(null);
  let error = $state<string | null>(null);
  let popupBlocked = $state(false);
  let connected = $state(false);

  // API-key form state
  let apiKeyLabel = $state("");
  let apiKeyFields = $state<Record<string, string>>({});
  let apiKeySubmitting = $state(false);
  let apiKeyError = $state<string | null>(null);
  let apiKeyExpanded = $state(false);

  // ─── Derived ───────────────────────────────────────────────────────────────

  const secretFields = $derived.by(() => {
    if (!details?.secretSchema) return [];
    const parsed = SecretSchemaShape.safeParse(details.secretSchema);
    if (!parsed.success) return [];
    const properties = parsed.data.properties ?? {};
    const required = new Set(parsed.data.required ?? []);
    return Object.keys(properties).map((key) => ({
      key,
      label: secretKeyToLabel(key),
      required: required.has(key),
    }));
  });

  // ─── Fetch provider details ──────────────────────────────────────────────────

  $effect(() => {
    if (!browser) return;

    async function load() {
      try {
        const res = await fetch(`/api/daemon/api/link/v1/providers/${encodeURIComponent(provider)}`);
        if (!res.ok) {
          error = `Failed to load provider details (${res.status})`;
          return;
        }
        const raw: unknown = await res.json();
        const parsed = ProviderResponseSchema.safeParse(raw);
        if (!parsed.success) {
          error = "Invalid provider details from server";
          return;
        }

        details = {
          id: parsed.data.id,
          type: parsed.data.type,
          displayName: parsed.data.displayName,
          description: parsed.data.description,
          setupInstructions: parsed.data.setupInstructions,
          secretSchema: parsed.data.secretSchema,
        };
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    load();
  });

  // ─── OAuth / app-install listeners ───────────────────────────────────────────

  let cleanupListener: (() => void) | undefined;

  $effect(() => {
    if (!browser || !provider) return;

    cleanupListener = listenForOAuthCallback(() => {
      connected = true;
      onConnected?.();
    }, provider);

    return () => cleanupListener?.();
  });

  // ─── Handlers ──────────────────────────────────────────────────────────────

  function handleOAuth() {
    popupBlocked = false;
    const popup = startOAuthFlow(provider);
    if (!popup || popup.closed) {
      popupBlocked = true;
    }
  }

  function handleOAuthFallback() {
    // Full-page redirect fallback when popup is blocked
    const url = startOAuthFlow(provider);
    // startOAuthFlow returns the popup window; for fallback we need the URL
    // Reconstruct it manually
    const callbackUrl = new URL("/oauth/callback", globalThis.location.origin);
    const target = new URL(`/api/link/v1/oauth/authorize/${provider}`, getDaemonUrl());
    target.searchParams.set("redirect_uri", callbackUrl.href);
    globalThis.location.href = target.href;
  }

  function handleAppInstall() {
    popupBlocked = false;
    const popup = startAppInstallFlow(provider);
    if (!popup || popup.closed) {
      popupBlocked = true;
    }
  }

  function handleAppInstallFallback() {
    const callbackUrl = new URL("/oauth/callback", globalThis.location.origin);
    const target = new URL(`/api/link/v1/app-install/${provider}/authorize`, getDaemonUrl());
    target.searchParams.set("redirect_uri", callbackUrl.href);
    globalThis.location.href = target.href;
  }

  async function handleApiKeySubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!details) return;

    const label = apiKeyLabel.trim();
    if (!label) {
      apiKeyError = "Label is required";
      return;
    }

    const missing = secretFields.filter((f) => f.required && !apiKeyFields[f.key]?.trim());
    if (missing.length > 0) {
      apiKeyError = `Required: ${missing.map((f) => f.label).join(", ")}`;
      return;
    }

    const secret: Record<string, string> = {};
    for (const field of secretFields) {
      const value = apiKeyFields[field.key]?.trim();
      if (value) secret[field.key] = value;
    }

    apiKeySubmitting = true;
    apiKeyError = null;

    try {
      const res = await fetch(`/api/daemon/api/link/v1/credentials/apikey`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, label, secret }),
      });

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg =
          typeof body === "object" &&
          body !== null &&
          "message" in body &&
          typeof (body as { message: unknown }).message === "string"
            ? (body as { message: string }).message
            : `HTTP ${res.status}`;
        apiKeyError = msg;
        return;
      }

      connected = true;
      onConnected?.();
    } catch (e) {
      apiKeyError = e instanceof Error ? e.message : String(e);
    } finally {
      apiKeySubmitting = false;
    }
  }

  function getDaemonUrl(): string {
    return EXTERNAL_DAEMON_URL;
  }

  function secretKeyToLabel(key: string): string {
    const upperWords = new Set(["api", "id", "url", "uri", "sql", "ssh"]);
    return key
      .split("_")
      .map((w) =>
        upperWords.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
      )
      .join(" ");
  }

  function isSensitiveField(key: string): boolean {
    return /password|secret|token|key/i.test(key);
  }
</script>

<div class="connect-service-card">
  {#if connected}
    <div class="success-state">
      <span class="success-icon">✓</span>
      <span class="success-text">
        {details?.displayName ?? provider} connected. Continue your conversation.
      </span>
    </div>
  {:else if error}
    <div class="error-state">
      <p>{error}</p>
    </div>
  {:else if details}
    <div class="header">
      <div class="icon-wrapper">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      </div>
      <div class="header-text">
        <h3>Connect {details.displayName}</h3>
        <p class="description">{details.description}</p>
      </div>
    </div>

    {#if details.setupInstructions}
      <div class="instructions">
        <MarkdownRendered>
          {@html browser ? DOMPurify.sanitize(markdownToHTML(details.setupInstructions)) : markdownToHTML(details.setupInstructions)}
        </MarkdownRendered>
      </div>
    {/if}

    {#if details.type === "oauth"}
      <Button variant="primary" size="small" onclick={handleOAuth}>
        Connect {details.displayName}
      </Button>
      {#if popupBlocked}
        <div class="popup-blocked">
          <p>Popup was blocked by your browser.</p>
          <button class="fallback-link" onclick={handleOAuthFallback}>
            Continue in this tab instead
          </button>
        </div>
      {/if}
    {:else if details.type === "app_install"}
      <Button variant="primary" size="small" onclick={handleAppInstall}>
        Install {details.displayName}
      </Button>
      {#if popupBlocked}
        <div class="popup-blocked">
          <p>Popup was blocked by your browser.</p>
          <button class="fallback-link" onclick={handleAppInstallFallback}>
            Continue in this tab instead
          </button>
        </div>
      {/if}
    {:else if details.type === "apikey"}
      {#if !apiKeyExpanded}
        <Button
          variant="secondary"
          size="small"
          onclick={() => (apiKeyExpanded = true)}
        >
          Enter API key for {details.displayName}
        </Button>
      {:else}
        <form class="apikey-form" onsubmit={handleApiKeySubmit}>
          <div class="field">
            <label for="apikey-label">Label</label>
            <input
              id="apikey-label"
              type="text"
              bind:value={apiKeyLabel}
              placeholder="e.g., Work Account"
              disabled={apiKeySubmitting}
              required
            />
          </div>

          {#each secretFields as field (field.key)}
            <div class="field">
              <label for="apikey-{field.key}">{field.label}</label>
              <input
                id="apikey-{field.key}"
                type={isSensitiveField(field.key) ? "password" : "text"}
                bind:value={apiKeyFields[field.key]}
                placeholder={field.required
                  ? `Enter ${field.label.toLowerCase()}`
                  : `${field.label} (optional)`}
                disabled={apiKeySubmitting}
                required={field.required}
              />
            </div>
          {/each}

          {#if apiKeyError}
            <div class="form-error">{apiKeyError}</div>
          {/if}

          <div class="form-actions">
            <Button
              variant="secondary"
              size="small"
              onclick={() => (apiKeyExpanded = false)}
              disabled={apiKeySubmitting}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="small"
              type="submit"
              disabled={apiKeySubmitting}
            >
              {apiKeySubmitting ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </form>
      {/if}
    {:else}
      <Button variant="secondary" size="small" disabled>
        Unsupported connection type: {details.type}
      </Button>
    {/if}
  {:else}
    <div class="loading">
      <span class="spinner"></span>
      Loading provider details…
    </div>
  {/if}
</div>

<style>
  .connect-service-card {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-3) var(--size-4);
    max-inline-size: 480px;
  }

  .header {
    align-items: flex-start;
    display: flex;
    gap: var(--size-2);
  }

  .icon-wrapper {
    align-items: center;
    background: var(--color-surface-3);
    border-radius: var(--radius-2);
    color: var(--color-accent);
    display: flex;
    flex-shrink: 0;
    inline-size: 32px;
    block-size: 32px;
    justify-content: center;
  }

  .header-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .header-text h3 {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .description {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    line-height: 1.45;
    margin: 0;
  }

  .instructions {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
    font-size: var(--font-size-1);
    line-height: 1.5;
  }

  .instructions :global(p) {
    margin-block: 0.3em;
  }

  .instructions :global(p:first-child) {
    margin-block-start: 0;
  }

  .instructions :global(p:last-child) {
    margin-block-end: 0;
  }

  .popup-blocked {
    background: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
    border-radius: var(--radius-2);
    padding: var(--size-2) var(--size-3);
    font-size: var(--font-size-1);
  }

  .popup-blocked p {
    margin: 0 0 var(--size-2) 0;
    opacity: 0.8;
  }

  .fallback-link {
    background: none;
    border: none;
    color: var(--color-accent);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: 0;
    text-decoration: underline;
  }

  .fallback-link:hover {
    color: var(--color-text);
  }

  .loading {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    gap: var(--size-2);
    font-size: var(--font-size-1);
  }

  .spinner {
    animation: spin 0.8s linear infinite;
    border: 2px solid color-mix(in srgb, var(--color-info), transparent 60%);
    border-block-start-color: var(--color-info);
    border-radius: 50%;
    display: inline-block;
    inline-size: 14px;
    block-size: 14px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-state {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }

  .success-state {
    align-items: center;
    color: var(--color-success);
    display: flex;
    gap: var(--size-2);
    font-size: var(--font-size-2);
  }

  .success-icon {
    background: var(--color-success);
    border-radius: 50%;
    color: white;
    display: inline-flex;
    font-size: 12px;
    font-weight: bold;
    inline-size: 20px;
    block-size: 20px;
    justify-content: center;
    line-height: 20px;
  }

  /* ─── API key form ─────────────────────────────────────────────────────── */

  .apikey-form {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .field label {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .field input {
    background: var(--color-surface-3);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    padding: var(--size-1-5) var(--size-2);
  }

  .field input:focus {
    border-color: var(--color-accent);
    outline: none;
  }

  .field input::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
  }

  .form-error {
    background: color-mix(in srgb, var(--color-error), transparent 90%);
    border: 1px solid color-mix(in srgb, var(--color-error), transparent 50%);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2);
  }

  .form-actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: flex-end;
  }
</style>

<!--
  Single signal row for the signals dashboard card.

  Multi-line layout:
  - Line 1: signal name (mono) + type badge + overflow menu
  - Line 2: provider-specific config (HTTP path, cron schedule, watched path)
  - Line 3: triggered jobs with arrow prefix

  @component
  @param {Signal} signal - Signal data with provider config details
  @param {string} workspaceId - Current workspace ID
-->

<script lang="ts">
  import { Dialog, DropdownMenu, Icons } from "@atlas/ui";
  import InlineBadge from "$lib/components/shared/inline-badge.svelte";
  import { goto } from "$app/navigation";
  import { EXTERNAL_DAEMON_URL, EXTERNAL_TUNNEL_URL } from "$lib/daemon-url";

  type Signal = {
    id: string;
    name: string;
    type: string;
    description: string;
    linkedJobs: string[];
    endpoint?: string;
    schedule?: string;
    timezone?: string;
    watchPath?: string;
  };

  type Props = {
    signal: Signal;
    workspaceId: string;
    /** Agent IDs configured in the workspace (e.g. ["gh", "bb", "claude-code"]) */
    agentIds?: string[];
  };

  let { signal, workspaceId, agentIds = [] }: Props = $props();

  /** Derive which webhook providers to show based on workspace agents. */
  const webhookProviders = $derived.by((): string[] => {
    const providers: string[] = [];
    for (const id of agentIds) {
      if (id === "gh" && !providers.includes("github")) providers.push("github");
      if (id === "bb" && !providers.includes("bitbucket")) providers.push("bitbucket");
    }
    return providers;
  });

  /**
   * Derives a human-readable summary from a cron expression.
   * Handles common patterns; falls back to the raw expression for exotic ones.
   */
  function humanizeCron(expr: string, tz: string): string {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return `${expr} ${tz}`;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Every minute
    if (
      minute === "*" &&
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return `every minute ${tz}`;
    }

    // Every N minutes (*/N * * * *)
    const everyNMin = minute.match(/^\*\/(\d+)$/);
    if (everyNMin && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `every ${everyNMin[1]} min ${tz}`;
    }

    // Hourly at :MM
    if (
      minute.match(/^\d+$/) &&
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return `hourly at :${minute.padStart(2, "0")} ${tz}`;
    }

    // Daily at HH:MM
    if (
      minute.match(/^\d+$/) &&
      hour.match(/^\d+$/) &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return `daily ${formatTime(Number(hour), Number(minute))} ${tz}`;
    }

    // Weekly (specific day of week)
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    if (
      minute.match(/^\d+$/) &&
      hour.match(/^\d+$/) &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek.match(/^\d$/)
    ) {
      const day = dayNames[Number(dayOfWeek)] ?? dayOfWeek;
      return `${day} ${formatTime(Number(hour), Number(minute))} ${tz}`;
    }

    return `${expr} ${tz}`;
  }

  /** Formats hour + minute as 12-hour time (e.g. "9:00 AM"). */
  function formatTime(h: number, m: number): string {
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
  }

  /** Provider-specific config line for display. */
  const configLine = $derived.by((): string | null => {
    const type = signal.type.toLowerCase();
    if (type === "http" && signal.endpoint) {
      const path = signal.endpoint.replace(/^\/+/, "");
      return `POST /signals/${path}`;
    }
    if (type === "schedule" && signal.schedule) {
      const tz = signal.timezone ?? "UTC";
      const human = humanizeCron(signal.schedule, tz);
      return `${signal.schedule} · ${human}`;
    }
    if (type === "fs-watch" && signal.watchPath) {
      return signal.watchPath;
    }
    return null;
  });

  const TUNNEL_URL = EXTERNAL_TUNNEL_URL;

  /** Cached tunnel status — fetched once on first use. */
  let cachedTunnelUrl = $state<string | null>(null);
  let cachedTunnelSecret = $state<string | null>(null);
  let tunnelFetched = $state(false);

  /** Capitalize provider name for display. */
  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** Per-provider secret visibility toggle. */
  let secretVisible: Record<string, boolean> = $state({});

  async function fetchTunnelStatus(): Promise<void> {
    if (tunnelFetched) return;
    tunnelFetched = true;
    try {
      const res = await fetch(`${TUNNEL_URL}/status`);
      if (res.ok) {
        const data = await res.json();
        cachedTunnelUrl = data.url ?? null;
        cachedTunnelSecret = data.secret ?? null;
      }
    } catch {
      // tunnel not running
    }
  }

  // Fetch tunnel status on mount
  $effect(() => {
    void fetchTunnelStatus();
  });

  function copySignalUrl() {
    const url = `${EXTERNAL_DAEMON_URL}/api/workspaces/${workspaceId}/signals/${signal.id}`;
    copyToClipboard(url);
  }

  /** Build webhook URL for a provider. */
  function webhookUrl(provider: string): string {
    return `${cachedTunnelUrl}/hook/${provider}/${workspaceId}/${signal.id}`;
  }

  function copyToClipboard(text: string) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }
</script>

<div class="row">
  <div class="row-header">
    <span class="signal-name">{signal.name}</span>
    <InlineBadge variant="info">{signal.type}</InlineBadge>

    <div class="row-actions">
      <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
        {#snippet children()}
          <DropdownMenu.Trigger class="menu-trigger" aria-label="Signal options">
            <Icons.TripleDots />
          </DropdownMenu.Trigger>

          <DropdownMenu.Content>
            {#if signal.type.toLowerCase() === "http"}
              <DropdownMenu.Item onclick={copySignalUrl}>Copy signal URL</DropdownMenu.Item>
              {#if cachedTunnelUrl && webhookProviders.length > 0}
                <DropdownMenu.Separator />
                {#each webhookProviders as provider (provider)}
                  <DropdownMenu.Item onclick={() => copyToClipboard(webhookUrl(provider))}>
                    Copy {capitalize(provider)} webhook URL
                  </DropdownMenu.Item>
                {/each}
              {/if}
            {/if}
            <DropdownMenu.Item
              onclick={() => goto(`/platform/${workspaceId}/edit?path=signals.${signal.id}`)}
            >
              Edit configuration
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        {/snippet}
      </DropdownMenu.Root>
    </div>
  </div>

  {#if configLine}
    <span class="config-detail">
      {#if signal.type.toLowerCase() === "http"}
        <span class="config-label">Trigger URL</span>
      {:else if signal.type.toLowerCase() === "schedule"}
        <span class="config-label">Schedule</span>
      {:else if signal.type.toLowerCase() === "fs-watch"}
        <span class="config-label">Watch path</span>
      {/if}
      {configLine}
    </span>
  {/if}

  {#if signal.type.toLowerCase() === "http" && cachedTunnelUrl && webhookProviders.length > 0}
    {#each webhookProviders as provider (provider)}
      {@const url = webhookUrl(provider)}
      <Dialog.Root>
        {#snippet children()}
          <Dialog.Trigger>
            <span class="config-detail config-link">
              <span class="config-label">{capitalize(provider)}</span>
              {url}
            </span>
          </Dialog.Trigger>

          <Dialog.Content size="auto">
            <Dialog.Close />
            {#snippet header()}
              <Dialog.Title>{capitalize(provider)} Webhook Setup</Dialog.Title>
            {/snippet}
            {#snippet footer()}
              <div class="webhook-dialog">
                <p class="webhook-instructions">
                  Add this URL to your {capitalize(provider)} repository webhook settings.
                </p>

                <label class="webhook-field-label">Webhook URL</label>
                <div class="webhook-url-row">
                  <code class="webhook-url">{url}</code>
                  <button class="copy-btn" onclick={() => copyToClipboard(url)}>Copy</button>
                </div>

                {#if cachedTunnelSecret}
                  <label class="webhook-field-label">Secret</label>
                  <div class="webhook-url-row">
                    <code class="webhook-url secret-value">
                      {#if secretVisible[provider]}
                        {cachedTunnelSecret}
                      {:else}
                        {"•".repeat(cachedTunnelSecret.length)}
                      {/if}
                      <button
                        class="eye-btn"
                        onclick={() => (secretVisible[provider] = !secretVisible[provider])}
                        aria-label={secretVisible[provider] ? "Hide secret" : "Show secret"}
                      >
                        {#if secretVisible[provider]}
                          <Icons.EyeClosed />
                        {:else}
                          <Icons.Eye />
                        {/if}
                      </button>
                    </code>
                    <button
                      class="copy-btn"
                      onclick={() => copyToClipboard(cachedTunnelSecret ?? "")}
                    >
                      Copy
                    </button>
                  </div>
                {:else}
                  <p class="webhook-no-secret">
                    No webhook secret configured. Set <code>WEBHOOK_SECRET</code>
                     env var to enable signature verification.
                  </p>
                {/if}

                <div class="webhook-close-row">
                  <Dialog.Cancel>Close</Dialog.Cancel>
                </div>
              </div>
            {/snippet}
          </Dialog.Content>
        {/snippet}
      </Dialog.Root>
    {/each}
  {/if}

  {#if signal.linkedJobs.length > 0}
    <span class="triggered-jobs">{"\u2192"} {signal.linkedJobs.join(", ")}</span>
  {/if}
</div>

<style>
  .row {
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-2) var(--size-3);
    position: relative;
  }

  .row-header {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .signal-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .config-detail {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .config-label {
    color: color-mix(in srgb, var(--color-text), transparent 10%);
    font-family: var(--font-family);
    font-size: var(--font-size-1);
    margin-inline-end: var(--size-1);
  }

  .triggered-jobs {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-actions {
    flex-shrink: 0;
    margin-inline-start: auto;
  }

  .row-actions :global(.menu-trigger) {
    align-items: center;
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    justify-content: center;
    opacity: 0;
    padding: var(--size-1);
    transition: opacity 100ms ease;
  }

  .row:hover :global(.menu-trigger),
  :global(.menu-trigger[data-state="open"]) {
    opacity: 1;
  }

  :global(.menu-trigger):hover {
    color: var(--color-text);
  }

  /* Dialog.Trigger renders a <button> wrapper — reset its default styles */
  .row :global(button:has(.config-link)) {
    background: none;
    border: none;
    cursor: pointer;
    display: block;
    padding: 0;
    text-align: start;
    width: 100%;
  }

  .config-link {
    cursor: pointer;
  }

  .config-link:hover {
    color: var(--color-accent);
  }

  .webhook-dialog {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    inline-size: 36rem;
    max-inline-size: 90vw;
  }

  /* Override Dialog footer max-width so fields don't overflow */
  :global(footer:has(.webhook-dialog)) {
    max-inline-size: unset !important;
  }

  .webhook-instructions {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-2);
    margin: 0;
  }

  .webhook-field-label {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    opacity: 0.7;
  }

  .webhook-url-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .webhook-url {
    background: var(--color-surface-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    flex: 1;
    font-size: var(--font-size-2);
    min-inline-size: 0;
    overflow: hidden;
    padding: var(--size-2) var(--size-3);
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .secret-value {
    padding-inline-end: var(--size-8);
    position: relative;
  }

  .eye-btn {
    align-items: center;
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    cursor: pointer;
    display: flex;
    inset-block-start: 50%;
    inset-inline-end: var(--size-2);
    padding: var(--size-1);
    position: absolute;
    transform: translateY(-50%);
  }

  .eye-btn:hover {
    color: var(--color-text);
  }

  .copy-btn {
    background: var(--color-surface-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    flex-shrink: 0;
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
  }

  .copy-btn:hover {
    background: var(--color-surface-3);
  }

  .webhook-no-secret {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
    margin: 0;
  }

  .webhook-no-secret code {
    background: var(--color-surface-2);
    border-radius: var(--radius-1);
    font-size: var(--font-size-1);
    padding: var(--size-0-5) var(--size-1);
  }

  .webhook-close-row {
    display: flex;
    justify-content: flex-end;
    margin-block-start: var(--size-2);
  }
</style>

<script lang="ts">
  /**
   * Credential panel for bundled agents. Shows per-credential status from
   * preflight data and provides connect/manual-input flows.
   *
   * Replaces the generic env-editor for agents that have preflight metadata.
   *
   * @component
   */
  import { Button, Icons } from "@atlas/ui";
  import type { AgentPreflightCredential } from "$lib/queries";

  type Props = {
    credentials: AgentPreflightCredential[];
    manualOverrides: Record<string, string>;
    onconnect: (provider: string) => void;
    onapikey: (provider: string) => void;
  };

  let { credentials, manualOverrides = $bindable(), onconnect, onapikey }: Props = $props();

  const required = $derived(credentials.filter((c) => c.required));
  const optional = $derived(credentials.filter((c) => !c.required));

  let advancedOpen = $state(false);

  /** Track which manual inputs have been revealed (password toggle). */
  let revealed = $state<Record<string, boolean>>({});

  function toggleReveal(key: string) {
    revealed[key] = !revealed[key];
  }

  function handleManualInput(key: string, value: string) {
    manualOverrides = { ...manualOverrides, [key]: value };
  }

  /** Track which missing credentials have expanded manual input. */
  let manualExpanded = $state<Record<string, boolean>>({});

  function toggleManualExpand(key: string) {
    manualExpanded[key] = !manualExpanded[key];
  }
</script>

<div class="credential-panel" role="group" aria-label="Credentials">
  <span class="section-label">Credentials</span>

  {#if required.length > 0}
    <div class="credential-rows">
      {#each required as cred (cred.envKey)}
        <div class="credential-row">
          <span
            class="status-dot"
            class:connected={cred.status === "connected"}
            class:disconnected={cred.status === "disconnected"}
          ></span>

          <code class="env-key">{cred.envKey}</code>

          {#if cred.status === "connected"}
            <span class="status-label connected">
              {#if cred.source === "link"}
                Connected via {cred.provider}{#if cred.label}
                  ({cred.label}){/if}
              {:else if cred.source === "env"}
                Available from environment
              {:else}
                Connected
              {/if}
            </span>
          {:else}
            <span class="status-label disconnected">Not connected</span>

            {#if cred.linkRef}
              <Button
                variant="secondary"
                size="small"
                onclick={() => {
                  if (cred.linkRef) onconnect(cred.linkRef.provider);
                }}
              >
                Connect {cred.provider ?? "service"}
              </Button>
            {/if}

            <button
              class="manual-toggle"
              onclick={() => toggleManualExpand(cred.envKey)}
              aria-expanded={manualExpanded[cred.envKey] ?? false}
            >
              <span class="toggle-icon" class:open={manualExpanded[cred.envKey]}>
                <Icons.TriangleRight />
              </span>
              Enter manually
            </button>

            {#if manualExpanded[cred.envKey]}
              <div class="manual-input-row">
                <input
                  class="input"
                  type={revealed[cred.envKey] ? "text" : "password"}
                  value={manualOverrides[cred.envKey] ?? ""}
                  oninput={(e) => handleManualInput(cred.envKey, e.currentTarget.value)}
                  placeholder={cred.envKey}
                  aria-label="Value for {cred.envKey}"
                />
                <Button
                  variant="secondary"
                  size="small"
                  aria-label={revealed[cred.envKey] ? "Hide value" : "Show value"}
                  onclick={() => toggleReveal(cred.envKey)}
                >
                  {#if revealed[cred.envKey]}
                    <Icons.Eye />
                  {:else}
                    <Icons.EyeClosed />
                  {/if}
                </Button>
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if optional.length > 0}
    <button
      class="advanced-toggle"
      onclick={() => (advancedOpen = !advancedOpen)}
      aria-expanded={advancedOpen}
    >
      <span class="toggle-icon" class:open={advancedOpen}>
        <Icons.TriangleRight />
      </span>
      Advanced ({optional.length})
    </button>

    {#if advancedOpen}
      <div class="credential-rows">
        {#each optional as cred (cred.envKey)}
          <div class="credential-row optional">
            <span
              class="status-dot"
              class:connected={cred.status === "connected"}
              class:muted={cred.status === "disconnected"}
            ></span>

            <code class="env-key">{cred.envKey}</code>

            {#if cred.status === "connected"}
              <span class="status-label connected">
                {#if cred.source === "env"}
                  Available from environment
                {:else if cred.source === "link"}
                  Connected via {cred.provider}
                {:else}
                  Connected
                {/if}
              </span>
            {:else}
              <span class="status-label muted">Optional</span>
              <div class="manual-input-row">
                <input
                  class="input"
                  type={revealed[cred.envKey] ? "text" : "password"}
                  value={manualOverrides[cred.envKey] ?? ""}
                  oninput={(e) => handleManualInput(cred.envKey, e.currentTarget.value)}
                  placeholder={cred.envKey}
                  aria-label="Value for {cred.envKey}"
                />
                <Button
                  variant="secondary"
                  size="small"
                  aria-label={revealed[cred.envKey] ? "Hide value" : "Show value"}
                  onclick={() => toggleReveal(cred.envKey)}
                >
                  {#if revealed[cred.envKey]}
                    <Icons.Eye />
                  {:else}
                    <Icons.EyeClosed />
                  {/if}
                </Button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .credential-panel {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .credential-rows {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .credential-row {
    align-items: flex-start;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-3);
  }

  .credential-row.optional {
    border-color: color-mix(in srgb, var(--color-border-1), transparent 40%);
  }

  .status-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 7px;
    margin-block-start: var(--size-1);
  }

  .status-dot.connected {
    background-color: var(--color-success);
  }

  .status-dot.disconnected {
    background-color: var(--color-error);
  }

  .status-dot.muted {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
  }

  .env-key {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .status-label {
    font-size: var(--font-size-2);
  }

  .status-label.connected {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .status-label.disconnected {
    color: var(--color-error);
  }

  .status-label.muted {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  .manual-toggle {
    align-items: center;
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1);
    padding: 0;
  }

  .manual-toggle:hover {
    color: var(--color-text);
  }

  .advanced-toggle {
    align-items: center;
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    padding: 0;
  }

  .advanced-toggle:hover {
    color: var(--color-text);
  }

  .toggle-icon {
    display: inline-flex;
    transition: transform 150ms ease;
  }

  .toggle-icon :global(svg) {
    block-size: 10px;
    inline-size: 10px;
  }

  .toggle-icon.open {
    transform: rotate(90deg);
  }

  .manual-input-row {
    align-items: center;
    display: flex;
    gap: var(--size-1);
    inline-size: 100%;
  }

  .input {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: var(--color-text);
    flex: 1;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    padding-block: var(--size-1);
    padding-inline: var(--size-2);
  }

  .input:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 50%);
    outline: none;
  }
</style>

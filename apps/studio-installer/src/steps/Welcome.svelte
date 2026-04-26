<script lang="ts">
import type { InstallMode } from "../lib/store.svelte.ts";
import { advanceStep } from "../lib/installer.ts";

interface Props {
  mode: InstallMode;
  installedVersion: string | null;
  availableVersion: string;
  studioRunning: boolean;
}

const { mode, installedVersion, availableVersion, studioRunning }: Props = $props();

async function openStudio(): Promise<void> {
  const { default: opener } = await import("@tauri-apps/plugin-opener");
  await opener.open("http://localhost:5200");
}
</script>

<div class="screen">
  <div class="hero">
    <svg class="logo" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
      <path d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z" fill="#1171DF"/>
    </svg>

    {#if mode === "fresh"}
      <h1>Welcome to Friday Studio</h1>
      <p class="subtitle">
        Orchestrate agentic workflows from a single config file.<br />Versionable, shareable, repeatable.
      </p>
      <div class="actions">
        <button class="primary" onclick={advanceStep}>Install</button>
      </div>
    {:else if mode === "update"}
      <h1>Update Available</h1>
      <p class="version-badge">
        v{installedVersion} → v{availableVersion}
      </p>
      {#if studioRunning}
        <div class="warning">
          <span class="warning-icon" aria-hidden="true">⚠</span>
          Friday Studio is currently running. The update will stop it briefly.
        </div>
        <div class="actions">
          <button class="primary" onclick={advanceStep}>Update Studio</button>
          <button class="secondary" onclick={openStudio}>Open Studio</button>
        </div>
      {:else}
        <p class="subtitle">
          A new version of Friday Studio is ready to install.
        </p>
        <div class="actions">
          <button class="primary" onclick={advanceStep}>Update Studio</button>
        </div>
      {/if}
    {:else if mode === "current"}
      <h1>You're up to date</h1>
      <p class="version-badge">v{installedVersion ?? availableVersion}</p>
      <p class="subtitle">Friday Studio is already at the latest version.</p>
      <div class="actions">
        {#if studioRunning}
          <button class="primary" onclick={openStudio}>Open Studio</button>
        {:else}
          <button class="primary" onclick={advanceStep}>Launch Studio</button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="step-dots" aria-hidden="true">
    <span class="dot active"></span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 48px 60px 40px;
  }

  .hero {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 14px;
  }

  .logo {
    width: 52px;
    height: 52px;
    margin-bottom: 8px;
  }

  h1 {
    font-size: 26px;
    font-weight: 700;
    color: light-dark(#111, #f0f0f0);
    letter-spacing: -0.5px;
  }

  .subtitle {
    font-size: 14px;
    color: light-dark(#666, #888);
    max-width: 380px;
    line-height: 1.6;
    text-align: center;
  }

  .version-badge {
    font-size: 13px;
    color: #6b72f0;
    background: rgba(107, 114, 240, 0.12);
    padding: 4px 12px;
    border-radius: 20px;
    font-family: monospace;
  }

  .warning {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.25);
    border-radius: 8px;
    padding: 10px 16px;
    max-width: 380px;
  }

  .warning-icon {
    font-size: 16px;
    flex-shrink: 0;
  }

  .actions {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }

  button {
    padding: 10px 28px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .primary {
    background: #6b72f0;
    color: #fff;
  }

  .primary:hover {
    background: #5a62e0;
  }

  .secondary {
    background: light-dark(#e8e8e8, #2a2a2a);
    color: light-dark(#444, #ccc);
    border: 1px solid light-dark(#d0d0d0, #3a3a3a);
  }

  .secondary:hover {
    background: light-dark(#ddd, #333);
  }

  .step-dots {
    display: flex;
    justify-content: center;
    gap: 6px;
    padding-top: 16px;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: light-dark(#ccc, #333);
  }

  .dot.active {
    background: #6b72f0;
  }
</style>

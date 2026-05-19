<!--
  Per-server section nav — the middle-column content once a catalog server is
  selected. Shows the server's name and a list of detail sections; the catalog
  list animates out and this animates in within the ListDetail sidebar.

  Section navigation is unlocked only once the server is `ready` — an install
  still in progress has nothing to configure yet.

  @component
-->

<script lang="ts">
  import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
  import { shortenServerName } from "./mcp-server-utils";

  interface Props {
    server: MCPServerMetadata | null;
    activeSection: string;
    onSelectSection: (section: string) => void;
  }

  const { server, activeSection, onSelectSection }: Props = $props();

  const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "connections", label: "Connections" },
    { id: "configuration", label: "Config Reference" },
    { id: "tools", label: "Testing" },
    { id: "readme", label: "Readme" },
  ] as const;

  const status = $derived(server?.status ?? "ready");
  const isReady = $derived(status === "ready");
</script>

<div class="section-nav-root">
  {#if !server}
    <p class="loading">Loading server…</p>
  {:else}
    <div class="server-ident">
      <span class="server-name">{shortenServerName(server.name)}</span>
    </div>

    {#if isReady}
      <nav class="section-nav">
        {#each SECTIONS as s (s.id)}
          <button
            type="button"
            class="section-nav-item"
            class:active={activeSection === s.id}
            onclick={() => onSelectSection(s.id)}
          >
            {s.label}
          </button>
        {/each}
      </nav>
    {:else}
      <p class="install-note">
        Section navigation unlocks once the setup doctor finishes.
      </p>
    {/if}
  {/if}
</div>

<style>
  .section-nav-root {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .loading {
    color: var(--text-faded);
    font-size: var(--font-size-3);
    margin: 0;
    padding: 0 var(--size-1);
  }

  .server-ident {
    padding: 0 var(--size-1);
  }

  .server-name {
    color: var(--text-bright);
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
    word-break: break-word;
  }

  .section-nav {
    display: flex;
    flex-direction: column;
  }

  .section-nav-item {
    background: none;
    border: none;
    border-radius: var(--radius-2-5);
    color: var(--text-faded);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    padding: var(--size-1-5) var(--size-2-5);
    text-align: start;
    transition: background-color 100ms ease, color 100ms ease;
  }

  .section-nav-item:hover:not(.active) {
    color: var(--text);
  }

  .section-nav-item.active {
    background-color: var(--highlight);
    color: var(--text-bright);
  }

  .install-note {
    color: var(--text-faded);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: 0;
    padding: 0 var(--size-1);
  }
</style>

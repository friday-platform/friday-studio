<script lang="ts">
  import { Collapsible, IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import WorkspaceLoader from "$lib/components/workspace/workspace-loader.svelte";
  import { daemonHealth } from "$lib/daemon-health.svelte";
  import { workspaceQueries } from "$lib/queries";

  const pathname = $derived(page.url.pathname);
  /** Workspace ID from route param (platform pages). */
  const activeWorkspaceId = $derived(page.params.workspaceId as string | undefined);

  let showLoader = $state(false);
  let showTooltip = $state(false);

  const workspacesQuery = createQuery(() => workspaceQueries.enriched());
  const visibleWorkspaces = $derived(workspacesQuery.data ?? []);

  type NavItem = { label: string; href: string };

  const toolLinks: NavItem[] = [
    { label: "Agent Tester", href: "/agents/built-in" },
    { label: "Job Inspector", href: "/inspector" },
    { label: "Skills", href: "/skills" },
  ];

  function isToolActive(href: string): boolean {
    return pathname.startsWith(href);
  }

  const COLORS: Record<string, string> = {
    yellow: "var(--yellow-2, #facc15)",
    purple: "var(--purple-2, #a78bfa)",
    red: "var(--red-2, #f87171)",
    blue: "var(--blue-2, #60a5fa)",
    green: "var(--green-2, #4ade80)",
    brown: "var(--brown-2, #a3824a)",
  };

  function dotColor(color: string | undefined): string {
    return COLORS[color ?? "yellow"] ?? COLORS["yellow"] ?? "#facc15";
  }
</script>

<nav class="sidebar">
  <header class="sidebar-header">
    <svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
      <path
        d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z"
        fill="#1171DF"
      />
    </svg>
    <h1>Friday</h1>
    <span class="spacer"></span>
    <span class="status-dot-wrapper">
      <button
        class="status-dot"
        class:connected={daemonHealth.connected}
        class:disconnected={!daemonHealth.connected && !daemonHealth.loading}
        class:loading={daemonHealth.loading}
        aria-label={daemonHealth.connected ? "Daemon connected" : "Daemon unreachable"}
        onclick={() => {
          if (!daemonHealth.connected) showTooltip = !showTooltip;
        }}
      ></button>
      {#if showTooltip && !daemonHealth.connected}
        <div class="tooltip" role="tooltip">
          <p>Daemon unreachable. Start it with:</p>
          <code>deno task atlas daemon start --detached</code>
        </div>
      {/if}
    </span>
  </header>

  <div class="sidebar-nav">
    <Collapsible.Root defaultOpen={true}>
      <Collapsible.Trigger>
        {#snippet children(_open)}
          <span class="section-trigger">
            Spaces <IconSmall.CaretDown />
          </span>
        {/snippet}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ul class="section-list">
          {#each visibleWorkspaces as ws (ws.id)}
            {@const active = activeWorkspaceId === ws.id}
            <li>
              <a href="/platform/{ws.id}" class="nav-item" class:active>
                <span class="dot" style:background-color={dotColor(ws.metadata?.color)}></span>
                <span class="text">
                  {ws.displayName}
                </span>
              </a>

              {#if active}
                {@const base = `/platform/${ws.id}`}
                {@const isBase = pathname === base || pathname === `${base}/`}
                {@const subPages = [
                  { label: "Overview", href: base, isActive: isBase },
                  {
                    label: "Agents",
                    href: `${base}/agents`,
                    isActive: pathname.startsWith(`${base}/agents`),
                  },
                  {
                    label: "Skills",
                    href: `${base}/skills`,
                    isActive: pathname.startsWith(`${base}/skills`),
                  },
                  {
                    label: "Jobs",
                    href: `${base}/jobs`,
                    isActive: pathname.startsWith(`${base}/jobs`),
                  },
                  {
                    label: "Runs",
                    href: `${base}/sessions`,
                    isActive: pathname.startsWith(`${base}/sessions`),
                  },
                ]}
                <ul class="sub-nav">
                  {#each subPages as sub (sub.label)}
                    <li>
                      <a href={sub.href} class="nav-item" class:active={sub.isActive}>
                        {sub.label}
                      </a>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}

          <li>
            <button
              class="nav-item as-button"
              onclick={() => {
                showLoader = !showLoader;
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M6.625 3.875H5.1125C4.42905 3.875 3.875 4.42905 3.875 5.1125V6.625M12.125 9.375V10.8875C12.125 11.571 11.571 12.125 10.8875 12.125H9.375M9.375 3.875H10.8875C11.571 3.875 12.125 4.42905 12.125 5.1125V6.625M6.625 12.125H5.1125C4.42905 12.125 3.875 11.571 3.875 10.8875V9.375"
                  stroke="currentColor"
                  stroke-linecap="round"
                />
              </svg>
              Add Space
            </button>
          </li>
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>

    <Collapsible.Root defaultOpen={true}>
      <Collapsible.Trigger>
        {#snippet children(_open)}
          <span class="section-trigger">
            Tools <IconSmall.CaretDown />
          </span>
        {/snippet}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ul class="section-list">
          {#each toolLinks as link (link.href)}
            <li>
              <a href={link.href} class="nav-item" class:active={isToolActive(link.href)}>
                {link.label}
              </a>
            </li>
          {/each}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  </div>
</nav>

{#if showLoader}
  <div class="loader-overlay" role="dialog" aria-label="Load workspace">
    <WorkspaceLoader
      onclose={() => {
        showLoader = false;
      }}
    />
  </div>
{/if}

<style>
  .sidebar {
    background-color: var(--color-surface-2);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    scrollbar-width: none;
    user-select: none;
  }

  .sidebar-header {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    padding-block: var(--size-5) var(--size-1);
    padding-inline: var(--size-5);

    .logo {
      block-size: 20px;
      flex-shrink: 0;
      inline-size: 20px;
    }

    h1 {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-6);
    }
  }

  .spacer {
    flex: 1;
  }

  .status-dot-wrapper {
    position: relative;
  }

  .status-dot {
    background-color: var(--color-border-2);
    block-size: 8px;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    inline-size: 8px;
    padding: 0;
    transition: background-color 200ms ease;
  }

  .status-dot.connected {
    background-color: var(--color-success);
  }

  .status-dot.disconnected {
    background-color: var(--color-error);
  }

  .status-dot.loading {
    background-color: var(--color-border-2);
  }

  .tooltip {
    background-color: var(--color-surface-3);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    font-size: var(--font-size-1);
    inset-block-start: calc(100% + var(--size-2));
    inset-inline-end: 0;
    padding: var(--size-3);
    position: absolute;
    white-space: nowrap;
    z-index: 10;

    p {
      color: color-mix(in srgb, var(--color-text), transparent 30%);
      margin-block-end: var(--size-1);
    }

    code {
      background-color: var(--color-surface-1);
      border-radius: var(--radius-1);
      color: var(--color-text);
      display: block;
      font-size: var(--font-size-1);
      padding: var(--size-1) var(--size-2);
    }
  }

  /* --- Nav section (matches web-client nav) --- */

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding-block: var(--size-5) 0;
    padding-inline: var(--size-3);
  }

  .section-trigger {
    block-size: var(--size-4);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
    padding-inline: var(--size-3);
    margin-block-end: var(--size-1);

    :global(svg) {
      transform: rotate(-90deg);
      transition: transform 150ms ease;
    }
  }

  :global([data-melt-collapsible-trigger][data-state="open"]) .section-trigger :global(svg) {
    transform: rotate(0deg);
  }

  .section-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-inline: var(--size-1);
    padding-block-end: var(--size-2);

    li {
      inline-size: 100%;
    }
  }

  .nav-item {
    align-items: center;
    block-size: var(--size-6);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    inline-size: 100%;
    outline: none;
    padding-inline: var(--size-2-5) var(--size-2);
    position: relative;

    :global(svg) {
      opacity: 0.5;
    }
  }

  .nav-item .text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    text-wrap: nowrap;
  }

  .nav-item.active {
    background-color: hsl(0 0 100% / 0.05);

    :global(svg) {
      color: var(--blue-2);
      opacity: 1;
    }
  }

  .dot {
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;
  }

  .as-button {
    all: unset;
    align-items: center;
    block-size: var(--size-6);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    inline-size: 100%;
    outline: none;
    padding-inline: var(--size-2-5) var(--size-2);
    position: relative;

    :global(svg) {
      opacity: 0.5;
    }
  }

  /* --- Sub-nav (matches web-client .sub-nav) --- */

  .sub-nav {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    margin-block-start: var(--size-0-5);

    .nav-item {
      font-weight: var(--font-weight-4);
      padding-inline-start: var(--size-7);
    }

    .nav-item.active {
      background-color: unset;
      text-decoration: underline;
    }
  }

  .loader-overlay {
    background-color: color-mix(in srgb, var(--color-surface-1), transparent 5%);
    display: flex;
    inset: 0;
    justify-content: center;
    align-items: center;
    position: fixed;
    z-index: var(--layer-5);
  }
</style>

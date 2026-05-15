<script lang="ts">
  import type { Elicitation } from "@atlas/core/elicitations/model";
  import { Collapsible, Dialog, IconLarge, IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import FridayMark from "$lib/components/shared/friday-mark.svelte";
  import CreateWorkspaceForm from "$lib/components/workspace/create-workspace-form.svelte";
  import WorkspaceLoader from "$lib/components/workspace/workspace-loader.svelte";
  import { daemonHealth } from "$lib/daemon-health.svelte";
  import { countPendingElicitations, nextElicitationTickMs } from "$lib/elicitation-counts.ts";
  import { workspaceQueries } from "$lib/queries";
  import { elicitationQueries } from "$lib/queries/elicitation-queries.ts";
  import type { Component } from "svelte";
  import { writable } from "svelte/store";

  const pathname = $derived(page.url.pathname);
  /** Workspace ID from route param (platform pages). */
  const activeWorkspaceId = $derived(page.params.workspaceId as string | undefined);

  const addDialogOpen = writable(false);
  let showTooltip = $state(false);
  let addTab = $state<"create" | "upload">("create");

  const workspacesQuery = createQuery(() => workspaceQueries.enriched());
  const elicitationsQuery = createQuery(() => elicitationQueries.list(null));
  const elicitations = $derived<Elicitation[]>(elicitationsQuery.data ?? []);

  // Sidebar pending-elicitation badges only care about the count flipping
  // — no countdown text. A blanket 30s `setInterval` polling
  // `Date.now()` ran on every layout, mutating reactive state every
  // tick whether or not any elicitation was actually approaching its
  // deadline. Replace with a one-shot timer aimed at the soonest
  // pending `expiresAt`: zero ticks when nothing is pending, one wakeup
  // per deadline. The global-elicitations SSE stream already merges
  // status transitions into the cache reactively, so this only covers
  // the lazy `pending → expired` flip the server's sweeper hasn't
  // caught yet.
  let nowMs = $state<number>(Date.now());
  $effect(() => {
    if (!browser) return;
    const next = nextElicitationTickMs(elicitations, nowMs, false);
    if (next === null) return;
    const delay = Math.max(0, next - Date.now());
    const timer = setTimeout(() => {
      nowMs = Date.now();
    }, delay);
    return () => clearTimeout(timer);
  });

  const globalPendingElicitations = $derived(countPendingElicitations(elicitations, nowMs));
  const activeWorkspacePendingElicitations = $derived(
    activeWorkspaceId ? countPendingElicitations(elicitations, nowMs, activeWorkspaceId) : 0,
  );

  // Personal workspace is always pinned at the top; every other workspace
  // follows in the backend's delivery order. The `ws.id === "user"` check
  // matches the same identity used elsewhere in the playground.
  const visibleWorkspaces = $derived(
    [...(workspacesQuery.data ?? [])].sort((a, b) => {
      if (a.id === "user") return -1;
      if (b.id === "user") return 1;
      return 0;
    }),
  );

  type NavItem = { label: string; href: string; icon: Component };

  const toolLinks: NavItem[] = [
    { label: "Chat", href: "/platform/user/chat", icon: IconLarge.SpeechBubble },
    { label: "Memory", href: "/memory", icon: IconLarge.Write },
    { label: "Activity", href: "/activity", icon: IconLarge.SpeechBubble },
    { label: "Agent Tester", href: "/agents", icon: IconLarge.Chip },
    { label: "Job Inspector", href: "/inspector", icon: IconLarge.DiamondCheck },
    { label: "Schedules", href: "/schedules", icon: IconLarge.Target },
    { label: "MCP Catalog", href: "/mcp", icon: IconLarge.Wrench },
    { label: "Skills", href: "/skills", icon: IconLarge.Compass },
    { label: "Usage", href: "/usage", icon: IconLarge.Target },
    // { label: "Discover Spaces", href: "/discover", icon: IconLarge.OpenSquare },
    { label: "Settings", href: "/settings", icon: IconLarge.Gear },
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

<header class="sidebar">
  <div class="sidebar-header">
    <FridayMark class="logo" />
    <h1>Friday</h1>
  </div>

  <nav class="sidebar-nav">
    <ul class="section-list">
      {#each toolLinks as link (link.href)}
        {@const Icon = link.icon}
        <li>
          <a href={link.href} class="nav-item" class:active={isToolActive(link.href)}>
            <Icon />
            <span class="nav-label">{link.label}</span>
            {#if link.href === "/activity" && globalPendingElicitations > 0}
              <span
                class="pending-badge"
                data-testid="global-activity-pending-badge"
                aria-label={`${globalPendingElicitations} pending activity items`}
              >
                {globalPendingElicitations}
              </span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>

    <ul class="section-list">
      <li>
        <a href="/discover" class="nav-item" class:active={isToolActive("/discover")}>
          <IconLarge.OpenSquare />
          Discover Spaces
        </a>
      </li>
    </ul>

    <Collapsible.Root defaultOpen={true}>
      <div class="section-header">
        <Collapsible.Trigger>
          {#snippet children(_open)}
            <span class="section-trigger">
              Spaces <IconSmall.CaretDown />
            </span>
          {/snippet}
        </Collapsible.Trigger>
        <button
          class="add-space-btn"
          onclick={() => addDialogOpen.set(true)}
          aria-label="Add space"
        >
          <IconSmall.Plus />
        </button>
      </div>
      <Collapsible.Content>
        <ul class="section-list">
          {#each visibleWorkspaces as ws (ws.id)}
            {@const active = activeWorkspaceId === ws.id}
            <li>
              <a href="/platform/{ws.id}" class="nav-item" class:active>
                <span class="dot" style:--dot-color={dotColor(ws.metadata?.color)}></span>
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
                    label: "Activity",
                    href: `${base}/activity`,
                    isActive: pathname.startsWith(`${base}/activity`),
                  },
                  {
                    label: "Chat",
                    href: `${base}/chat`,
                    isActive: pathname.startsWith(`${base}/chat`),
                  },
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
                  {
                    label: "Memory",
                    href: `/memory/${ws.id}`,
                    isActive: pathname.startsWith(`/memory/${ws.id}`),
                  },
                  {
                    label: "Settings",
                    href: `${base}/settings`,
                    isActive: pathname.startsWith(`${base}/settings`),
                  },
                ]}
                <ul class="sub-nav">
                  {#each subPages as sub (sub.label)}
                    <li>
                      <a href={sub.href} class="nav-item" class:active={sub.isActive}>
                        <span class="nav-label">{sub.label}</span>
                        {#if sub.label === "Activity" && activeWorkspacePendingElicitations > 0}
                          <span
                            class="pending-badge"
                            data-testid="workspace-activity-pending-badge"
                            aria-label={`${activeWorkspacePendingElicitations} pending activity items`}
                          >
                            {activeWorkspacePendingElicitations}
                          </span>
                        {/if}
                      </a>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  </nav>

  <div class="footer">
    <a href="https://docs.hellofriday.ai" target="_blank">Docs</a>

    <span class="status-wrapper">
      <button
        class="status"
        onclick={() => {
          if (!daemonHealth.connected) showTooltip = !showTooltip;
        }}
      >
        <span
          class:connected={daemonHealth.connected}
          class:disconnected={!daemonHealth.connected && !daemonHealth.loading}
          class:loading={daemonHealth.loading}
        ></span>

        {daemonHealth.connected ? "Online" : "Offline"}
      </button>

      {#if showTooltip && !daemonHealth.connected}
        <div class="tooltip" role="tooltip">
          <p>Background services are reconnecting. This usually clears in a few seconds.</p>
        </div>
      {/if}
    </span>
  </div>
</header>

<Dialog.Root
  open={addDialogOpen}
  onOpenChange={({ next }) => {
    if (!next) addTab = "create";
    return next;
  }}
>
  <Dialog.Content>
    <Dialog.Close />

    {#snippet header()}
      <Dialog.Title>Add space</Dialog.Title>
      <Dialog.Description>Your agents, jobs, and signals. Ready to run.</Dialog.Description>
      <div class="tab-bar">
        <button class="tab" class:active={addTab === "create"} onclick={() => (addTab = "create")}>
          Create New
        </button>
        <button class="tab" class:active={addTab === "upload"} onclick={() => (addTab = "upload")}>
          Upload File
        </button>
      </div>
    {/snippet}

    {#if addTab === "create"}
      <CreateWorkspaceForm onclose={() => addDialogOpen.set(false)} />
    {:else}
      <WorkspaceLoader inline onclose={() => addDialogOpen.set(false)} />
    {/if}

    {#snippet footer()}
      <Dialog.Cancel>Cancel</Dialog.Cancel>
    {/snippet}
  </Dialog.Content>
</Dialog.Root>

<style>
  .sidebar {
    background-color: var(--surface-dark);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    scrollbar-width: none;
    user-select: none;
  }

  .sidebar-header {
    align-items: center;
    background: linear-gradient(to bottom, var(--surface-dark) 60%, transparent);
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    padding-block: var(--size-5) var(--size-3);
    padding-inline: var(--size-5);
    position: sticky;
    top: 0;
    z-index: 1;

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

  /* --- Tab bar (Add space dialog) --- */
  .tab-bar {
    display: flex;
    gap: var(--size-1);
    margin-block-start: var(--size-3);
  }

  .tab {
    all: unset;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    padding: var(--size-1-5) var(--size-3);
    transition: all 150ms ease;
  }

  .tab:hover {
    color: var(--color-text);
  }

  .tab.active {
    border-color: var(--color-accent);
    color: var(--color-text);
  }

  /* --- Nav section --- */

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding-block: var(--size-5) 0;
    padding-inline: var(--size-3);
  }

  .section-header {
    align-items: center;
    block-size: var(--size-6);
    display: flex;
    justify-content: space-between;
    padding-inline-end: var(--size-2);
  }

  .add-space-btn {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: flex;
    padding: var(--size-1);
    transition: color 100ms ease;

    &:hover {
      color: var(--color-text);
    }
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

    li {
      inline-size: 100%;
    }
  }

  .nav-item {
    align-items: center;
    block-size: var(--size-7-5);
    border-radius: var(--radius-2-5);
    color: var(--text);
    display: flex;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    inline-size: 100%;
    outline: none;
    padding-inline: var(--size-2-5) var(--size-2);
    position: relative;
    transition: 100ms ease all;

    :global(svg) {
      opacity: 0.4;
      transition: 100ms ease all;

      @media (prefers-color-scheme: light) {
        opacity: 0.6;
      }
    }

    .text,
    .nav-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      text-wrap: nowrap;
    }

    .pending-badge {
      align-items: center;
      background-color: var(--color-red-9, #dc2626);
      border-radius: var(--radius-round);
      color: white;
      display: inline-flex;
      flex-shrink: 0;
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-7);
      justify-content: center;
      line-height: 1;
      min-inline-size: var(--size-4-5);
      padding-block: var(--size-0-5);
      padding-inline: var(--size-1);
    }

    &.active {
      background-color: var(--highlight);
      color: var(--text-bright);

      :global(svg) {
        opacity: 1;
      }
    }
  }

  .dot {
    align-items: center;
    aspect-ratio: 1;
    block-size: var(--size-5);
    display: flex;
    justify-content: center;

    &:after {
      aspect-ratio: 1;
      background-color: var(--dot-color);
      block-size: var(--size-2);
      border-radius: var(--radius-round);
      content: "";
      flex-shrink: 0;
      inline-size: var(--size-2);
    }
  }

  /* --- Sub-nav --- */

  .sub-nav {
    display: flex;
    flex-direction: column;
    margin-block-start: var(--size-0-5);

    .nav-item {
      block-size: var(--size-6-5);
      color: var(--text-faded);
      font-weight: var(--font-weight-4-5);
      padding-inline-start: var(--size-10);
    }

    .nav-item.active {
      background-color: unset;
      text-decoration: underline;
    }
  }

  .footer {
    align-items: center;
    background: linear-gradient(to top, var(--surface-dark) 50%, transparent);
    display: flex;
    gap: var(--size-3);
    inset-block-end: 0;
    margin-block: auto 0;
    padding-block: var(--size-6);
    padding-inline: var(--size-6);
    /* Sticky footer overlays the bottom of the scrollable workspace list.
       Only the Docs pill is meant to be interactive; everything else
       (status pill, dead space, fade) passes clicks through to the
       workspace row beneath. */
    pointer-events: none;
    position: sticky;

    a {
      align-items: center;
      background-color: var(--surface);
      border-radius: var(--radius-round);
      block-size: var(--size-7);
      display: inline flex;
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5-5);
      justify-content: center;
      padding-inline: var(--size-2-5);
      pointer-events: auto;
      transition: all 200ms ease;

      &:hover {
        background-color: color-mix(in srgb, var(--surface), var(--text) 10%);
      }

      @media (prefers-color-scheme: light) {
        background-color: color-mix(in srgb, black 5%, transparent);

        &:hover {
          background-color: color-mix(in srgb, black 10%, transparent);
        }
      }
    }
  }

  .status-wrapper {
    position: relative;
  }

  .status {
    align-items: center;
    color: var(--text);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-1-5);

    span {
      background-color: var(--green-primary);
      border-radius: var(--radius-round);
      block-size: var(--size-1-5);
      inline-size: var(--size-1-5);

      &.connected {
        background-color: var(--green-primary);
      }

      &.disconnected {
        background-color: var(--red-primary);
      }

      /* &.loading {
        background-color: var(--color-border-2);
      } */
    }
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

  }
</style>

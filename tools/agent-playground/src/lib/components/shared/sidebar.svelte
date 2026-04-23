<script lang="ts">
  import { Collapsible, Dialog, IconLarge, IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import CreateWorkspaceForm from "$lib/components/workspace/create-workspace-form.svelte";
  import WorkspaceLoader from "$lib/components/workspace/workspace-loader.svelte";
  import { daemonHealth } from "$lib/daemon-health.svelte";
  import { workspaceQueries } from "$lib/queries";
  import type { Component } from "svelte";
  import { writable } from "svelte/store";

  const pathname = $derived(page.url.pathname);
  /** Workspace ID from route param (platform pages). */
  const activeWorkspaceId = $derived(page.params.workspaceId as string | undefined);

  const addDialogOpen = writable(false);
  let showTooltip = $state(false);
  let addTab = $state<"create" | "upload">("create");

  const workspacesQuery = createQuery(() => workspaceQueries.enriched());
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
    { label: "Improvements", href: "/improvements", icon: IconLarge.Target },
    { label: "Agent Tester", href: "/agents/built-in", icon: IconLarge.Chip },
    { label: "Job Inspector", href: "/inspector", icon: IconLarge.DiamondCheck },
    { label: "MCP Servers", href: "/mcp", icon: IconLarge.Wrench },
    { label: "Skills", href: "/skills", icon: IconLarge.Compass },
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
    <svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
      <path
        d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z"
        fill="#1171DF"
      />
    </svg>
    <h1>Friday</h1>
  </div>

  <nav class="sidebar-nav">
    <ul class="section-list">
      {#each toolLinks as link (link.href)}
        {@const Icon = link.icon}
        <li>
          <a href={link.href} class="nav-item" class:active={isToolActive(link.href)}>
            <Icon />
            {link.label}
          </a>
        </li>
      {/each}
    </ul>

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
            <button class="nav-item as-button" onclick={() => addDialogOpen.set(true)}>
              <IconLarge.OpenSquare />
              Add Space
            </button>
          </li>
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  </nav>

  <div class="footer">
    <a href="https://platform.hellofriday.ai/docs" target="_blank">Docs</a>

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
          <p>Daemon unreachable. Start it with:</p>
          <code>deno task atlas daemon start --detached</code>
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
    border-inline-end: 1px solid var(--surface);
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
    padding-inline: var(--size-1);
    padding-block-end: var(--size-2);

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

    .text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      text-wrap: nowrap;
    }

    &.active {
      background-color: var(--surface);
      color: var(--text-bright);

      :global(svg) {
        opacity: 1;
      }

      @media (prefers-color-scheme: light) {
        background-color: color-mix(in srgb, black 5%, transparent);
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

  .as-button {
    align-items: center;
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    cursor: pointer;
    display: flex;
    inline-size: 100%;
    outline: none;
    padding-inline: var(--size-2-5) var(--size-2);
    position: relative;

    :global(svg) {
      opacity: 0.4;

      @media (prefers-color-scheme: light) {
        opacity: 0.6;
      }
    }
  }

  /* --- Sub-nav (matches web-client .sub-nav) --- */

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

    code {
      background-color: var(--color-surface-1);
      border-radius: var(--radius-1);
      color: var(--color-text);
      display: block;
      font-size: var(--font-size-1);
      padding: var(--size-1) var(--size-2);
    }
  }
</style>

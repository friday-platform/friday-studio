<script lang="ts">
  import { Collapsible, IconSmall } from "@atlas/ui";
  import { page } from "$app/state";

  const pathname = $derived(page.url.pathname);

  type NavItem = { label: string; href: string; disabled?: boolean };

  const agentLinks: NavItem[] = [
    { label: "Friday", href: "/agents/bundled" },
    { label: "Custom", href: "/agents/custom" },
  ];

  const workspaceLinks: NavItem[] = [
    { label: "Inspector", href: "/workspaces" },
    { label: "History", href: "/workspaces/history" },
  ];
</script>

<nav class="sidebar">
  <header class="sidebar-header">
    <svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
      <path
        d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z"
        fill="#1171DF"
      />
    </svg>
    <h1>Friday DevTools</h1>
  </header>

  <div class="sidebar-nav">
    <Collapsible.Root defaultOpen={true}>
      <Collapsible.Trigger size="grow">
        {#snippet children(open)}
          <span class="section-trigger">
            {#if open}
              <IconSmall.CaretDown />
            {:else}
              <IconSmall.CaretRight />
            {/if}
            <span class="section-label">Agents</span>
          </span>
        {/snippet}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ul class="nav-list">
          {#each agentLinks as link (link.href)}
            <li>
              <a
                href={link.disabled ? undefined : link.href}
                class="nav-item"
                class:active={pathname.startsWith(link.href)}
                class:disabled={link.disabled}
                aria-current={pathname.startsWith(link.href) ? "page" : undefined}
              >
                {link.label}
              </a>
            </li>
          {/each}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>

    <Collapsible.Root defaultOpen={true}>
      <Collapsible.Trigger size="grow">
        {#snippet children(open)}
          <span class="section-trigger">
            {#if open}
              <IconSmall.CaretDown />
            {:else}
              <IconSmall.CaretRight />
            {/if}
            <span class="section-label">Workspaces</span>
          </span>
        {/snippet}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ul class="nav-list">
          {#each workspaceLinks as link (link.href)}
            <li>
              <a
                href={link.disabled ? undefined : link.href}
                class="nav-item"
                class:active={pathname.startsWith(link.href)}
                class:disabled={link.disabled}
                aria-current={pathname.startsWith(link.href) ? "page" : undefined}
              >
                {link.label}
              </a>
            </li>
          {/each}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  </div>
</nav>

<style>
  .sidebar {
    background-color: var(--color-surface-1);
    border-inline-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar-header {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    padding-block: var(--size-4);
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

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    overflow-y: auto;
    padding-block: var(--size-3);
    padding-inline: var(--size-3);
  }

  .section-trigger {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    letter-spacing: var(--font-letterspacing-2);
    padding-block: var(--size-1);
    padding-inline: var(--size-1);
    text-transform: uppercase;
  }

  .section-label {
    /* Inherits from .section-trigger */
  }

  .nav-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  .nav-item {
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    display: block;
    font-size: var(--font-size-2);
    padding-block: var(--size-1-5);
    padding-inline-start: var(--size-7);
    padding-inline-end: var(--size-3);
    transition: background-color 100ms ease;
  }

  .nav-item:hover:not(.disabled) {
    background-color: var(--color-highlight-1);
  }

  .nav-item.active {
    background-color: var(--color-highlight-1);
    color: var(--color-text);
    font-weight: var(--font-weight-5);
  }

  .nav-item.disabled {
    color: color-mix(in srgb, var(--color-text), transparent 70%);
    cursor: default;
    pointer-events: none;
  }
</style>

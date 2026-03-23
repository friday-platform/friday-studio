<!--
  Workspace breadcrumb — linked navigation showing workspace name and optional section.
  Fetches workspace metadata via shared TanStack Query cache.

  @component
-->

<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { getDaemonClient } from "$lib/daemon-client";
  import { useWorkspaceConfig } from "$lib/queries/workspace-config";

  interface Props {
    workspaceId: string;
    section?: string;
  }

  const { workspaceId, section }: Props = $props();

  const COLORS: Record<string, string> = {
    yellow: "var(--yellow-2, #facc15)",
    purple: "var(--purple-2, #a78bfa)",
    red: "var(--red-2, #f87171)",
    blue: "var(--blue-2, #60a5fa)",
    green: "var(--green-2, #4ade80)",
    brown: "var(--brown-2, #a3824a)",
  };

  const daemonClient = getDaemonClient();
  const workspacesQuery = createQuery(() => ({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const res = await daemonClient.workspace.index.$get();
      if (!res.ok) throw new Error(`Failed to fetch workspaces: ${res.status}`);
      return res.json();
    },
  }));

  const workspace = $derived(
    (workspacesQuery.data ?? []).find((w) => w.id === workspaceId),
  );
  const configQuery = useWorkspaceConfig(() => workspaceId);
  const configTitle = $derived(
    (configQuery.data?.config?.workspace as Record<string, unknown> | undefined)?.name as string | undefined,
  );
  const workspaceName = $derived(configTitle ?? workspace?.name ?? workspaceId);
  const workspaceColor = $derived(
    COLORS[workspace?.metadata?.color ?? "yellow"] ?? COLORS["yellow"],
  );

  const sectionSlug = $derived(section?.toLowerCase());
  const sectionPath = $derived(
    sectionSlug ? `/platform/${workspaceId}/${sectionSlug}` : null,
  );
  // `<` always goes one level up: if we're deeper than the section page, go to section; otherwise go to workspace
  const backHref = $derived.by(() => {
    if (!sectionPath) return `/platform/${workspaceId}`;
    const currentPath = page.url.pathname;
    // If current path is longer than the section path, we're on a detail page — go to section
    if (currentPath.length > sectionPath.length && currentPath.startsWith(sectionPath)) {
      return sectionPath;
    }
    // Otherwise we're on the section page itself — go to workspace
    return `/platform/${workspaceId}`;
  });
</script>

<nav class="breadcrumb-bar">
  <a class="caret-link" href={backHref}>
    <svg class="caret" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.24976 10.75L6.74976 8.25L9.24976 5.75" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
    </svg>
  </a>
  <a class="crumb workspace" href="/platform/{workspaceId}">
    <span class="breadcrumb-dot" style:color={workspaceColor}><span></span></span>
    {workspaceName}
  </a>
  {#if section && sectionSlug}
    <span class="separator">•</span>
    <a class="crumb section" href="/platform/{workspaceId}/{sectionSlug}">
      {section}
    </a>
  {/if}
</nav>

<style>
  .breadcrumb-bar {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    margin-inline-start: calc(-1 * var(--size-1));
  }

  .caret-link {
    align-items: center;
    border-radius: var(--radius-2);
    display: flex;
    padding: var(--size-0-5);
    transition: background-color 150ms ease;
  }

  .caret-link:hover {
    background-color: var(--color-surface-2);
  }

  .caret {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
  }

  .crumb {
    align-items: center;
    border-radius: var(--radius-2);
    color: var(--color-text);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    padding: var(--size-0-5) var(--size-1-5);
    text-decoration: none;
    transition: background-color 150ms ease;
  }

  .crumb:hover {
    background-color: var(--color-surface-2);
  }

  .crumb.workspace {
    font-weight: var(--font-weight-5);
  }

  .crumb.section {
    font-weight: var(--font-weight-5);
  }

  .separator {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .breadcrumb-dot {
    align-items: center;
    display: flex;
    justify-content: center;

    span {
      background-color: currentColor;
      block-size: 11px;
      border: var(--size-0-5) solid var(--color-white);
      border-radius: var(--radius-round);
      box-shadow: var(--shadow-1);
      inline-size: 11px;
    }
  }
</style>

<script lang="ts">
  import { NotificationPortal } from "@atlas/ui";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import "@atlas/ui/tokens.css";
  import "@atlas/ui/colors.css";
  import "../app.css";
  import favicon from "$lib/assets/favicon.png";
  import CascadeStatusBanner from "$lib/components/shared/cascade-status-banner.svelte";
  import Sidebar from "$lib/components/shared/sidebar.svelte";
  import CommandPalette from "$lib/components/shared/command-palette.svelte";
  import ElicitationGlobalStream from "$lib/components/shared/elicitation-global-stream.svelte";
  import UpdateBanner from "$lib/components/shared/update-banner.svelte";
  import { startHealthPolling } from "$lib/daemon-health.svelte";
  import { loadUpdateStatus } from "$lib/update-status.svelte";

  const { children } = $props();

  // Routes that opt out of the playground app shell (sidebar, palette, etc.)
  // and render their children directly. Two consumers today:
  //   - `/export/preview`     — packaged into standalone HTML, no live UI.
  //   - `/table/[artifactId]` — dedicated full-screen tabular artifact
  //     viewer, opened in a new tab. The sidebar + workspace chrome
  //     would just compete with the table for horizontal space.
  const isChromeless = $derived(
    page.route.id?.endsWith("/export/preview") === true ||
      page.route.id?.startsWith("/table/") === true,
  );

  if (browser) {
    void loadUpdateStatus();
  }

  onMount(() => startHealthPolling());

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: browser, refetchOnReconnect: true } },
  });

  let paletteOpen = $state(false);
  let paletteMode = $state<"chat" | "switcher">("chat");

  /**
   * Bare `/` opens chat mode. Cmd/Ctrl+/ opens switcher mode.
   * Bare `/` is suppressed while typing in inputs/textareas/contenteditables;
   * the modified form is allowed to fire from anywhere.
   */
  function handleGlobalKeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      paletteMode = "chat";
      paletteOpen = true;
      return;
    }
    if (e.key === "/" && (e.metaKey || e.ctrlKey) && !e.altKey) {
      // Cmd/Ctrl+/ is a default keymap inside code editors (e.g., CodeMirror toggle-comment).
      if (t?.isContentEditable) return;
      e.preventDefault();
      paletteMode = "switcher";
      paletteOpen = true;
      return;
    }
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (t) {
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
    }
    e.preventDefault();
    paletteMode = "chat";
    paletteOpen = true;
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<svelte:head>
  <title>Friday Studio</title>
  {#if !isChromeless}
    <!--
      The chromeless export-preview omits the favicon link entirely; the
      export orchestrator post-processes the rendered HTML and injects a
      data: URL favicon directly into <head>. A relative `favicon.png`
      sibling-file approach worked, but Chrome treats every file:// URL
      as a unique security origin, so loading the icon from the page
      logs a cross-origin warning to the console. Inlining as a data:
      URL keeps the icon and removes the warning.
    -->
    <link rel="icon" href={favicon} sizes="32x32" />
  {/if}
</svelte:head>

{#if isChromeless}
  {@render children?.()}
{:else}
  <QueryClientProvider client={queryClient}>
    <div class="app-root">
      <UpdateBanner />
      <CascadeStatusBanner />
      <ElicitationGlobalStream {queryClient} />
      <div class="app-shell">
        <Sidebar />
        <main>
          <div class="app-content">
            {@render children?.()}
          </div>
        </main>
      </div>

      {#if paletteOpen}
        <CommandPalette initialMode={paletteMode} onclose={() => (paletteOpen = false)} />
      {/if}
    </div>
  </QueryClientProvider>

  <NotificationPortal />
{/if}

<style>
  .app-root {
    background-color: var(--surface-dark);
    block-size: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .app-shell {
    background-color: var(--surface-dark);
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: var(--size-56) 1fr;
    min-block-size: 0;
    overflow: hidden;

    @media (min-width: 1920px) {
      grid-template-columns: var(--size-72) 1fr;
    }
  }

  main {
    display: flex;
    flex-direction: column;
    flex: 1 1 100%;
    overflow: hidden;
    padding: var(--size-1-5);
  }

  .app-content {
    background-color: var(--surface);
    border-radius: var(--radius-7);
    min-block-size: 100%;
    min-inline-size: 0;
    overflow: auto;
    scrollbar-width: thin;
  }
</style>

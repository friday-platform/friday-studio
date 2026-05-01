<script lang="ts">
  import { NotificationPortal } from "@atlas/ui";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { browser } from "$app/environment";
  import "@atlas/ui/tokens.css";
  import "@atlas/ui/colors.css";
  import "@atlas/ui/markdown.css";
  import "../app.css";
  import favicon from "$lib/assets/favicon.png";
  import Sidebar from "$lib/components/shared/sidebar.svelte";
  import CommandPalette from "$lib/components/shared/command-palette.svelte";
  import UpdateBanner from "$lib/components/shared/update-banner.svelte";
  import { startHealthPolling } from "$lib/daemon-health.svelte";
  import { loadUpdateStatus } from "$lib/update-status.svelte";

  const { children } = $props();

  if (browser) {
    startHealthPolling();
    void loadUpdateStatus();
  }

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
  <link rel="icon" href={favicon} sizes="32x32" />
</svelte:head>

<QueryClientProvider client={queryClient}>
  <div class="app-root">
    <UpdateBanner />
    <div class="app-shell">
      <Sidebar />
      <main>
        <div class="app-content">
          {@render children?.()}
        </div>
      </main>
    </div>
  </div>

  {#if paletteOpen}
    <CommandPalette initialMode={paletteMode} onclose={() => (paletteOpen = false)} />
  {/if}
</QueryClientProvider>

<NotificationPortal />

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

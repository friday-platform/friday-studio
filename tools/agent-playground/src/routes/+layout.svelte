<script lang="ts">
  import { NotificationPortal } from "@atlas/ui";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { browser } from "$app/environment";
  import "@atlas/ui/tokens.css";
  import "@atlas/ui/colors.css";
  import "@atlas/ui/markdown.css";
  import "../app.css";
  import favicon from "$lib/assets/favicon.png";
  import Cheatsheet from "$lib/components/shared/cheatsheet.svelte";
  import Sidebar from "$lib/components/shared/sidebar.svelte";
  import { startHealthPolling } from "$lib/daemon-health.svelte";

  const { children } = $props();

  let cheatsheetOpen = $state(false);

  if (browser) startHealthPolling();

  function handleGlobalKeydown(e: KeyboardEvent) {
    // Shift+? (which is Shift+/ on US keyboards, but key === "?" regardless)
    if (e.key === "?" && e.shiftKey) {
      // Don't trigger when typing in inputs/textareas
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (target.isContentEditable) return;
      e.preventDefault();
      cheatsheetOpen = !cheatsheetOpen;
    }
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: browser, refetchOnReconnect: true } },
  });
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<svelte:head>
  <title>Friday Studio</title>
  <link rel="icon" href={favicon} sizes="32x32" />
</svelte:head>

<QueryClientProvider client={queryClient}>
  <div class="app-shell">
    <Sidebar />
    <main>
      <div class="app-content">
        {@render children?.()}
      </div>
    </main>
  </div>
</QueryClientProvider>

{#if cheatsheetOpen}
  <Cheatsheet
    onclose={() => {
      cheatsheetOpen = false;
    }}
  />
{/if}

<NotificationPortal />

<style>
  .app-shell {
    background-color: var(--surface-dark);
    block-size: 100dvh;
    display: grid;
    grid-template-columns: var(--size-56) 1fr;
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

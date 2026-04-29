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
  import { startHealthPolling } from "$lib/daemon-health.svelte";

  const { children } = $props();

  if (browser) startHealthPolling();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: browser, refetchOnReconnect: true } },
  });
</script>

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

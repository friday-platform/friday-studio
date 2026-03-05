<script lang="ts">
  import "@atlas/ui/tokens.css";
  import "../app.css";
  import Sidebar from "$lib/components/sidebar.svelte";

  const { children } = $props();
</script>

<svelte:head>
  <title>Friday DevTools</title>
</svelte:head>

<div class="app-shell">
  <Sidebar />
  <main class="app-content">
    {@render children?.()}
  </main>
</div>

<style>
  .app-shell {
    block-size: 100dvh;
    display: grid;
    grid-template-columns: 240px 1fr;
    overflow: hidden;
  }

  .app-content {
    min-inline-size: 0;
    overflow: hidden;
  }
</style>

<script lang="ts">
  import "../app.css";
  import { setAppContext } from "$lib/app-context.svelte";
  import appleTouchIcon from "$lib/assets/apple-touch-icon.png";
  import favicon from "$lib/assets/favicon.png";
  import FindBar from "$lib/components/find-bar.svelte";
  import { onMount } from "svelte";

  const { children } = $props();
  setAppContext();

  let showFindBar = $state(false);

  onMount(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        showFindBar = true;
      }
    };

    document.addEventListener("keydown", handleKeydown);

    return () => {
      document.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

{@render children?.()}

<FindBar bind:open={showFindBar} onClose={() => (showFindBar = false)} />

<svelte:head>
  <title>Friday</title>

  <link rel="apple-touch-icon" href={appleTouchIcon} />
  <link rel="icon" href={favicon} sizes="32x32" />
</svelte:head>

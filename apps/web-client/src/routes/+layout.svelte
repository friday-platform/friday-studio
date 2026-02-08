<script lang="ts">
  import "../app.css";
  import { goto } from "$app/navigation";
  import { setAppContext } from "$lib/app-context.svelte";
  import appleTouchIcon from "$lib/assets/apple-touch-icon.png";
  import favicon from "$lib/assets/favicon.png";
  import FindBar from "$lib/components/find-bar.svelte";
  import { initTauri, listen, Webview, Window } from "$lib/utils/tauri-loader";
  import { onMount } from "svelte";

  const { children } = $props();
  const ctx = setAppContext();

  let showFindBar = $state(false);

  async function openSubWindow() {
    if (!Window || !Webview) return;

    try {
      const appWindow = new Window("uniqueLabel", {
        width: 300,
        height: 200,
        resizable: false,
        minimizable: false,
        maximizable: false,
        title: "",
      });

      appWindow.once("tauri://created", async () => {
        // Re-check inside async callback since TypeScript can't track the outer check
        if (!Webview) return;

        const webview = new Webview(appWindow, "theUniqueLabel", {
          url: `${ctx.routes.main}about`,
          x: 0,
          y: 0,
          width: 300,
          height: 200,
        });

        webview.once("tauri://created", () => {});
        webview.once("tauri://error", (e) => {
          console.error("Error creating sub-window:", e);
        });
      });

      appWindow.once("tauri://error", (e) => {
        console.error("Error creating sub-window:", e);
      });
    } catch (error) {
      console.error("Failed to create sub-window:", error);
    }
  }

  onMount(() => {
    // Setup Tauri event listeners for desktop builds
    let unlistenAbout: (() => void) | undefined;
    let unlistenSettings: (() => void) | undefined;
    let unlistenFind: (() => void) | undefined;

    // Initialize Tauri APIs and setup listeners
    (async () => {
      // Initialize Tauri APIs first - prevents TDZ errors during navigation
      await initTauri();

      if (listen) {
        try {
          unlistenAbout = await listen("show-about-dialog", async () => {
            openSubWindow();
          });
          unlistenSettings = await listen("show-settings-dialog", () => {
            goto(ctx.routes.settings);
          });
          unlistenFind = await listen("show-find", () => {
            showFindBar = true;
          });
        } catch {
          // Failed to setup listeners
        }
      }
    })();

    return () => {
      unlistenAbout?.();
      unlistenSettings?.();
      unlistenFind?.();
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

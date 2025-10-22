<script lang="ts">
import { Webview } from "@tauri-apps/api/webview";
import { Window } from "@tauri-apps/api/window";
import "../app.css";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { setAppContext } from "$lib/app-context.svelte";
import { setChatContext } from "$lib/chat-context.svelte";
import DiagnosticsDialog from "$lib/components/diagnostics-dialog.svelte";

const { children } = $props();
const ctx = setAppContext();
setChatContext();

let showDiagnosticsDialog = $state(false);

async function openSubWindow() {
  const appWindow = new Window("uniqueLabel", {
    width: 300,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "",
  });

  appWindow.once("tauri://created", async () => {
    const webview = new Webview(appWindow, "theUniqueLabel", {
      // Unique label
      url: "/about", // Path to your HTML file
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });

    // Optional: Handle window creation events
    webview.once("tauri://created", () => {});

    webview.once("tauri://error", (e) => {
      console.error("Error creating sub-window:", e);
    });
  });

  appWindow.once("tauri://error", (e) => {
    console.error("Error creating sub-window:", e);
  });
}

onMount(() => {
  // Listen for dialog events from Tauri
  let unlistenAbout: (() => void) | undefined;
  let unlistenDiagnostics: (() => void) | undefined;
  let unlistenSettings: (() => void) | undefined;

  async function setupDialogListeners() {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenAbout = await listen("show-about-dialog", async () => {
        openSubWindow();
      });
      unlistenDiagnostics = await listen("show-diagnostics-dialog", () => {
        showDiagnosticsDialog = true;
      });
      unlistenSettings = await listen("show-settings-dialog", () => {
        ctx.sidebarExpanded = true;
        goto(ctx.routes.settings);
      });
    } catch {
      // Not in Tauri context
    }
  }
  setupDialogListeners();

  return () => {
    unlistenAbout?.();
    unlistenDiagnostics?.();
    unlistenSettings?.();
  };
});
</script>

{@render children?.()}

<DiagnosticsDialog bind:open={showDiagnosticsDialog} />

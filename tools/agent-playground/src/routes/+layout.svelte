<script lang="ts">
  import { notInTextField, NotificationPortal, setDragDropContext, setHotkeyRegistry } from "@atlas/ui";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import "@atlas/ui/reset.css";
  import "@atlas/ui/tokens.css";
  import "@atlas/ui/colors.css";
  import "@atlas/ui/utilities.css";
  import "../app.css";
  import { getOnboardingState } from "$lib/api/me.ts";
  import favicon from "$lib/assets/favicon.png";
  import CascadeStatusBanner from "$lib/components/shared/cascade-status-banner.svelte";
  import Sidebar from "$lib/components/shared/sidebar.svelte";
  import CommandPalette from "$lib/components/shared/command-palette.svelte";
  import ElicitationGlobalStream from "$lib/components/shared/elicitation-global-stream.svelte";
  import UpdateBanner from "$lib/components/shared/update-banner.svelte";
  import { startHealthPolling } from "$lib/daemon-health.svelte";
  import { loadUpdateStatus } from "$lib/update-status.svelte";

  const { children } = $props();

  const hotkeys = setHotkeyRegistry();
  setDragDropContext();

  // Routes that opt out of the playground app shell (sidebar, palette, etc.)
  // and render their children directly. Two consumers today:
  //   - `/welcome` — first-run onboarding wizard; lives outside the
  //     shell so the user can land identity fields before the rest of
  //     the UI tries to render.
  //   - `/artifacts/[id]` and subpaths — dedicated artifact viewers
  //     opened in a new tab. The dispatcher + per-renderer subpaths
  //     (`./table` today, `./raw` / `./diff` etc. later) all opt out
  //     of the workspace chrome so the artifact gets the full viewport.
  const isChromeless = $derived(
    page.route.id === "/welcome" ||
      page.route.id?.startsWith("/artifacts/") === true,
  );

  // First-load onboarding gate. The daemon exposes
  // `GET /api/me/onboarding` returning `{completed, requiredFields,
  // missingRequired, version}`. If onboarding isn't complete OR any
  // required field is missing, redirect to `/welcome`. We deliberately
  // skip the gate when the user is already on `/welcome` to avoid a
  // redirect loop. The gate runs once on app boot — the wizard's
  // submit handler redirects back to `/` after `completeOnboarding`.
  let onboardingChecked = $state(false);

  async function checkOnboardingGate() {
    if (onboardingChecked) return;
    if (page.route.id === "/welcome") {
      onboardingChecked = true;
      return;
    }
    try {
      const state = await getOnboardingState();
      const needsWizard = !state.completed || state.missingRequired.length > 0;
      onboardingChecked = true;
      if (needsWizard) {
        await goto("/welcome");
      }
    } catch {
      // Soft-fail: a 503 or network error shouldn't block the user
      // from using the playground. The gate fires on next boot once
      // the daemon responds. Local dev with a stopped daemon hits
      // this path constantly.
      onboardingChecked = true;
    }
  }

  if (browser) {
    void loadUpdateStatus();
    void checkOnboardingGate();
  }

  onMount(() => startHealthPolling());

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: browser, refetchOnReconnect: true } },
  });

  let paletteOpen = $state(false);
  let paletteMode = $state<"chat" | "switcher">("chat");

  // ⌘K / Ctrl+K opens the chat palette. Allowed everywhere — the
  // command palette is a high-priority surface and we want it
  // reachable from any focus state.
  $effect(() => hotkeys.register({
    key: "k", cmdOrCtrl: true,
    handler: () => {
      paletteMode = "chat";
      paletteOpen = true;
    },
  }));

  // ⌘/ / Ctrl+/ opens the workspace switcher palette. Suppressed only
  // inside contentEditable surfaces — Cmd+/ is the default
  // toggle-comment keymap in CodeMirror and we don't want to steal it.
  $effect(() => hotkeys.register({
    key: "/", cmdOrCtrl: true,
    when: (e) => !(e.target instanceof HTMLElement && e.target.isContentEditable),
    handler: () => {
      paletteMode = "switcher";
      paletteOpen = true;
    },
  }));

  // Bare `/` opens the chat palette. Suppressed while typing in any
  // text field — otherwise you couldn't type `/` into a message.
  $effect(() => hotkeys.register({
    key: "/",
    when: notInTextField,
    handler: () => {
      paletteMode = "chat";
      paletteOpen = true;
    },
  }));
</script>

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

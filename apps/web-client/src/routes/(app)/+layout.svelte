<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { getAppContext } from "$lib/app-context.svelte";
  import AppContainer from "$lib/components/app/container.svelte";
  import AppSidebar from "$lib/components/app/sidebar.svelte";
  import KeyboardListener from "$lib/components/keyboard-listener.svelte";
  import NotificationPortal from "$lib/components/notification/portal.svelte";
  import { setClientContext } from "$lib/modules/client/context.svelte";
  import WorkspaceDropHandler from "$lib/modules/spaces/workspace-drop-handler.svelte";
  import { onDestroy, onMount } from "svelte";

  const { data, children } = $props();

  const isNewChat = $derived(page.route.id === "/(app)/chat/[[chatId]]" && !page.params.chatId);

  const appCtx = getAppContext();
  const ctx = setClientContext();
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: browser } } });

  let unlisten: (() => void) | undefined;

  onMount(async () => {
    appCtx.user = data.user;

    // Set GA4 user_id for cross-platform analytics (joins with friday_analytics)
    if (data.user?.id && !__DEV_MODE__ && window.gtag) {
      window.gtag("set", { user_id: data.user.id });
    }

    // Start health checks immediately
    ctx.checkHealth();

    // Ensure periodic health checks are running for auto-reconnect
    ctx.startHealthCheckInterval();

    // Setup drag and drop for staged files in desktop builds
    // Note: Workspace file drops (.yml/.yaml) are handled by WorkspaceDropHandler
    if (__TAURI_BUILD__) {
      try {
        const webview = getCurrentWebview();
        if (webview) {
          unlisten = await webview.onDragDropEvent(async (event) => {
            if (event.payload.type === "drop") {
              for (const path of event.payload.paths) {
                // Skip workspace config files - handled by WorkspaceDropHandler
                if (path.endsWith(".yml") || path.endsWith(".yaml")) {
                  continue;
                }

                const name = path.split("/").pop() || path;
                appCtx.stagedFiles.add({ name, loaded: 0, size: 0, status: "ready" });
              }
            }
          });
        }
      } catch (error) {
        console.error("Failed to setup drag and drop:", error);
      }
    }
  });

  onDestroy(() => {
    ctx.destroy();
    unlisten?.();
  });
</script>

{#if __TAURI_BUILD__}
  <div class="titlebar" data-tauri-drag-region></div>
{/if}

<QueryClientProvider client={queryClient}>
  <div role="region" class={data.color ?? "default"} class:new-chat={isNewChat}>
    <AppContainer>
      <AppSidebar />

      <main>
        <div class="app-content">
          {#if ctx.daemonStatus === "error"}
            <div class="daemon-error">
              <p>
                The connection to Friday was lost
                {#if ctx.reconnectCountdown > 0}
                  <span class="reconnect-countdown">
                    (reconnecting in {ctx.reconnectCountdown}s)
                  </span>
                {:else if ctx.reconnectCountdown === 0}
                  <span class="reconnect-countdown">(reconnecting...)</span>
                {/if}
              </p>
              <button
                type="button"
                onclick={() => {
                  trackEvent(GA4.DAEMON_RECONNECT_CLICK);
                  ctx.checkHealth();
                }}
              >
                Try again
              </button>
            </div>
          {/if}
          {@render children?.()}
        </div>
      </main>
    </AppContainer>
  </div>

  <NotificationPortal />
  <KeyboardListener />
  <WorkspaceDropHandler />
</QueryClientProvider>

<style>
  .default {
    --accent-1: var(--color-surface-2);
    --accent-2: var(--yellow-2);
    --accent-3: var(--yellow-3);
  }

  .yellow {
    --accent-1: var(--yellow-1);
    --accent-2: var(--yellow-2);
    --accent-3: var(--yellow-3);
  }

  .purple {
    --accent-1: var(--purple-1);
    --accent-2: var(--purple-2);
    --accent-3: var(--purple-3);
  }

  .red {
    --accent-1: var(--red-1);
    --accent-2: var(--red-2);
    --accent-3: var(--red-3);
  }

  .blue {
    --accent-1: var(--blue-1);
    --accent-2: var(--blue-2);
    --accent-3: var(--blue-3);
  }

  .green {
    --accent-1: var(--green-1);
    --accent-2: var(--green-2);
    --accent-3: var(--green-3);
  }

  .brown {
    --accent-1: var(--brown-1);
    --accent-2: var(--brown-2);
    --accent-3: var(--brown-3);
  }

  div[role="region"] {
    background-color: var(--color-surface-2);

    &.new-chat {
      animation-name: changeColor;
      animation-duration: 20s;
      animation-timing-function: linear;
      animation-iteration-count: infinite;
      animation-fill-mode: forwards;
    }
  }

  main {
    padding: var(--size-1-5);
  }

  .app-content {
    background-color: var(--color-surface-1);
    box-shadow: var(--shadow-canvas);
    border-radius: var(--radius-7);
    overflow: auto;
    scrollbar-width: thin;
    min-block-size: 100%;
  }

  .titlebar {
    block-size: 3.25rem;
    inset-block-start: 0;
    inset-inline: 0;
    position: absolute;
    z-index: var(--layer-4);
  }

  main {
    display: flex;
    flex-direction: column;
    flex: 1 1 100%;
    overflow: hidden;
  }

  .daemon-error {
    align-items: center;
    background-color: color-mix(in srgb, #c5634d, transparent 90%);
    block-size: var(--size-13);
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    padding-inline: var(--size-5);
    justify-content: space-between;
    position: relative;
    z-index: var(--layer-5);

    button {
      color: #c5634d;
      cursor: pointer;
      margin-inline-start: var(--size-2);

      &:hover {
        text-decoration: underline;
      }

      @media (prefers-color-scheme: dark) {
        color: color-mix(in srgb, #c5634d, #fff 65%);
      }
    }
  }

  @keyframes changeColor {
    0%,
    100% {
      --accent-2: var(--yellow-2);
    }
    16%,
    24% {
      --accent-2: var(--red-2);
    }
    32%,
    40% {
      --accent-2: var(--purple-2);
    }
    48%,
    56% {
      --accent-2: var(--blue-2);
    }
    64%,
    72% {
      --accent-2: var(--green-2);
    }
    80%,
    88% {
      --accent-2: var(--brown-2);
    }
  }
</style>

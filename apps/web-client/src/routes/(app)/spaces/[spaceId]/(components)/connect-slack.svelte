<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { invalidateAll } from "$app/navigation";
  import Button from "$lib/components/button.svelte";
  import { IconSmall } from "$lib/components/icons/small";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { z } from "zod";

  let {
    workspaceId,
    compact = false,
  }: {
    workspaceId: string;
    /** Render as a minimal "+" pill that expands on hover instead of a full button. */
    compact?: boolean;
  } = $props();

  const OAuthCallbackMessageSchema = z.object({
    type: z.literal("oauth-callback"),
    credentialId: z.string(),
    provider: z.string(),
  });

  type Step = "idle" | "connecting-org" | "installing-bot" | "wiring" | "done" | "error";
  let step = $state<Step>("idle");
  let errorMessage = $state<string | null>(null);

  let listenersActive = false;
  let pendingResolve: ((credentialId: string) => void) | null = null;

  function addListeners() {
    if (listenersActive) return;
    listenersActive = true;
    window.addEventListener("message", handleOAuthMessage);
    window.addEventListener("storage", handleStorageEvent);
  }

  function removeListeners() {
    if (!listenersActive) return;
    listenersActive = false;
    window.removeEventListener("message", handleOAuthMessage);
    window.removeEventListener("storage", handleStorageEvent);
  }

  $effect(() => {
    return () => removeListeners();
  });

  function handleOAuthMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin) return;
    const result = OAuthCallbackMessageSchema.safeParse(event.data);
    if (!result.success) return;
    pendingResolve?.(result.data.credentialId);
    pendingResolve = null;
    removeListeners();
  }

  function handleStorageEvent(event: StorageEvent) {
    if (event.key !== "oauth-callback" || !event.newValue) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.newValue);
    } catch {
      return;
    }
    const result = OAuthCallbackMessageSchema.safeParse(parsed);
    if (!result.success) return;
    localStorage.removeItem("oauth-callback");
    pendingResolve?.(result.data.credentialId);
    pendingResolve = null;
    removeListeners();
  }

  function openPopup(url: string): boolean {
    const width = 600;
    const height = 700;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
    const features = `width=${width},height=${height},left=${left},top=${top},popup=yes`;
    const popup = window.open(url, "oauth-popup", features);
    if (!popup || popup.closed) return false;
    addListeners();
    return true;
  }

  /** Wait for OAuth callback via postMessage or storage event. */
  function waitForCallback(): Promise<string> {
    return new Promise((resolve) => {
      pendingResolve = resolve;
    });
  }

  async function hasSlackUserCredential(): Promise<boolean> {
    const res = await parseResult(client.link.v1.summary.$get({ query: {} }));
    if (!res.ok) return false;
    return res.data.credentials.some((c) => c.provider === "slack-user");
  }

  async function handleConnect() {
    step = "idle";
    errorMessage = null;

    try {
      // Probe with empty body — if a slack-app is already wired (e.g. from a
      // bundled Slack agent), the server adds the chat signal directly,
      // skipping the OAuth + install round-trip.
      step = "wiring";
      const probeRes = await parseResult(
        client.workspace[":workspaceId"]["connect-slack"].$post({
          param: { workspaceId },
          json: {},
        }),
      );

      if (!probeRes.ok) {
        errorMessage = "Failed to connect Slack to workspace.";
        step = "error";
        return;
      }

      const probeData: unknown = probeRes.data;
      const installRequired =
        typeof probeData === "object" &&
        probeData !== null &&
        "installRequired" in probeData &&
        probeData.installRequired === true;
      if (!installRequired) {
        step = "done";
        toast({ title: "Slack connected" });
        await invalidateAll();
        return;
      }

      const hasSlackUser = await hasSlackUserCredential();
      if (!hasSlackUser) {
        step = "connecting-org";
        const daemonUrl = getAtlasDaemonUrl();
        const callbackUrl = new URL("/oauth/callback", window.location.origin);
        const url = new URL("/api/link/v1/oauth/authorize/slack-user", daemonUrl);
        url.searchParams.set("redirect_uri", callbackUrl.href);

        if (!openPopup(url.href)) {
          errorMessage = "Popup was blocked. Please allow popups and try again.";
          step = "error";
          return;
        }

        await waitForCallback();
      }

      step = "installing-bot";
      const daemonUrl = getAtlasDaemonUrl();
      const callbackUrl = new URL("/oauth/callback", window.location.origin);
      const url = new URL("/api/link/v1/app-install/slack-app/authorize", daemonUrl);
      url.searchParams.set("redirect_uri", callbackUrl.href);

      if (!openPopup(url.href)) {
        errorMessage = "Popup was blocked. Please allow popups and try again.";
        step = "error";
        return;
      }

      const credentialId = await waitForCallback();

      step = "wiring";
      const wireRes = await parseResult(
        client.workspace[":workspaceId"]["connect-slack"].$post({
          param: { workspaceId },
          json: { credential_id: credentialId },
        }),
      );

      if (!wireRes.ok) {
        errorMessage = "Failed to connect Slack to workspace.";
        step = "error";
        return;
      }

      step = "done";
      toast({ title: "Slack connected" });
      await invalidateAll();
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : "Something went wrong.";
      step = "error";
    }
  }

  const buttonLabel = $derived.by(() => {
    switch (step) {
      case "connecting-org":
        return "Connecting Slack org...";
      case "installing-bot":
        return "Installing bot...";
      case "wiring":
        return "Finishing setup...";
      default:
        return "Connect";
    }
  });

  const busy = $derived(
    step === "connecting-org" || step === "installing-bot" || step === "wiring",
  );
</script>

{#if compact}
  <button class="compact-connect" onclick={handleConnect} disabled={busy}>
    <span class="compact-icon"><IconSmall.Plus /></span>
    <span class="compact-label">{busy ? buttonLabel : "Connect to chat"}</span>
  </button>
  {#if errorMessage}
    <span class="error">{errorMessage}</span>
  {/if}
{:else}
  <div class="connect-slack">
    <Button size="small" variant="secondary" onclick={handleConnect} disabled={busy}>
      {buttonLabel}
    </Button>
    {#if errorMessage}
      <span class="error">{errorMessage}</span>
    {/if}
  </div>
{/if}

<style>
  .connect-slack {
    display: flex;
    align-items: center;
    gap: var(--size-2);
    margin-block-start: var(--size-2);
  }

  .error {
    color: var(--color-red);
    font-size: var(--font-size-1);
  }

  .compact-connect {
    align-items: center;
    background: var(--accent-1);
    block-size: var(--size-5);
    border: none;
    border-radius: var(--radius-round);
    color: var(--color-text);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    overflow: hidden;
    padding-inline: var(--size-1-5);
    transition:
      background-color 150ms ease,
      padding 200ms ease;
    white-space: nowrap;

    &:hover:not(:disabled) {
      background: var(--accent-2);
      padding-inline-end: var(--size-2-5);
    }

    &:disabled {
      opacity: 0.6;
      padding-inline-end: var(--size-2-5);
    }
  }

  .compact-icon {
    align-items: center;
    display: inline-flex;
    flex-shrink: 0;
    justify-content: center;
  }

  .compact-label {
    max-inline-size: 0;
    overflow: hidden;
    transition: max-inline-size 200ms ease;

    .compact-connect:hover:not(:disabled) &,
    .compact-connect:disabled & {
      max-inline-size: 10rem;
    }
  }
</style>

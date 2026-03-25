import { z } from "zod";
import { DAEMON_BASE_URL } from "./daemon-url.ts";

/** Schema for OAuth callback message from popup window. */
export const OAuthCallbackMessageSchema = z.object({
  type: z.literal("oauth-callback"),
  credentialId: z.string(),
  provider: z.string(),
});

export type OAuthCallbackMessage = z.infer<typeof OAuthCallbackMessageSchema>;

/**
 * Opens a centered popup window for OAuth authorization.
 * Points at the daemon's OAuth authorize endpoint with a redirect_uri
 * back to the playground's `/oauth/callback` route.
 *
 * @returns The popup window reference, or `null` if blocked by the browser.
 */
export function startOAuthFlow(provider: string): Window | null {
  const callbackUrl = new URL("/oauth/callback", globalThis.location.origin);
  const url = new URL(`/api/link/v1/oauth/authorize/${provider}`, DAEMON_BASE_URL);
  url.searchParams.set("redirect_uri", callbackUrl.href);

  return openCenteredPopup(url.href);
}

/**
 * Opens a centered popup window for OAuth app installation.
 * Points at the daemon's app-install authorize endpoint with a redirect_uri
 * back to the playground's `/oauth/callback` route.
 *
 * @returns The popup window reference, or `null` if blocked by the browser.
 */
export function startAppInstallFlow(provider: string): Window | null {
  const callbackUrl = new URL("/oauth/callback", globalThis.location.origin);
  const url = new URL(`/api/link/v1/app-install/${provider}/authorize`, DAEMON_BASE_URL);
  url.searchParams.set("redirect_uri", callbackUrl.href);

  return openCenteredPopup(url.href);
}

/**
 * Adds postMessage and localStorage listeners for OAuth callback messages.
 * Returns a cleanup function to remove both listeners.
 *
 * @param onSuccess - Called when a valid OAuth callback message is received.
 * @param providerFilter - If provided, only handles messages for this provider.
 */
export function listenForOAuthCallback(
  onSuccess: (message: OAuthCallbackMessage) => void,
  providerFilter?: string,
): () => void {
  function handleMessage(event: MessageEvent) {
    if (event.origin !== globalThis.location.origin) return;

    const result = OAuthCallbackMessageSchema.safeParse(event.data);
    if (!result.success) return;
    if (providerFilter && result.data.provider !== providerFilter) return;

    onSuccess(result.data);
  }

  function handleStorage(event: StorageEvent) {
    if (event.key !== "oauth-callback" || !event.newValue) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.newValue);
    } catch {
      return;
    }

    const result = OAuthCallbackMessageSchema.safeParse(parsed);
    if (!result.success) return;
    if (providerFilter && result.data.provider !== providerFilter) return;

    localStorage.removeItem("oauth-callback");
    onSuccess(result.data);
  }

  globalThis.addEventListener("message", handleMessage);
  globalThis.addEventListener("storage", handleStorage);

  return () => {
    globalThis.removeEventListener("message", handleMessage);
    globalThis.removeEventListener("storage", handleStorage);
  };
}

/** Opens a centered popup window. Returns `null` if blocked. */
function openCenteredPopup(url: string): Window | null {
  const width = 600;
  const height = 700;
  const left = Math.round(globalThis.screenX + (globalThis.outerWidth - width) / 2);
  const top = Math.round(globalThis.screenY + (globalThis.outerHeight - height) / 2);
  const features = `width=${width},height=${height},left=${left},top=${top},popup=yes`;

  const popup = globalThis.open(url, "oauth-popup", features);

  if (!popup || popup.closed) return null;
  return popup;
}

/**
 * Reactive credential connection primitives.
 *
 * Encapsulates OAuth popup management, app-install popup, API-key PUT submission,
 * callback listener lifecycle, and fallback redirect URL computation.
 *
 * Both chat connect-service cards and MCP detail panels consume this rune.
 * Each call returns an isolated state instance.
 *
 * @module
 */

import {
  getAppInstallUrl,
  getOAuthUrl,
  listenForOAuthCallback,
  startAppInstallFlow,
  startOAuthFlow,
} from "./oauth-popup.ts";

interface CredentialConnectState {
  popupBlocked: boolean;
  blockedUrl: string | null;
  submitting: boolean;
  error: string | null;
}

/**
 * Returns reactive state and action functions for connecting a credential
 * for the given provider.
 *
 * @param providerId - The provider identifier (e.g. "openai", "slack-app")
 */
export function useCredentialConnect(providerId: string) {
  // Per-instance reactive state
  // deno-lint-ignore prefer-const
  let state: CredentialConnectState = $state({
    popupBlocked: false,
    blockedUrl: null,
    submitting: false,
    error: null,
  });

  let cleanup: (() => void) | undefined;

  function reset() {
    state.popupBlocked = false;
    state.blockedUrl = null;
    state.error = null;
  }

  function startOAuth() {
    reset();
    const popup = startOAuthFlow(providerId);
    if (!popup || popup.closed) {
      state.popupBlocked = true;
      state.blockedUrl = getOAuthUrl(providerId);
    }
  }

  function startAppInstall() {
    reset();
    const popup = startAppInstallFlow(providerId);
    if (!popup || popup.closed) {
      state.popupBlocked = true;
      state.blockedUrl = getAppInstallUrl(providerId);
    }
  }

  function listenForCallback(onSuccess: () => void) {
    cleanup = listenForOAuthCallback(() => {
      reset();
      onSuccess();
    }, providerId);

    return () => {
      cleanup?.();
      cleanup = undefined;
    };
  }

  async function submitApiKey(label: string, secret: Record<string, string>) {
    state.submitting = true;
    state.error = null;

    try {
      const res = await fetch(
        `/api/daemon/api/link/v1/credentials/apikey`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: providerId, label, secret }),
        },
      );

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg =
          typeof body === "object" &&
            body !== null &&
            "message" in body &&
            typeof (body as { message: unknown }).message === "string"
            ? (body as { message: string }).message
            : `HTTP ${res.status}`;
        state.error = msg;
        return;
      }

      reset();
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.submitting = false;
    }
  }

  return {
    get popupBlocked() {
      return state.popupBlocked;
    },
    get blockedUrl() {
      return state.blockedUrl;
    },
    get submitting() {
      return state.submitting;
    },
    get error() {
      return state.error;
    },
    startOAuth,
    startAppInstall,
    listenForCallback,
    submitApiKey,
  };
}

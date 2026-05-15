/**
 * Reactive credential connection primitives.
 *
 * Encapsulates OAuth popup management, app-install popup, callback listener
 * lifecycle, and fallback redirect URL computation. API-key submission lives
 * separately in `queries/link-credentials.ts` (`useCreateApiKeyCredential`)
 * so it shares the tanstack-query invalidation pattern with delete/update.
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
  type OAuthCallbackMessage,
  startAppInstallFlow,
  startOAuthFlow,
} from "./oauth-popup.ts";

interface CredentialConnectState {
  popupBlocked: boolean;
  blockedUrl: string | null;
}

type ProviderIdInput = string | (() => string);

function readProviderId(providerId: ProviderIdInput): string {
  return typeof providerId === "function" ? providerId() : providerId;
}

/**
 * Returns reactive state and action functions for connecting a credential
 * for the given provider.
 *
 * @param providerId - The provider identifier (e.g. "openai", "slack"), or a getter for reactive props.
 */
export function useCredentialConnect(providerId: ProviderIdInput) {
  // Per-instance reactive state
  // deno-lint-ignore prefer-const
  let state: CredentialConnectState = $state({
    popupBlocked: false,
    blockedUrl: null,
  });

  let cleanup: (() => void) | undefined;

  function reset() {
    state.popupBlocked = false;
    state.blockedUrl = null;
  }

  function startOAuth() {
    reset();
    const currentProviderId = readProviderId(providerId);
    const popup = startOAuthFlow(currentProviderId);
    if (!popup || popup.closed) {
      state.popupBlocked = true;
      state.blockedUrl = getOAuthUrl(currentProviderId);
    }
  }

  function startAppInstall() {
    reset();
    const currentProviderId = readProviderId(providerId);
    const popup = startAppInstallFlow(currentProviderId);
    if (!popup || popup.closed) {
      state.popupBlocked = true;
      state.blockedUrl = getAppInstallUrl(currentProviderId);
    }
  }

  function listenForCallback(onSuccess: (message: OAuthCallbackMessage) => void) {
    cleanup = listenForOAuthCallback((message) => {
      reset();
      onSuccess(message);
    }, readProviderId(providerId));

    return () => {
      cleanup?.();
      cleanup = undefined;
    };
  }

  return {
    get popupBlocked() {
      return state.popupBlocked;
    },
    get blockedUrl() {
      return state.blockedUrl;
    },
    startOAuth,
    startAppInstall,
    listenForCallback,
  };
}

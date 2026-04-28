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

import { z } from "zod";
import {
  getAppInstallUrl,
  getOAuthUrl,
  listenForOAuthCallback,
  type OAuthCallbackMessage,
  startAppInstallFlow,
  startOAuthFlow,
} from "./oauth-popup.ts";

/**
 * Subset of the `PUT /v1/credentials/apikey` response we rely on. Link
 * returns more fields (`label`, `displayName`); we only parse the id since
 * that is the only thing downstream wiring needs.
 */
const ApiKeyCreateResponseSchema = z.object({ id: z.string().min(1) });

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

  function listenForCallback(onSuccess: (message: OAuthCallbackMessage) => void) {
    cleanup = listenForOAuthCallback((message) => {
      reset();
      onSuccess(message);
    }, providerId);

    return () => {
      cleanup?.();
      cleanup = undefined;
    };
  }

  /**
   * PUT /v1/credentials/apikey — creates an apikey credential under the
   * current provider. Returns the new credential id on success, `null` on
   * failure (with `state.error` set so the caller can surface it).
   */
  async function submitApiKey(
    label: string,
    secret: Record<string, string>,
  ): Promise<string | null> {
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
        return null;
      }

      const parsed = ApiKeyCreateResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        state.error = "Malformed response from credentials/apikey";
        return null;
      }

      reset();
      return parsed.data.id;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      return null;
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

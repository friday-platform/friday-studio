<script lang="ts">
  import { page } from "$app/stores";
  import { onMount } from "svelte";

  /**
   * OAuth callback page for popup-based app installation flow.
   * Receives credential_id and provider from URL params, posts message to opener,
   * and closes the popup window.
   */

  type CallbackStatus = "posting" | "success" | "error" | "no-opener";

  let status: CallbackStatus = $state("posting");
  let errorMessage: string | null = $state(null);

  onMount(() => {
    const params = $page.url.searchParams;
    const credentialId = params.get("credential_id");
    const provider = params.get("provider");
    const oauthError = params.get("error");
    const errorDescription = params.get("error_description");

    // Handle OAuth error from provider
    if (oauthError) {
      status = "error";
      errorMessage = errorDescription || oauthError || "Authentication failed";
      return;
    }

    // Validate required params
    if (!credentialId || !provider) {
      status = "error";
      errorMessage = "Missing credential or provider information";
      return;
    }

    const callbackData = { type: "oauth-callback" as const, credentialId, provider };

    // Try postMessage first if opener exists
    if (window.opener) {
      try {
        window.opener.postMessage(callbackData, window.location.origin);
        status = "success";
        setTimeout(() => window.close(), 100);
        return;
      } catch {
        // Fall through to localStorage fallback
      }
    }

    // Fallback: use localStorage for cross-origin popup scenarios
    // (opener can be null after navigating through external OAuth providers)
    try {
      localStorage.setItem("oauth-callback", JSON.stringify(callbackData));
      status = "success";
      setTimeout(() => window.close(), 100);
    } catch {
      // localStorage blocked - show manual close message
      status = "no-opener";
    }
  });
</script>

<div class="callback-container">
  {#if status === "posting"}
    <div class="status-box">
      <p>Completing authentication...</p>
    </div>
  {:else if status === "success"}
    <div class="status-box success">
      <p>Authentication successful!</p>
      <p class="hint">This window will close automatically.</p>
    </div>
  {:else if status === "no-opener"}
    <div class="status-box success">
      <p>Authentication successful!</p>
      <p class="hint">You can close this window and return to Friday.</p>
    </div>
  {:else if status === "error"}
    <div class="status-box error">
      <p>Authentication failed</p>
      {#if errorMessage}
        <p class="error-detail">{errorMessage}</p>
      {/if}
      <p class="hint">You can close this window and try again.</p>
    </div>
  {/if}
</div>

<style>
  .callback-container {
    align-items: center;
    background-color: var(--color-surface-1);
    display: flex;
    justify-content: center;
    min-block-size: 100vh;
    padding: var(--size-4);
  }

  .status-box {
    background-color: var(--color-surface-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-4);
    max-inline-size: 400px;
    padding: var(--size-6);
    text-align: center;
  }

  .status-box p {
    font-size: var(--font-size-3);
    margin: 0;
  }

  .status-box p + p {
    margin-block-start: var(--size-2);
  }

  .hint {
    font-size: var(--font-size-2);
    opacity: 0.7;
  }

  .error p:first-child {
    color: var(--color-red);
    font-weight: var(--font-weight-5);
  }

  .error-detail {
    font-size: var(--font-size-2);
    opacity: 0.8;
  }
</style>

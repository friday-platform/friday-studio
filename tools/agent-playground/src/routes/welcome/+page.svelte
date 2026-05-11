<!--
  Chromeless welcome page — single-step onboarding wizard that lands
  the small set of identity fields the daemon expects.

  Gate logic lives in `+layout.svelte` (app shell): it redirects here
  when `onboarding.completed === false` OR `missingRequired.length > 0`.
  This page just collects the fields and submits.

  Skip semantics:
  - `requiredFields.length === 0` (local mode default) → Skip is visible.
    Clicking it marks onboarding complete at the current version
    without writing any profile fields.
  - `requiredFields.length > 0` (cloud / future deployments with
    enforced fields) → Skip is hidden until the form's submit
    populates the missing fields.

  Auto-detect:
  - `timezone` defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`.
  - `locale` defaults to the first entry of `navigator.languages`.
  Both are user-editable before submit.

  @component
-->

<script lang="ts">
  import { goto } from "$app/navigation";
  import { browser } from "$app/environment";
  import FridayMark from "$lib/components/shared/friday-mark.svelte";
  import {
    completeOnboarding,
    getMe,
    getOnboardingState,
    patchMe,
    type MeIdentity,
    type OnboardingState,
  } from "$lib/api/me.ts";

  let loading = $state(true);
  let submitting = $state(false);
  let error = $state<string | null>(null);

  let me = $state<MeIdentity | null>(null);
  let onboarding = $state<OnboardingState | null>(null);

  // Form fields. Initialized on mount once `me` lands; auto-detected
  // values fill in for empty server-side fields.
  let fullName = $state("");
  let email = $state("");
  let timezone = $state("");
  let locale = $state("");

  function detectTimezone(): string {
    if (!browser) return "";
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      return "";
    }
  }

  function detectLocale(): string {
    if (!browser) return "";
    if (typeof navigator === "undefined") return "";
    return navigator.languages?.[0] ?? navigator.language ?? "";
  }

  $effect(() => {
    if (!browser) return;
    void (async () => {
      try {
        const [meRes, obRes] = await Promise.all([getMe(), getOnboardingState()]);
        me = meRes;
        onboarding = obRes;
        fullName = meRes.full_name ?? "";
        email = meRes.email ?? "";
        timezone = meRes.timezone ?? detectTimezone();
        locale = meRes.locale ?? detectLocale();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        loading = false;
      }
    })();
  });

  const skipAvailable = $derived(
    onboarding !== null && onboarding.requiredFields.length === 0,
  );

  async function handleSubmit(event: Event) {
    event.preventDefault();
    submitting = true;
    error = null;
    try {
      const fields: Parameters<typeof patchMe>[0] = {};
      if (fullName.trim().length > 0) fields.full_name = fullName.trim();
      if (email.trim().length > 0) fields.email = email.trim();
      if (timezone.trim().length > 0) fields.timezone = timezone.trim();
      if (locale.trim().length > 0) fields.locale = locale.trim();

      if (Object.keys(fields).length > 0) {
        await patchMe(fields);
      }
      await completeOnboarding();
      await goto("/");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      submitting = false;
    }
  }

  async function handleSkip() {
    submitting = true;
    error = null;
    try {
      await completeOnboarding();
      await goto("/");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>Welcome to Friday</title>
</svelte:head>

<main class="welcome">
  <div class="card">
    <header class="hero">
      <FridayMark size={64} />
      <h1>Welcome to Friday</h1>
      <p class="lede">A few details so the assistant can address you correctly.</p>
    </header>

    {#if loading}
      <p class="muted">Loading…</p>
    {:else}
      <form onsubmit={handleSubmit} class="form" aria-busy={submitting}>
        <label class="field">
          <span class="label">Name</span>
          <input
            type="text"
            bind:value={fullName}
            placeholder="Your name"
            autocomplete="name"
            disabled={submitting}
          />
        </label>

        <label class="field">
          <span class="label">
            Email
            {#if onboarding?.requiredFields.includes("email")}
              <span class="required" aria-label="required">*</span>
            {/if}
          </span>
          <input
            type="email"
            bind:value={email}
            placeholder="you@example.com"
            autocomplete="email"
            required={onboarding?.requiredFields.includes("email") ?? false}
            disabled={submitting}
          />
        </label>

        <label class="field">
          <span class="label">Timezone</span>
          <input
            type="text"
            bind:value={timezone}
            placeholder="America/New_York"
            disabled={submitting}
          />
          <span class="hint">Auto-detected from your browser. IANA name.</span>
        </label>

        <label class="field">
          <span class="label">Locale</span>
          <input type="text" bind:value={locale} placeholder="en-US" disabled={submitting} />
          <span class="hint">Auto-detected from your browser. BCP-47 tag.</span>
        </label>

        {#if error}
          <p class="error" role="alert">{error}</p>
        {/if}

        <div class="actions">
          {#if skipAvailable}
            <button
              type="button"
              class="btn btn-ghost"
              onclick={handleSkip}
              disabled={submitting}
            >
              Skip for now
            </button>
          {/if}
          <button type="submit" class="btn btn-primary" disabled={submitting}>
            {submitting ? "Saving…" : "Continue"}
          </button>
        </div>
      </form>
    {/if}
  </div>
</main>

<style>
  .welcome {
    background-color: var(--surface-dark);
    color: var(--text-primary);
    block-size: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .card {
    background-color: var(--surface);
    border-radius: 12px;
    padding: 2.5rem;
    inline-size: min(28rem, 100%);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }

  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    margin-block-end: 2rem;
    text-align: center;
  }

  .hero h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0;
  }

  .lede {
    color: var(--text-secondary);
    margin: 0;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .label {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .required {
    color: var(--accent, #1171df);
    margin-inline-start: 0.25rem;
  }

  input[type="text"],
  input[type="email"] {
    padding: 0.625rem 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
    background-color: var(--surface-input, rgba(0, 0, 0, 0.2));
    color: inherit;
    font: inherit;
  }

  input:focus {
    outline: 2px solid var(--accent, #1171df);
    outline-offset: 1px;
  }

  .hint {
    color: var(--text-secondary);
    font-size: 0.75rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-block-start: 0.5rem;
  }

  .btn {
    padding: 0.625rem 1rem;
    border-radius: 6px;
    border: 1px solid transparent;
    font: inherit;
    cursor: pointer;
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background-color: var(--accent, #1171df);
    color: white;
  }

  .btn-ghost {
    background-color: transparent;
    color: var(--text-secondary);
    border-color: var(--border, rgba(255, 255, 255, 0.12));
  }

  .error {
    color: var(--danger, #ef4444);
    margin: 0;
    font-size: 0.875rem;
  }

  .muted {
    color: var(--text-secondary);
  }
</style>

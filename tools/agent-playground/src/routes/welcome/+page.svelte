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
  import Combobox from "./combobox.svelte";

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

  // Curated short list — covers most users without dumping the full
  // ~430-entry IANA matrix into a popover. Datalist gives us typeahead
  // filtering for free, so the list only needs to be long enough that
  // a user who doesn't type sees a useful default set. The auto-
  // detected value is added if absent so a less-common tz still
  // shows up.
  const COMMON_TIMEZONES = [
    "Pacific/Honolulu",
    "America/Anchorage",
    "America/Los_Angeles",
    "America/Denver",
    "America/Phoenix",
    "America/Chicago",
    "America/New_York",
    "America/Toronto",
    "America/Vancouver",
    "America/Mexico_City",
    "America/Bogota",
    "America/Lima",
    "America/Santiago",
    "America/Buenos_Aires",
    "America/Sao_Paulo",
    "Atlantic/Azores",
    "UTC",
    "Europe/London",
    "Europe/Dublin",
    "Europe/Lisbon",
    "Europe/Paris",
    "Europe/Madrid",
    "Europe/Amsterdam",
    "Europe/Brussels",
    "Europe/Berlin",
    "Europe/Zurich",
    "Europe/Rome",
    "Europe/Vienna",
    "Europe/Stockholm",
    "Europe/Oslo",
    "Europe/Copenhagen",
    "Europe/Helsinki",
    "Europe/Warsaw",
    "Europe/Prague",
    "Europe/Athens",
    "Europe/Istanbul",
    "Europe/Moscow",
    "Europe/Kyiv",
    "Africa/Cairo",
    "Africa/Lagos",
    "Africa/Nairobi",
    "Africa/Johannesburg",
    "Asia/Jerusalem",
    "Asia/Dubai",
    "Asia/Tehran",
    "Asia/Karachi",
    "Asia/Kolkata",
    "Asia/Bangkok",
    "Asia/Jakarta",
    "Asia/Singapore",
    "Asia/Kuala_Lumpur",
    "Asia/Manila",
    "Asia/Hong_Kong",
    "Asia/Shanghai",
    "Asia/Taipei",
    "Asia/Seoul",
    "Asia/Tokyo",
    "Australia/Perth",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];

  function timezoneLabel(tz: string): string {
    // "America/New_York" -> "New York, America"; "UTC" stays "UTC".
    if (!tz.includes("/")) return tz;
    const [region, ...rest] = tz.split("/");
    const city = rest.join("/").replaceAll("_", " ");
    return `${city}, ${region}`;
  }

  function getTimezoneOptions(): { value: string; label: string }[] {
    const tags = new Set(COMMON_TIMEZONES);
    const detected = detectTimezone();
    if (detected) tags.add(detected);
    return [...tags]
      .sort()
      .map((tz) => ({ value: tz, label: timezoneLabel(tz) }));
  }

  // Curated locale list — top ~20 most common BCP-47 tags. Same
  // datalist+typeahead pattern as timezone.
  const COMMON_LOCALES = [
    "en-US",
    "en-GB",
    "en-CA",
    "en-AU",
    "es-ES",
    "es-MX",
    "fr-FR",
    "fr-CA",
    "de-DE",
    "it-IT",
    "pt-BR",
    "pt-PT",
    "nl-NL",
    "ja-JP",
    "ko-KR",
    "zh-CN",
    "zh-TW",
    "ru-RU",
    "ar-SA",
    "hi-IN",
  ];

  function localeLabel(tag: string): string {
    try {
      const [lang, region] = tag.split("-");
      if (!lang) return tag;
      const langDN = new Intl.DisplayNames(["en"], { type: "language" });
      const langName = langDN.of(lang) ?? lang;
      if (region) {
        const regionDN = new Intl.DisplayNames(["en"], { type: "region" });
        const regionName = regionDN.of(region) ?? region;
        return `${langName} (${regionName})`;
      }
      return langName;
    } catch {
      return tag;
    }
  }

  function getLocaleOptions(): { value: string; label: string }[] {
    const tags = new Set(COMMON_LOCALES);
    const detected = detectLocale();
    if (detected) tags.add(detected);
    return [...tags].sort().map((tag) => ({ value: tag, label: localeLabel(tag) }));
  }

  const timezoneOptions = $derived(browser ? getTimezoneOptions() : []);
  const localeOptions = $derived(browser ? getLocaleOptions() : []);

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

        <div class="field">
          <span class="label">Timezone</span>
          <Combobox
            bind:value={timezone}
            options={timezoneOptions}
            placeholder="Start typing…"
            disabled={submitting}
          />
          <span class="hint">Auto-detected from your browser.</span>
        </div>

        <div class="field">
          <span class="label">Locale</span>
          <Combobox
            bind:value={locale}
            options={localeOptions}
            placeholder="Start typing…"
            disabled={submitting}
          />
          <span class="hint">Auto-detected from your browser.</span>
        </div>

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
    align-items: center;
    background-color: var(--surface-dark);
    block-size: 100dvh;
    color: var(--text);
    display: flex;
    justify-content: center;
    padding: 2rem;
  }

  .card {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.06);
    inline-size: min(28rem, 100%);
    padding: 2.5rem;
  }

  .hero {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-block-end: 2rem;
    text-align: center;
  }

  .hero h1 {
    color: var(--text-bright);
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0;
  }

  .lede {
    color: var(--text-faded);
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
    color: var(--text-bright);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .required {
    color: var(--blue-primary);
    margin-inline-start: 0.25rem;
  }

  input[type="text"],
  input[type="email"] {
    background-color: var(--surface-bright);
    block-size: 2.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-bright);
    font: inherit;
    line-height: 1.2;
    padding-block: 0;
    padding-inline: 0.75rem;
  }

  input:focus {
    border-color: var(--blue-primary);
    outline: 2px solid color-mix(in oklab, var(--blue-primary) 30%, transparent);
    outline-offset: 0;
  }

  .hint {
    color: var(--text-faded);
    font-size: 0.75rem;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    margin-block-start: 0.5rem;
  }

  .btn {
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    padding: 0.5rem 1rem;
  }

  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .btn-primary {
    background-color: var(--blue-primary);
    color: var(--surface);
  }

  .btn-ghost {
    background-color: transparent;
    border-color: var(--border);
    color: var(--text);
  }

  .btn-ghost:hover:not(:disabled) {
    background-color: var(--highlight);
  }

  .error {
    color: var(--red-primary);
    font-size: 0.875rem;
    margin: 0;
  }

  .muted {
    color: var(--text-faded);
  }
</style>

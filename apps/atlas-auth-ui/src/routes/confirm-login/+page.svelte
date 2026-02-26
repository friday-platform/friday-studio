<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { page } from "$app/state";
  import Button from "$lib/components/button.svelte";
  import Decal from "$lib/components/decal.svelte";
  import Logo from "$lib/components/logo.svelte";
  import { toast } from "$lib/components/notifications/notifications.svelte";

  const otp = $derived(page.url.searchParams.get("otp"));
  const originalReferrer = $derived(page.url.searchParams.get("original_referrer"));

  let submitted = $state(false);
  let error: { message: string; code: string } | null = $state(null);

  async function handleVerify() {
    if (submitted || !otp) return;

    submitted = true;
    error = null;
    trackEvent(GA4.CONFIRM_LOGIN_VERIFY_CLICK);

    try {
      const response = await fetch("/magiclink/verify", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp, original_referrer: originalReferrer }),
      });

      const data = await response.json();

      if (response.ok) {
        trackEvent(GA4.CONFIRM_LOGIN_VERIFY_SUCCESS);
        window.location.href = data.redirect;
        return;
      }

      trackEvent(GA4.CONFIRM_LOGIN_VERIFY_ERROR, {
        error_code: data.code,
        error_message: data.error,
      });

      error = { message: data.error ?? "Something went wrong", code: data.code ?? "unknown" };
      submitted = false;
    } catch {
      trackEvent(GA4.CONFIRM_LOGIN_VERIFY_ERROR, { error_code: "network_error" });
      toast("An error occurred. Please try again.", true);
      submitted = false;
    }
  }
</script>

<svelte:head>
  <title>Continue to Friday</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<main>
  <Decal />

  <section>
    <div class="details">
      {#if error}
        <div class="title">
          <Logo />

          {#if error.code === "token_expired"}
            <h1>Magic link expired</h1>
            <p>This link has expired. Please request a new one.</p>
          {:else if error.code === "token_consumed"}
            <h1>Magic link already used</h1>
            <p>This link has already been used. Please request a new one.</p>
          {:else}
            <h1>Something went wrong</h1>
            <p>{error.message}</p>
          {/if}
        </div>

        <a href="/" class="retry-link">Request a new magic link</a>
      {:else if otp}
        <div class="title">
          <Logo />

          <h1>Continue to Friday</h1>
          <p>Click below to complete your login.</p>
        </div>

        <Button type="button" disabled={submitted} onclick={handleVerify}>
          {submitted ? "Continuing..." : "Continue to Friday"}
        </Button>
      {:else}
        <div class="title">
          <Logo />

          <h1>Invalid magic link</h1>
          <p>This link is missing or malformed.</p>
        </div>

        <a href="/" class="retry-link">Request a new magic link</a>
      {/if}
    </div>
  </section>

  <Decal />
</main>

<style>
  main {
    min-block-size: 100dvh;
    display: grid;
    grid-template-columns: var(--size-4) 1fr var(--size-4);
  }

  section {
    display: grid;
    grid-template-rows: 1fr;
    padding: var(--size-8);

    .details {
      align-items: center;
      display: flex;
      flex-direction: column;
      gap: var(--size-8);
      justify-content: center;
      text-align: center;
    }

    .title {
      & :global(svg) {
        inline-size: var(--size-10);
        margin: 0 auto;
      }

      h1 {
        font-size: var(--font-size-7);
        font-weight: var(--font-weight-7);
        line-height: var(--font-lineheight-1);
        margin-block-start: var(--size-6);
        text-wrap: balance;
      }

      p {
        color: var(--text-3);
        font-size: var(--font-size-4);
        padding-block-start: var(--size-1-5);
        text-wrap: balance;
      }
    }

    & :global(button) {
      max-inline-size: var(--size-72);
    }

    .retry-link {
      color: var(--accent-1);
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      text-decoration-color: color-mix(in srgb, var(--accent-1), transparent 60%);
      text-underline-offset: var(--size-1);
      text-decoration-line: underline;

      &:hover {
        text-underline-offset: var(--size-0-75);
      }
    }
  }
</style>

<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { page } from "$app/state";
  import Button from "$lib/components/button.svelte";
  import Decal from "$lib/components/decal.svelte";
  import Logo from "$lib/components/logo.svelte";
  import { toast } from "$lib/components/notifications/notifications.svelte";

  const token = $derived(page.url.searchParams.get("t"));

  let submitted = $state(false);
  let errorMessage = $state("");

  async function verify() {
    if (submitted || !token) return;

    submitted = true;
    errorMessage = "";
    trackEvent(GA4.CONFIRM_EMAIL_VERIFY_CLICK);

    try {
      const response = await fetch("/signup/email/verify", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      const data = await response.json();

      if (response.ok) {
        trackEvent(GA4.CONFIRM_EMAIL_VERIFY_SUCCESS);
        window.location.href = data.redirect;
      } else {
        trackEvent(GA4.CONFIRM_EMAIL_VERIFY_ERROR, {
          error_code: data.code,
          error_message: data.error,
        });
        errorMessage = data.error ?? "Verification failed";
        submitted = false;
      }
    } catch {
      trackEvent(GA4.CONFIRM_EMAIL_VERIFY_ERROR, { error_message: "network_error" });
      toast("Something went wrong. Please try again.", true);
      submitted = false;
    }
  }
</script>

<svelte:head>
  <title>Verify your email | Friday</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<main>
  <Decal />

  <section>
    <div class="details">
      {#if errorMessage}
        <div class="title">
          <Logo />

          <h1>Verification failed</h1>
          <p>{errorMessage}</p>
        </div>

        <a href="/signup-retry">Try signing up again</a>
      {:else if token}
        <div class="title">
          <Logo />

          <h1>Verify your email</h1>
          <p>Click the button below to confirm your email address and complete signup.</p>
        </div>

        <div class="action">
          <Button type="button" disabled={submitted} onclick={verify}>
            {submitted ? "Verifying..." : "Verify my email"}
          </Button>
        </div>
      {:else}
        <div class="title">
          <Logo />

          <h1>Invalid verification link</h1>
          <p>This link is missing or malformed.</p>
        </div>

        <a href="/signup-retry">Try signing up again</a>
      {/if}
    </div>

    <footer>
      <p>
        By signing up for Friday, you agree to our
        <a
          href="https://hellofriday.ai/privacy"
          target="_blank"
          onclick={() => trackEvent(GA4.SIGNUP_PRIVACY_LINK_CLICK, { source: "confirm_email" })}
        >
          Privacy Policy
        </a>
        and
        <a
          href="https://hellofriday.ai/terms"
          target="_blank"
          onclick={() => trackEvent(GA4.SIGNUP_TERMS_LINK_CLICK, { source: "confirm_email" })}
        >
          Terms of Service
        </a>
      </p>
    </footer>
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
    grid-template-rows: 1fr auto;
    padding: var(--size-8);
    padding-block-end: 0;

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

    .details {
      align-items: center;
      display: flex;
      flex-direction: column;
      gap: var(--size-8);
      justify-content: center;
      text-align: center;

      .action {
        inline-size: var(--size-72);
      }

      a {
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
  }

  footer {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    justify-content: center;
    padding-block: var(--size-6);

    @media (min-width: 375px) {
      flex-direction: row;
      gap: var(--size-4);
    }

    p {
      color: var(--text-3);
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      text-underline-offset: var(--size-1);
      text-decoration-color: color-mix(in srgb, var(--text-3), transparent 70%);

      a {
        color: var(--accent-1);
        font-weight: var(--font-weight-5);
        text-decoration-color: color-mix(in srgb, var(--accent-1), transparent 50%);
        text-underline-offset: var(--size-0-5);
        text-decoration-line: underline;
        transition: all 150ms ease;

        &:hover {
          text-underline-offset: var(--size-1);
        }
      }
    }
  }
</style>

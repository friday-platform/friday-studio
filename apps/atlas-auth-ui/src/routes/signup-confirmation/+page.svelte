<script lang="ts">
  import { GA4, trackEvent } from "@atlas/ga4";
  import { page } from "$app/state";
  import logoMarkDark from "$lib/assets/logo-mark-dark.png";
  import logoMark from "$lib/assets/logo-mark.png";
  import Decal from "$lib/components/decal.svelte";

  const email = $derived(page.url.searchParams.get("email"));
</script>

<svelte:head>
  <title>Check your email | Friday</title>
</svelte:head>

<main>
  <Decal />

  <section>
    <div class="details">
      <div class="title">
        <picture>
          <source srcset={logoMark} media="(prefers-color-scheme: light)" />
          <source srcset={logoMarkDark} media="(prefers-color-scheme: dark)" />
          <img src={logoMark} alt="Friday logo" />
        </picture>

        <h1>Almost done!</h1>
        {#if email}
          <p>We've sent a confirmation email to {email}.</p>
        {:else}
          <p>We've sent instructions to your email to complete setup.</p>
        {/if}
      </div>

      <p class="details-foot">
        Not seeing an email?

        <a
          href="/signup-retry"
          data-sveltekit-reload
          onclick={() => trackEvent(GA4.SIGNUP_RESEND_LINK_CLICK)}
        >
          Resend
        </a>
        or
        <a
          href="mailto:support@hellofriday.ai"
          onclick={() =>
            trackEvent(GA4.SIGNUP_SUPPORT_LINK_CLICK, { source: "signup_confirmation" })}
        >
          contact support
        </a>
      </p>
    </div>

    <footer>
      <p>
        By signing up for Friday, you agree to our
        <a
          href="https://hellofriday.ai/privacy"
          target="_blank"
          onclick={() =>
            trackEvent(GA4.SIGNUP_PRIVACY_LINK_CLICK, { source: "signup_confirmation" })}
        >
          Privacy Policy
        </a>
        and
        <a
          href="https://hellofriday.ai/terms"
          target="_blank"
          onclick={() => trackEvent(GA4.SIGNUP_TERMS_LINK_CLICK, { source: "signup_confirmation" })}
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
      & :global(img) {
        inline-size: var(--size-28);
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

      .details-foot {
        color: var(--text-3);
        font-size: var(--font-size-2);
        font-weight: var(--font-weight-5);
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

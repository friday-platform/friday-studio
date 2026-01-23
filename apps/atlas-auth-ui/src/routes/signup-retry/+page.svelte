<script lang="ts">
  import { GA4, trackEvent } from "@atlas/ga4";
  import { enhance } from "$app/forms";
  import logoMarkDark from "$lib/assets/logo-mark-dark.png";
  import logoMark from "$lib/assets/logo-mark.png";
  import Button from "$lib/components/button.svelte";
  import Decal from "$lib/components/decal.svelte";
  import { toast } from "$lib/components/notifications/notifications.svelte";

  let success = $state(false);
  let submitted = $state(false);
</script>

<svelte:head>
  <title>Link Expired | Friday</title>
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

        <h1>Resend Confirmation Email</h1>
        <p>Enter the email you used to sign up with to get a new one.</p>
      </div>

      {#if !success}
        <form
          method="POST"
          action="/signup"
          use:enhance={({ cancel }) => {
            if (submitted) {
              cancel();
            }

            submitted = true;
            trackEvent(GA4.SIGNUP_RETRY_SUBMIT);

            return async ({ result, update }) => {
              submitted = false;

              if (result.type === "failure") {
                const message =
                  typeof result.data?.message === "string"
                    ? result.data.message
                    : "Something went wrong";
                trackEvent(GA4.SIGNUP_RETRY_ERROR, { error_message: message });
                toast(message, true);

                update({ reset: false });
              }

              if (result.type === "redirect") {
                trackEvent(GA4.SIGNUP_RETRY_SUCCESS);
                update({ reset: true });
                success = true;
              }
            };
          }}
        >
          <input
            type="email"
            placeholder="Enter your email address"
            required
            name="email"
            spellcheck="false"
          />
          <Button type="submit" disabled={submitted}>
            {submitted ? "Requesting..." : "Resend Email"}
          </Button>
        </form>
      {:else}
        <p class="details-foot">
          Your request has been sent. If you do not receive an email,
          <a
            href="mailto:support@hellofriday.ai"
            onclick={() => trackEvent(GA4.SIGNUP_SUPPORT_LINK_CLICK, { source: "signup_retry" })}
          >
            Contact Support.
          </a>
        </p>
      {/if}
    </div>

    <footer>
      <p>
        By signing up for Friday, you agree to our
        <a
          href="https://hellofriday.ai/privacy"
          target="_blank"
          onclick={() => trackEvent(GA4.SIGNUP_PRIVACY_LINK_CLICK, { source: "signup_retry" })}
        >
          Privacy Policy
        </a>
        and
        <a
          href="https://hellofriday.ai/terms"
          target="_blank"
          onclick={() => trackEvent(GA4.SIGNUP_TERMS_LINK_CLICK, { source: "signup_retry" })}
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
    }

    form {
      align-items: center;
      display: flex;
      flex-direction: column;
      gap: var(--size-2);
      justify-content: center;
      inline-size: var(--size-72);

      input {
        background-color: var(--background-1);
        border: var(--size-px) solid var(--border-2);
        border-radius: var(--radius-3);
        block-size: var(--size-7-5);
        inline-size: 100%;
        padding-inline: var(--size-3);
        text-align: center;
      }

      & :global {
        a,
        button {
          inline-size: 100% !important;
        }
      }
    }

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

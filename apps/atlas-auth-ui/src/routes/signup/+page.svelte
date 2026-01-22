<script lang="ts">
  import { enhance } from "$app/forms";
  import logoMarkDark from "$lib/assets/logo-mark-dark.png";
  import logoMark from "$lib/assets/logo-mark.png";
  import Button from "$lib/components/button.svelte";
  import GoogleLogo from "$lib/components/icons/google-logo.svelte";
  import { GA4, trackEvent } from "@atlas/ga4";

  let submitted = $state(false);
  let agree_to_terms = $state(false);

  function handleGoogleAuth() {
    trackEvent(GA4.SIGNUP_GOOGLE_CLICK);
    window.location.href = "/auth/google?signup=true";
  }
</script>

<svelte:head>
  <title>Friday</title>
  <meta name="description" content="Sign up for Friday" />
</svelte:head>

<main>
  <p class="existing-users">
    Already have an account?
    <a href="/" onclick={() => trackEvent(GA4.SIGNUP_LOGIN_LINK_CLICK)}>Login</a>
  </p>

  <section>
    <div class="form">
      <div class="title">
        <picture>
          <source srcset={logoMark} media="(prefers-color-scheme: light)" />
          <source srcset={logoMarkDark} media="(prefers-color-scheme: dark)" />
          <img src={logoMark} alt="Friday logo" />
        </picture>

        <h1>Sign up for Friday</h1>
      </div>

      <form
        method="POST"
        use:enhance={({ cancel }) => {
          if (submitted) {
            cancel();
          }

          submitted = true;
          trackEvent(GA4.SIGNUP_EMAIL_SUBMIT);

          return async ({ result, update }) => {
            submitted = false;

            if (result.type === "failure") {
              const message =
                typeof result.data?.message === "string"
                  ? result.data.message
                  : "Something went wrong";
              trackEvent(GA4.SIGNUP_EMAIL_ERROR, { error_message: message });
              alert(message);

              update({ reset: false });
            }

            if (result.type === "redirect") {
              trackEvent(GA4.SIGNUP_EMAIL_SUCCESS);
              window.location.href = result.location;
            }
          };
        }}
      >
        <label>
          <input
            type="checkbox"
            required
            name="agree_to_terms"
            bind:checked={agree_to_terms}
            onchange={() => trackEvent(GA4.SIGNUP_TERMS_TOGGLE, { checked: agree_to_terms })}
          />

          By signing up for Friday, I agree to the
          <a
            href="https://hellofriday.ai/privacy"
            target="_blank"
            onclick={() => trackEvent(GA4.SIGNUP_PRIVACY_LINK_CLICK, { source: "signup" })}
          >
            Privacy Policy
          </a>
          and
          <a
            href="https://hellofriday.ai/terms"
            target="_blank"
            onclick={() => trackEvent(GA4.SIGNUP_TERMS_LINK_CLICK, { source: "signup" })}
          >
            Terms of Service
          </a>
        </label>

        <input
          type="email"
          placeholder="Enter your email address"
          required
          name="email"
          spellcheck="false"
        />
        <Button type="submit" disabled={submitted}>
          {submitted ? "Completing signup..." : "Sign up"}
        </Button>

        <h2>Additional Options</h2>

        <Button disabled={submitted || !agree_to_terms} onclick={handleGoogleAuth}>
          {#snippet prepend()}
            <GoogleLogo />
          {/snippet}

          Sign up with Google Workspace
        </Button>
      </form>
    </div>
  </section>
</main>

<style>
  .existing-users {
    color: var(--text-3);
    font-size: var(--font-size-2);
    padding: var(--size-6);
    text-align: center;

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

    @media (min-width: 1024px) {
      inset-block-start: var(--size-4);
      inset-inline-end: var(--size-4);
      position: fixed;
    }
  }

  main {
    @media (min-width: 1024px) {
      block-size: 100dvh;
    }
  }

  section {
    align-items: center;
    display: flex;
    justify-content: center;
    min-block-size: 100dvh;
    padding: var(--size-8);

    .title {
      & :global(img) {
        inline-size: var(--size-28);
        margin: 0 auto;
      }

      h1 {
        font-size: var(--font-size-7);
        font-weight: var(--font-weight-7);
        margin-block-start: var(--size-6);
        text-align: center;
      }
    }

    .form {
      align-items: center;
      display: flex;
      flex-direction: column;
      /* gap: var(--size-8); */
      justify-content: center;
      text-align: center;

      form {
        align-items: center;
        display: flex;
        flex-direction: column;
        gap: var(--size-2);
        justify-content: center;
        inline-size: var(--size-72);

        input[type="email"] {
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

        h2 {
          color: var(--text-3);
          font-size: var(--font-size-2);
          font-weight: var(--font-weight-5);
          padding-block-start: var(--size-6);
        }

        label {
          color: var(--text-3);
          margin-block: var(--size-2) var(--size-8);
        }

        a {
          color: var(--accent-1);
          font-size: var(--font-size-2);
          font-weight: var(--font-weight-5);
          text-decoration-color: color-mix(in srgb, var(--accent-1), transparent 60%);
          text-underline-offset: var(--size-0-5);
          text-decoration-line: underline;
          transition: all 150ms ease;

          &:hover {
            text-underline-offset: var(--size-1);
          }
        }
      }
    }
  }
</style>

<script lang="ts">
  import logoMarkDark from "$lib/assets/logo-mark-dark.png";
  import logoMark from "$lib/assets/logo-mark.png";
  import Button from "$lib/components/button.svelte";
  import Decal from "$lib/components/decal.svelte";
  import GoogleLogo from "$lib/components/icons/google-logo.svelte";
  import { onMount } from "svelte";

  let emailValue = $state("");
  let visible = $state(false);
  let magiclinkSent = $state(false);
  let isSubmitting = $state(false);

  function handleGoogleAuth() {
    window.location.href = "/auth/google";
  }

  async function handleMagicLink(event: Event) {
    event.preventDefault();
    if (isSubmitting || !emailValue) return;

    isSubmitting = true;

    try {
      const response = await fetch("/magiclink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailValue }),
      });

      if (response.ok) {
        magiclinkSent = true;
      } else {
        alert("Failed to send magic link. Please try again.");
      }
    } catch (error) {
      console.error(error);
      alert("An error occurred. Please try again.");
    } finally {
      isSubmitting = false;
    }
  }

  onMount(() => {
    setTimeout(() => {
      visible = true;
    }, 750);
  });
</script>

<main>
  <Decal />

  <section>
    <div class="details">
      {#if magiclinkSent}
        <h1>Your magic link has been sent</h1>

        <button
          class="login-reset"
          type="button"
          onclick={() => {
            magiclinkSent = false;
            emailValue = "";
          }}
        >
          Go back
        </button>
      {:else}
        <div class="wordmark">
          <picture>
            <source srcset={logoMark} media="(prefers-color-scheme: light)" />
            <source srcset={logoMarkDark} media="(prefers-color-scheme: dark)" />
            <img src={logoMark} alt="Friday logo" />
          </picture>
        </div>

        <h1>Login to Friday</h1>

        <div class="login-form">
          <form onsubmit={handleMagicLink}>
            <input
              disabled={!visible}
              bind:value={emailValue}
              type="email"
              autocomplete="email"
              placeholder="Enter your email address"
              required
              name="email"
              spellcheck="false"
            />

            <Button type="submit" variant="default" disabled={isSubmitting}>
              {isSubmitting ? "Sending..." : "Continue"}
            </Button>

            <h2>or</h2>

            <Button variant="default" type="button" onclick={handleGoogleAuth}>
              {#snippet prepend()}<GoogleLogo />{/snippet}
              Sign in with Google
            </Button>
          </form>
        </div>
      {/if}
    </div>

    <p class="signup">
      <a href="/signup">Create an Account</a>
    </p>
  </section>

  <Decal />
</main>

<svelte:head>
  <title>Friday</title>
  <meta name="description" content="Sign in to Friday" />
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<style>
  main {
    block-size: 100dvh;
    display: grid;
    grid-template-columns: var(--size-4) 1fr var(--size-4);
  }

  section {
    display: grid;
    grid-template-rows: 1fr auto;
    gap: var(--size-8);
    overflow: scroll;
    padding-block-end: var(--size-8);
  }

  @media (min-width: 768px) {
    section {
      padding: var(--size-8);
    }
  }

  h1 {
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-7);
    line-height: var(--font-lineheight-1);
    margin-block-start: var(--size-6);
    text-wrap: balance;
    transform: translateY(calc(-1 * var(--size-2)));
  }

  .wordmark img {
    inline-size: var(--size-28);
  }

  .details {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    margin-block-start: calc(-1 * var(--size-15));
  }

  .details .login-form {
    align-items: start;
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
    margin-block-start: var(--size-6);
    max-inline-size: var(--size-72);
    inline-size: 100%;
  }

  .details form {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    grid-row: 1 / -1;
    grid-column: 1 / -1;
    justify-content: center;
    inline-size: 100%;
    transition: all 375ms ease-out;
  }

  .details form input {
    background-color: var(--background-1);
    border: var(--size-px) solid var(--border-2);
    border-radius: var(--radius-3);
    block-size: var(--size-7-5);
    inline-size: 100%;

    padding-inline: var(--size-3);

    text-align: center;
  }

  .details form input::placeholder {
    color: var(--text-3);
  }

  .details form input:focus {
    outline: var(--size-px) solid var(--accent-1);
    text-align: left;
  }

  .details form h2 {
    color: var(--text-3,);
    font-size: var(--font-size-2,);
    font-weight: var(--font-weight-5,);
    padding-block-start: var(--size-4,);
    transform: translateY(var(--size-1));
  }

  .login-reset {
    color: var(--text-3);
    font-weight: var(--font-weight-5);
    margin-block-start: var(--size-4);
    text-decoration-color: color-mix(in srgb, var(--accent-1), transparent 50%);
    text-underline-offset: var(--size-0-5);
    text-decoration-line: underline;
    transition: all 0.15s ease;
  }

  .login-reset:hover {
    text-underline-offset: var(--size-1,);
  }

  .signup {
    color: var(--text-3,);
    font-size: var(--font-size-2);
    text-align: center;
  }

  .signup a {
    color: var(--accent-1);
    font-weight: var(--font-weight-5);
    text-decoration-color: color-mix(in srgb, (--accent-1), transparent 50%);
    text-underline-offset: var(--size-0-5);
    text-decoration-line: underline;
    transition: all 0.15s ease;
  }

  .signup a:hover {
    text-underline-offset: var(--size-1);
  }
</style>

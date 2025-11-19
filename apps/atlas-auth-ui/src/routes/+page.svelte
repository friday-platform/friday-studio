<script lang="ts">
import { onMount } from "svelte";
import Button from "$lib/components/button.svelte";
import Decal from "$lib/components/decal.svelte";
import GoogleLogo from "$lib/components/icons/google-logo.svelte";
import VortexLogo from "$lib/components/icons/vortex-logo.svelte";
import Vortex from "$lib/components/vortex.svelte";

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
      <div class="wordmark">
        <div class="vortex">
          <Vortex />
        </div>

        <div class="logo">
          <VortexLogo />
        </div>
      </div>

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
        <h1>Login to Atlas</h1>

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
  <title>Atlas</title>
  <meta name="description" content="Sign in to Atlas" />
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<style>
  main {
    block-size: 100dvh;
    display: grid;
    grid-template-columns: var(--size-4, 1rem) 1fr var(--size-4, 1rem);
  }

  section {
    display: grid;
    grid-template-rows: 1fr auto;
    gap: var(--size-8, 2rem);
    overflow: scroll;
    padding-block-end: var(--size-8, 2rem);
  }

  @media (min-width: 768px) {
    section {
      padding: var(--size-8, 2rem);
    }
  }

  .wordmark {
    animation: fadeIn .7s 375ms ease-out 1 forwards;
    align-items: center;
    block-size: var(--size-80, 20rem);
    display: grid;
    grid-template-columns: 1;
    grid-template-rows: 1;
    inline-size: 100%;
    max-inline-size: var(--size-80, 20rem);
    justify-items: center;
    opacity: 0;
    transform: scale(.7);
  }

  .wordmark .vortex {
    align-items: center;
    display: flex;
    grid-row: 1 / -1;
    grid-column: 1 / -1;
    justify-content: center;
  }

  .wordmark .logo {
    align-items: center;
    background-color: var(--accent-1, #1a53cc);
    block-size: var(--size-10, 2.5rem);
    border-radius: var(--radius-4, .75rem);
    color: var(--background-1, white);
    display: flex;
    grid-row: 1 / -1;
    grid-column: 1 / -1;
    inline-size: var(--size-10, 2.5rem);
    justify-content: center;
    position: relative;
    z-index: 2;
  }

  .wordmark .logo :global(svg) {
    block-size: var(--size-6, 1.5rem);
  }

  h1 {
    animation: fadeIn .7s 375ms ease-out 1 forwards;
    opacity: 0;
    font-size: var(--font-size-7, 1.5rem);
    font-weight: var(--font-weight-7, 700);
    line-height: var(--font-lineheight-1, 1.25);
    margin-block-start: var(--size-6, 1.5rem);
    text-wrap: balance;
    transform: translateY(calc(-1 * var(--size-2, .5rem)));
  }

  .details {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    margin-block-start: calc(-1 * var(--size-15, 3.75rem));
  }

  .details .login-form {
    align-items: start;
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
    margin-block-start: var(--size-6, 1.5rem);
    max-inline-size: var(--size-72, 18rem);
    inline-size: 100%;
  }

  .details form {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-2, .5rem);
    grid-row: 1 / -1;
    grid-column: 1 / -1;
    justify-content: center;
    inline-size: 100%;
    transition: all 375ms ease-out;
  }

  .details form input {
    animation: fadeIn .25s 375ms ease-out 1 forwards;
    background-color: var(--background-1, white);
    border: var(--size-px, 1px) solid var(--border-2, rgba(0, 0, 0, 0.12));
    border-radius: var(--radius-3, .625rem);
    block-size: var(--size-7-5, 1.875rem);
    inline-size: 100%;
    opacity: 0;
    padding-inline: var(--size-3, .75rem);
    transform: scale(.92) translateZ(0);
    text-align: center;
  }

  .details form input::placeholder {
    color: var(--text-3, #999);
  }

  .details form input:focus {
    outline: var(--size-px, 1px) solid var(--accent-1, #1a53cc);
    text-align: left;
  }

  .details form h2 {
    animation: fadeIn .4s 525ms ease-out 1 forwards;
    color: var(--text-3, #666);
    font-size: var(--font-size-2, .75rem);
    font-weight: var(--font-weight-5, 500);
    opacity: 0;
    padding-block-start: var(--size-4, 1rem);
    transform: translateY(var(--size-1, .25rem));
  }

  .details form a,
  .details form button {
    inline-size: 100% !important;
  }

  .details form button {
    animation: fadeIn 325ms .45s ease-out 1 forwards;
    opacity: 0;
    transform: scale(.92);
  }

  .details form a {
    animation: fadeIn 475ms .6s ease-out 1 forwards;
    opacity: 0;
    transform: scale(.92);
  }

  .login-reset {
    animation: fadeIn .5s .75s ease-out 1 forwards;
    color: var(--text-3, #666);
    font-weight: var(--font-weight-5, 500);
    margin-block-start: var(--size-4, 1rem);
    text-decoration-color: color-mix(in srgb, var(--accent-1, #1a53cc), transparent 50%);
    text-underline-offset: var(--size-0-5, .125rem);
    text-decoration-line: underline;
    opacity: 0;
    transition: all .15s ease;
  }

  .login-reset:hover {
    text-underline-offset: var(--size-1, .25rem);
  }

  .signup {
    animation: fadeIn 375ms .5s ease-out 1 forwards;
    color: var(--text-3, rgba(0, 0, 0, 0.6));
    font-size: var(--font-size-2, .75rem);
    opacity: 0;
    text-align: center;
  }

  .signup a {
    color: var(--accent-1, #1a53cc);
    font-weight: var(--font-weight-5, 500);
    text-decoration-color: color-mix(in srgb, var(--accent-1, #1a53cc), transparent 50%);
    text-underline-offset: var(--size-0-5, .125rem);
    text-decoration-line: underline;
    transition: all .15s ease;
  }

  .signup a:hover {
    text-underline-offset: var(--size-1, .25rem);
  }

  @keyframes fadeIn {
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }
</style>

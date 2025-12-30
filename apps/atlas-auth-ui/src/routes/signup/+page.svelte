<script lang="ts">
import { enhance } from "$app/forms";
import Button from "$lib/components/button.svelte";
import GoogleLogo from "$lib/components/icons/google-logo.svelte";

let submitted = $state(false);
</script>

<svelte:head>
  <title>Friday</title>
  <meta name="description" content="Sign up for Friday" />
</svelte:head>

<main>
  <p class="existing-users">
    Already have an account?
    <a href="/">Login</a>
  </p>

  <section>
    <div class="form">
      <div class="title">
        <h1>Sign up for Friday</h1>
      </div>

      <form
        method="POST"
        use:enhance={({ cancel }) => {
          if (submitted) {
            cancel();
          }

          submitted = true;

          return async ({ result, update }) => {
            submitted = false;

            if (result.type === "failure") {
              alert(
                typeof result.data?.message === "string"
                  ? result.data.message
                  : "Something went wrong",
              );

              update({ reset: false });
            }

            if (result.type === "redirect") {
              window.location.href = result.location;
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
          {submitted ? "Completing signup..." : "Sign up"}
        </Button>

        <h2>Additional Options</h2>
        <a href="/oauth/google/authorize">
          <Button disabled={submitted}>
            {#snippet prepend()}
              <GoogleLogo />
            {/snippet}

            Sign up with Google Workspace
          </Button>
        </a>
      </form>
    </div>

    <footer>
      <p>
        By signing up for Friday, you agree to our <a
          href="https://tempestdx.com/company/privacypolicy"
          target="_blank"
        >
          Privacy Policy
        </a>
        and
        <a href="https://tempestdx.com/company/terms" target="_blank">Terms of Service</a>
      </p>
    </footer>
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
    min-block-size: 100dvh;
    display: grid;
    grid-template-rows: 1fr auto;
    padding: var(--size-8);
    padding-block-end: 0;

    @media (min-width: 1024px) {
      block-size: auto;
      grid-column: 2;
      grid-row: 1;
    }

    .title {
      & :global(svg) {
        inline-size: var(--size-9);
        margin: 0 auto;
      }

      h1 {
        font-size: var(--font-size-7);
        font-weight: var(--font-weight-7);
        margin-block-start: var(--size-6);
      }
    }

    .form {
      align-items: center;
      display: flex;
      flex-direction: column;
      gap: var(--size-8);
      justify-content: center;
      text-align: center;

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

        h2 {
          color: var(--text-3);
          font-size: var(--font-size-2);
          font-weight: var(--font-weight-5);
          padding-block-start: var(--size-6);
        }
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

<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import Button from "$lib/components/button.svelte";
  import Decal from "$lib/components/decal.svelte";
  import { Form } from "$lib/components/form";
  import Logo from "$lib/components/logo.svelte";
  import { toast } from "$lib/components/notifications/notifications.svelte";
  import { zfd } from "zod-form-data";

  const { data } = $props();

  let submitted = $state(false);

  const signupSchema = zfd.formData({ user_full_name: zfd.text() });
</script>

<main>
  <Decal />

  <section>
    <div class="wordmark">
      <Logo />
    </div>

    <form
      method="POST"
      onsubmit={async (e) => {
        e.preventDefault();

        if (submitted) return;

        submitted = true;
        trackEvent(GA4.SETUP_PROFILE_SUBMIT);

        const formData = new FormData(e.currentTarget);

        const input = signupSchema.safeParse(formData);

        // in case of an error return the data and errors
        if (!input.success) {
          trackEvent(GA4.SETUP_PROFILE_ERROR, {
            error_message: "Please enter all required fields",
          });
          toast("Please enter all required fields", true);
          submitted = false;
        }

        try {
          if (input.data) {
            const response = await fetch(`/signup/complete`, {
              method: "POST",
              credentials: "include",
              headers: { Accept: "application/json", "Content-Type": "application/json" },
              body: JSON.stringify({ userFullName: input.data.user_full_name }),
            });

            if (response.ok) {
              trackEvent(GA4.SETUP_PROFILE_SUCCESS);
              window.location.href = data.appUrl;
            } else {
              submitted = false;

              if (response.status === 409) {
                trackEvent(GA4.SETUP_PROFILE_ERROR, {
                  error_message: "Organization name already exists",
                });
                toast("Organization name already exists", true);
              } else {
                trackEvent(GA4.SETUP_PROFILE_ERROR, { error_message: "Failed to complete setup" });
                toast("Failed to complete setup", true);
              }
            }
          }
        } catch (error) {
          trackEvent(GA4.SETUP_PROFILE_ERROR, { error_message: "Failed to complete setup" });
          toast("Failed to complete setup", true);
          console.error(error);
          submitted = false;
        }
      }}
    >
      <div class="title">
        <h1>Complete Setup</h1>
        <p>Add some details about yourself.</p>
      </div>

      <Form.Content spacing="large">
        <Form.Field layout="block" label="Your Name">
          <Form.Input
            placeholder="What should we call you?"
            name="user_full_name"
            required
            minlength={3}
            maxlength={128}
          />
        </Form.Field>
      </Form.Content>

      <div class="form-footer">
        <Button type="submit" disabled={submitted}>
          {submitted ? "Completing..." : "Complete Setup"}
        </Button>
      </div>
    </form>
  </section>

  <Decal />
</main>

<svelte:head>
  <title>Complete Setup - Friday</title>
  <meta name="description" content="Complete your Friday setup" />
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
    padding: var(--size-8);
    padding-block-end: 0;
    position: relative;

    .wordmark {
      inline-size: var(--size-6);
      inset-block-start: var(--size-8);
      inset-inline-start: var(--size-8);
      position: absolute;

      & :global(svg) {
        aspect-ratio: 1 / 1;
        object-fit: contain;
        inline-size: 100%;
      }
    }

    .title {
      text-align: center;

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
  }

  form {
    display: flex;
    flex-direction: column;
    gap: var(--size-12);
    justify-content: center;
    inline-size: 100%;
    margin: 0 auto;
    max-inline-size: var(--size-96);

    .form-footer {
      display: flex;
      justify-content: center;
    }
  }
</style>

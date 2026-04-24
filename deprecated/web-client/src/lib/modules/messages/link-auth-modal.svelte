<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { stringifyError } from "@atlas/utils";
  import { Dialog } from "$lib/components/dialog";
  import type { Snippet } from "svelte";
  import type { SecretField } from "./secret-fields";

  type Props = {
    provider: string;
    displayName: string;
    secretFields: SecretField[];
    onSuccess: (credentialId: string) => void;
    onClose?: () => void;
    triggerContents: Snippet;
  };

  let { provider, displayName, secretFields, onSuccess, onClose, triggerContents }: Props =
    $props();

  const SENSITIVE_PATTERNS = /password|secret|token|key/i;

  let label = $state("");
  let fieldValues = $state<Record<string, string>>({});
  let isSubmitting = $state(false);
  let error = $state<string | null>(null);

  function resetForm() {
    label = "";
    fieldValues = {};
    error = null;
  }

  function isSensitiveField(key: string): boolean {
    return SENSITIVE_PATTERNS.test(key);
  }

  async function handleSubmit(open: { set: (v: boolean) => void }) {
    if (!label.trim()) {
      error = "Label is required";
      return;
    }

    const missingRequired = secretFields
      .filter((f) => f.required && !fieldValues[f.key]?.trim())
      .map((f) => f.label);

    if (missingRequired.length > 0) {
      error = `Required: ${missingRequired.join(", ")}`;
      return;
    }

    const secret: Record<string, string> = {};
    for (const field of secretFields) {
      const value = fieldValues[field.key]?.trim();
      if (value) {
        secret[field.key] = value;
      }
    }

    isSubmitting = true;
    error = null;
    trackEvent(GA4.CREDENTIAL_LINK_START, { provider, type: "apikey" });

    try {
      const result = await parseResult(
        client.link.v1.credentials[":type"].$put({
          param: { type: "apikey" },
          json: { provider, label: label.trim(), secret },
        }),
      );

      if (result.ok) {
        trackEvent(GA4.CREDENTIAL_LINK_SUCCESS, { provider, type: "apikey" });
        onSuccess(result.data.id);
        open.set(false);
        resetForm();
      } else {
        trackEvent(GA4.CREDENTIAL_LINK_ERROR, { provider, type: "apikey" });
        error = stringifyError(result.error);
      }
    } catch (err) {
      trackEvent(GA4.CREDENTIAL_LINK_ERROR, { provider, type: "apikey" });
      error = stringifyError(err);
    } finally {
      isSubmitting = false;
    }
  }
</script>

<Dialog.Root
  onOpenChange={({ next }) => {
    if (!next) {
      resetForm();
      onClose?.();
    }
    return next;
  }}
>
  {#snippet children(open)}
    <Dialog.Trigger>
      {@render triggerContents()}
    </Dialog.Trigger>

    <Dialog.Content size="large">
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Connect {displayName}</Dialog.Title>
        <Dialog.Description>
          Enter your credentials to connect {displayName}
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <form
          class="form"
          onsubmit={(e) => {
            e.preventDefault();
            handleSubmit(open);
          }}
        >
          <div class="field">
            <label for="link-auth-label">Label</label>
            <input
              id="link-auth-label"
              type="text"
              bind:value={label}
              placeholder="e.g., Work Account"
              disabled={isSubmitting}
              required
            />
          </div>

          {#each secretFields as field (field.key)}
            <div class="field">
              <label for="link-auth-{field.key}">{field.label}</label>
              <input
                id="link-auth-{field.key}"
                type={isSensitiveField(field.key) ? "password" : "text"}
                bind:value={fieldValues[field.key]}
                placeholder={field.required
                  ? `Enter ${field.label.toLowerCase()}`
                  : `${field.label} (optional)`}
                disabled={isSubmitting}
                required={field.required}
              />
            </div>
          {/each}

          {#if error}
            <div class="error">
              {error}
            </div>
          {/if}

          <div class="buttons">
            <Dialog.Button type="submit" disabled={isSubmitting} closeOnClick={false}>
              {isSubmitting ? "Connecting..." : "Connect"}
            </Dialog.Button>
            <Dialog.Cancel onclick={resetForm}>Cancel</Dialog.Cancel>
          </div>
        </form>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    inline-size: 100%;
    max-inline-size: var(--size-96);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    text-align: start;
  }

  label {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    opacity: 0.7;
  }

  input {
    background-color: var(--color-surface-2);
    block-size: var(--size-9);
    border-radius: var(--radius-3);
    border: var(--size-px) solid var(--color-border-1);
    color: var(--color-text);
    font-size: var(--font-size-3);
    padding-inline: var(--size-3);
    transition: all 200ms ease;
  }

  input:focus {
    border-color: var(--color-yellow);
    outline: none;
  }

  input:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  input::placeholder {
    color: color-mix(in oklch, var(--color-text) 50%, transparent);
  }

  .error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border-radius: var(--radius-2);
    border: var(--size-px) solid var(--color-red);
    color: var(--color-red);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
  }

  .buttons {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    inline-size: 100%;
  }
</style>

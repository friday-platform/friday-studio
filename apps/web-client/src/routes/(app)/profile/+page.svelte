<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { invalidateAll } from "$app/navigation";
  import { getAppContext } from "$lib/app-context.svelte";
  import Button from "$lib/components/button.svelte";
  import ImagePicker from "$lib/components/image-picker.svelte";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { Page } from "$lib/components/page";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const appCtx = getAppContext();

  // User-editable state seeded from initial prop values.
  let fullName = $state(data.user.full_name);
  let displayName = $state(data.user.display_name ?? "");
  let selectedFile = $state<File | null>(null);
  let photoRemoved = $state(false);
  let saving = $state(false);

  let currentPhotoUrl = $derived(photoRemoved ? null : data.user.profile_photo);
  let hasChanges = $derived(
    fullName !== data.user.full_name ||
      displayName !== (data.user.display_name ?? "") ||
      selectedFile !== null ||
      photoRemoved,
  );

  function handleFileSelect(file: File | null) {
    if (file) {
      selectedFile = file;
      photoRemoved = false;
    } else {
      selectedFile = null;
      photoRemoved = true;
    }
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    saving = true;

    try {
      const daemonUrl = getAtlasDaemonUrl();
      let response: Response;

      if (selectedFile) {
        const formData = new FormData();
        formData.append("photo", selectedFile);
        const fields: Record<string, string | null> = {
          full_name: fullName,
          display_name: displayName || null,
        };
        formData.append("fields", JSON.stringify(fields));
        response = await fetch(`${daemonUrl}/api/me`, { method: "PATCH", body: formData });
      } else {
        const body: Record<string, string | null> = {
          full_name: fullName,
          display_name: displayName || null,
        };
        if (photoRemoved) {
          body.profile_photo = "";
        }
        response = await fetch(`${daemonUrl}/api/me`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        toast({ title: "Failed to save profile", description: errText, error: true });
        return;
      }

      // Re-fetch user data to update sidebar. The layout onMount only
      // assigns appCtx.user once, so we update it directly here.
      const refreshed = await parseResult(client.me.index.$get());
      if (refreshed.ok) {
        appCtx.user = refreshed.data.user;
        // Sync form state with saved data
        fullName = refreshed.data.user.full_name;
        displayName = refreshed.data.user.display_name ?? "";
      }
      await invalidateAll();

      selectedFile = null;
      photoRemoved = false;
      toast({ title: "Profile updated" });
    } catch {
      toast({ title: "Failed to save profile", description: "Network error", error: true });
    } finally {
      saving = false;
    }
  }
</script>

<Page.Content>
  {#snippet header()}
    <h1>Profile Details</h1>
  {/snippet}

  <form onsubmit={handleSubmit}>
    <div class="form-fields">
      <div class="field">
        <span class="label" id="photo-label">Profile Photo</span>
        <ImagePicker currentImageUrl={currentPhotoUrl} onFileSelect={handleFileSelect} />
      </div>

      <div class="field">
        <label class="label" for="full-name">Full Name</label>
        <input id="full-name" type="text" class="input" bind:value={fullName} required />
      </div>

      <div class="field">
        <label class="label" for="display-name">Display Name</label>
        <input
          id="display-name"
          type="text"
          class="input"
          bind:value={displayName}
          placeholder={fullName}
        />
      </div>

      <div class="field">
        <label class="label" for="email">Email</label>
        <input id="email" type="email" class="input" value={data.user.email} disabled />
      </div>

      <div class="actions">
        <Button type="submit" disabled={saving || !fullName.trim()}>
          {saving ? "Saving..." : "Save"}
        </Button>
        {#if hasChanges}
          <span class="unsaved">Unsaved changes</span>
        {/if}
      </div>
    </div>
  </form>
</Page.Content>

<style>
  form {
    max-inline-size: var(--size-128);
  }

  .form-fields {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .label {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .input {
    background-color: var(--color-surface-1);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-2-5);
    color: var(--color-text);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-3);
    padding: var(--size-2) var(--size-3);
    transition: border-color 150ms ease;

    &:focus {
      border-color: color-mix(in srgb, var(--color-border-1), var(--color-text) 30%);
      outline: none;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    &::placeholder {
      color: color-mix(in srgb, var(--color-text), transparent 60%);
    }
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    padding-block-start: var(--size-2);
  }

  .unsaved {
    color: var(--color-text);
    font-size: var(--font-size-2);
    opacity: 0.6;
  }
</style>

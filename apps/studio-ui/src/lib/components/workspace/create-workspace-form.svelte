<script lang="ts">
  import { Button } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { getDaemonClient } from "$lib/daemon-client";
  import { workspaceQueries } from "$lib/queries";
  import { z } from "zod";

  interface Props {
    onclose?: () => void;
  }

  let { onclose }: Props = $props();

  const client = getDaemonClient();
  const queryClient = useQueryClient();

  let name = $state("");
  let description = $state("");
  let error = $state<string | null>(null);
  let loading = $state(false);

  /** Convert "Stock Monitor" → "stock-monitor" for the directory name. */
  function toKebab(s: string): string {
    return s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    error = null;

    const displayName = name.trim();
    if (!displayName) {
      error = "Name is required";
      return;
    }

    const workspaceName = toKebab(displayName);
    if (!workspaceName) {
      error = "Name must contain at least one letter or number";
      return;
    }

    loading = true;
    try {
      const config: Record<string, unknown> = {
        version: "1.0",
        workspace: {
          name: displayName,
          ...(description.trim() && { description: description.trim() }),
        },
      };

      const res = await client.workspace.create.$post({
        json: { config, workspaceName },
      });

      if (!res.ok) {
        const body = await res.text();
        error = `Failed to create workspace: ${body}`;
        return;
      }

      const result: unknown = await res.json();
      const parsed = z
        .object({ workspace: z.object({ id: z.string() }) })
        .passthrough()
        .safeParse(result);

      if (!parsed.success) {
        console.warn("Workspace created but response shape unexpected:", parsed.error);
      }

      await queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });

      onclose?.();

      goto(`/platform/${parsed.success ? parsed.data.workspace.id : ""}`);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to create workspace";
    } finally {
      loading = false;
    }
  }
</script>

<form class="form" onsubmit={handleSubmit}>
  <div class="field">
    <label for="ws-name">
      Name <span class="required">*</span>
    </label>
    <input
      id="ws-name"
      type="text"
      placeholder="e.g. Stock Monitor"
      bind:value={name}
      disabled={loading}
      required
    />
    {#if name.trim()}
      <span class="slug">/{toKebab(name)}</span>
    {/if}
  </div>

  <div class="field">
    <label for="ws-description">Description</label>
    <textarea
      id="ws-description"
      placeholder="What does this workspace do?"
      bind:value={description}
      disabled={loading}
      rows={3}
    ></textarea>
  </div>

  <p class="hint">You can add agents, jobs, and signals later.</p>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="submit-row">
    <Button type="submit" variant="primary" disabled={loading}>
      {loading ? "Creating..." : "Create"}
    </Button>
  </div>
</form>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    inline-size: 100%;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    text-align: left;
  }

  label {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
  }

  .required {
    color: var(--color-red);
  }

  input[type="text"],
  textarea {
    background-color: var(--color-surface-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-3);
    padding: var(--size-2-5) var(--size-3);
    transition: border-color 150ms ease;
    width: 100%;
  }

  input[type="text"] {
    block-size: var(--size-9);
  }

  textarea {
    line-height: var(--font-lineheight-3);
    resize: vertical;
  }

  input[type="text"]:focus,
  textarea:focus {
    border-color: var(--color-accent);
    outline: none;
  }

  input[type="text"]::placeholder,
  textarea::placeholder {
    color: color-mix(in oklch, var(--color-text) 40%, transparent);
  }

  input[type="text"]:disabled,
  textarea:disabled {
    opacity: 0.5;
  }

  .slug {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
  }

  .hint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    text-align: left;
  }

  .error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border: var(--size-px) solid var(--color-red);
    border-radius: var(--radius-2);
    color: var(--color-red);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
    text-align: left;
  }

  .submit-row {
    display: flex;
    justify-content: center;
    padding-block-start: var(--size-1);
  }
</style>

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

  const STANDARD_MEMORY = [
    { name: "notes", type: "short_term", strategy: "narrative" },
    { name: "memory", type: "long_term", strategy: "narrative" },
  ];

  async function handleSubmit(e: Event) {
    e.preventDefault();
    error = null;

    const trimmedName = name.trim();
    if (!trimmedName) {
      error = "Name is required";
      return;
    }

    loading = true;
    try {
      const config: Record<string, unknown> = {
        version: "1.0",
        workspace: {
          name: trimmedName,
          ...(description.trim() && { description: description.trim() }),
        },
        memory: { own: STANDARD_MEMORY },
      };

      const res = await client.workspace.create.$post({
        json: { config, workspaceName: trimmedName },
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
      placeholder="e.g. stock-monitor"
      bind:value={name}
      disabled={loading}
      required
    />
  </div>

  <div class="field">
    <label for="ws-description">Description</label>
    <input
      id="ws-description"
      type="text"
      placeholder="What does this workspace do?"
      bind:value={description}
      disabled={loading}
    />
  </div>

  <p class="hint">
    Creates a workspace with standard memory (notes, memory).
    You can add agents, jobs, and signals later.
  </p>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <Button type="submit" variant="primary" disabled={loading}>
    {loading ? "Creating..." : "Create"}
  </Button>
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
  }

  label {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    opacity: 0.7;
  }

  .required {
    color: var(--color-red);
  }

  input[type="text"] {
    background-color: var(--color-surface-2);
    block-size: var(--size-9);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: var(--color-text);
    font-size: var(--font-size-3);
    padding-inline: var(--size-3);
    transition: all 200ms ease;
  }

  input[type="text"]:focus {
    border-color: var(--color-accent);
    outline: none;
  }

  input[type="text"]::placeholder {
    color: color-mix(in oklch, var(--color-text) 50%, transparent);
  }

  input[type="text"]:disabled {
    opacity: 0.5;
  }

  .hint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    line-height: var(--line-height-3);
  }

  .error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border: var(--size-px) solid var(--color-red);
    border-radius: var(--radius-2);
    color: var(--color-red);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
  }
</style>

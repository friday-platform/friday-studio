<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { getDaemonClient } from "$lib/daemon-client";
  import { parse as parseYaml } from "yaml";

  interface Props {
    inline?: boolean;
    onclose?: () => void;
  }

  let { inline = false, onclose }: Props = $props();

  const client = getDaemonClient();
  const queryClient = useQueryClient();

  let dragOver = $state(false);
  let error = $state<string | null>(null);
  let loading = $state(false);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    error = null;

    const file = e.dataTransfer?.files[0];
    if (!file) return;

    if (!file.name.endsWith(".yml") && !file.name.endsWith(".yaml")) {
      error = "Please drop a .yml or .yaml file";
      return;
    }

    await loadFile(file);
  }

  async function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    error = null;
    await loadFile(file);
    input.value = "";
  }

  async function loadFile(file: File) {
    loading = true;
    try {
      const text = await file.text();
      const config: unknown = parseYaml(text);

      if (!config || typeof config !== "object") {
        error = "Invalid YAML: expected an object";
        return;
      }

      const name = (config as Record<string, unknown>).name;
      const workspaceName =
        typeof name === "string" ? name : file.name.replace(/\.(yml|yaml)$/, "");

      const res = await client.workspace.create.$post({
        json: { config: config as Record<string, unknown>, workspaceName },
      });

      if (!res.ok) {
        const body = await res.text();
        error = `Failed to create workspace: ${body}`;
        return;
      }

      const result: unknown = await res.json();
      const wsId =
        result && typeof result === "object" && "id" in result
          ? (result as { id: string }).id
          : null;

      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });

      onclose?.();

      if (wsId) {
        goto(`/platform/${wsId}`);
      } else {
        goto("/platform");
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to parse YAML";
    } finally {
      loading = false;
    }
  }
</script>

<div
  class="drop-zone"
  class:drag-over={dragOver}
  class:inline
  role="button"
  tabindex="0"
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <div class="drop-content">
    {#if loading}
      <p class="drop-label">Loading workspace...</p>
    {:else}
      <p class="drop-label">Drop workspace.yml here</p>
      <p class="drop-hint">or</p>
      <label class="browse-btn">
        Browse files
        <input type="file" accept=".yml,.yaml" hidden onchange={handleFileInput} />
      </label>
    {/if}

    {#if error}
      <p class="drop-error">{error}</p>
    {/if}
  </div>

  {#if !inline && onclose}
    <button type="button" class="close-btn" onclick={onclose}>Close</button>
  {/if}
</div>

<style>
  .drop-zone {
    align-items: center;
    border: 2px dashed var(--color-border-2);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    justify-content: center;
    min-block-size: 200px;
    padding: var(--size-10);
    transition:
      border-color 200ms ease,
      background-color 200ms ease;

    &.drag-over {
      background-color: color-mix(in srgb, var(--color-highlight-1), transparent 50%);
      border-color: var(--color-text);
    }

    &.inline {
      border: none;
      flex: 1;
      min-block-size: 0;
    }
  }

  .drop-content {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .drop-label {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
  }

  .drop-hint {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
  }

  .browse-btn {
    background-color: var(--color-surface-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-5);
    transition: background-color 100ms ease;

    &:hover {
      background-color: var(--color-highlight-1);
    }
  }

  .drop-error {
    background-color: color-mix(in srgb, var(--color-error), transparent 90%);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-2);
    max-inline-size: 400px;
    padding: var(--size-2) var(--size-4);
    text-align: center;
  }

  .close-btn {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    cursor: pointer;
    font-size: var(--font-size-2);

    &:hover {
      color: var(--color-text);
    }
  }
</style>

<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { getDaemonClient } from "$lib/daemon-client";
  import { workspaceQueries } from "$lib/queries";
  import { parse as parseYaml } from "yaml";
  import { z } from "zod";

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

  /**
   * Turn `POST /api/workspaces/create` error responses into short, user-facing
   * strings. Prefer the reference-validator's issue messages (with path for
   * locator context) because those are already human-authored and specific;
   * fall back to `error` / plain text only when the shape doesn't match.
   */
  const ValidationReportSchema = z.object({
    error: z.literal("validation_failed").optional(),
    report: z.object({
      issues: z.array(
        z.object({
          path: z.string().optional(),
          message: z.string(),
        }),
      ),
    }),
  });
  const PlainErrorSchema = z.object({ error: z.string() });

  async function formatCreateError(res: Response): Promise<string> {
    const raw = await res.text();
    try {
      const parsed: unknown = JSON.parse(raw);
      const report = ValidationReportSchema.safeParse(parsed);
      if (report.success) {
        const lines = report.data.report.issues.map((i) =>
          i.path ? `${i.path} — ${i.message}` : i.message,
        );
        return lines.join("\n");
      }
      const plain = PlainErrorSchema.safeParse(parsed);
      if (plain.success) return plain.data.error;
    } catch {
      // Non-JSON body — fall through.
    }
    return raw;
  }

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
        error = await formatCreateError(res);
        return;
      }

      const result: unknown = await res.json();
      const parsed = z.object({
        workspace: z.object({ id: z.string() }),
      }).passthrough().safeParse(result);

      if (!parsed.success) {
        console.warn("Workspace created but response shape unexpected:", parsed.error);
      }

      await queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });

      onclose?.();

      goto(`/platform/${parsed.success ? parsed.data.workspace.id : ""}`);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to parse YAML";
    } finally {
      loading = false;
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<label
  class="drop-zone"
  class:drag-over={dragOver}
  class:inline
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <div class="drop-content">
    {#if loading}
      <p class="drop-label">Loading workspace...</p>
    {:else}
      <p class="drop-label">Drop a workspace.yml here, or click to browse</p>
    {/if}

    {#if error}
      <p class="drop-error">{error}</p>
    {/if}
  </div>

  <input type="file" accept=".yml,.yaml" hidden onchange={handleFileInput} />

  {#if !inline && onclose}
    <button type="button" class="close-btn" onclick={onclose}>Close</button>
  {/if}
</label>

<style>
  .drop-zone {
    align-items: center;
    border: 1px dashed var(--color-border-2);
    border-radius: var(--radius-3);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    justify-content: center;
    min-block-size: 200px;
    padding: var(--size-10);
    transition:
      border-color 200ms ease,
      background-color 200ms ease;

    &:hover {
      border-color: color-mix(in srgb, var(--color-text), transparent 50%);
    }

    &.drag-over {
      background-color: color-mix(in srgb, var(--color-highlight-1), transparent 50%);
      border-color: var(--color-text);
    }

    &.inline {
      border-style: dashed;
      min-block-size: 0;
      padding: var(--size-8) var(--size-10);
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
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
  }

  .drop-error {
    background-color: color-mix(in srgb, var(--color-error), transparent 90%);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-2);
    max-inline-size: 400px;
    padding: var(--size-2) var(--size-4);
    text-align: left;
    white-space: pre-wrap;
  }

  .close-btn {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    cursor: pointer;
    font-size: var(--font-size-2);

    &:hover {
      color: var(--color-text);
    }
  }
</style>

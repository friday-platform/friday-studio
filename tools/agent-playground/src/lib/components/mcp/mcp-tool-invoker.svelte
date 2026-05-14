<!--
  MCP raw tool invoker — the "Test" surface for a server's detail page.

  Explicit, not conversational: pick a tool, fill its inputs (a form built
  from the tool's input schema), invoke it, and see the real output. An
  optional workspace selector runs the invocation against that workspace's
  merged server config so credentials and settings match.

  @component
-->

<script lang="ts">
  import { IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { mcpQueries, useInvokeMCPTool } from "$lib/queries/mcp-queries";
  import { workspaceQueries } from "$lib/queries";

  interface Props {
    serverId: string;
  }

  const { serverId }: Props = $props();

  // ── Tool list (shared cache with the Tools section) ────────────────────
  let loadRequested = $state(false);
  const probeQuery = createQuery(() => ({
    ...mcpQueries.toolsProbe(serverId),
    enabled: loadRequested,
  }));
  const probeResult = $derived(probeQuery.data);
  const tools = $derived(probeResult?.ok ? probeResult.tools : []);

  // ── Workspace context ──────────────────────────────────────────────────
  // An invocation always runs in a workspace context — the daemon route
  // requires it. Default to the first workspace once the list loads.
  const workspacesQuery = createQuery(() => workspaceQueries.list());
  const workspaces = $derived(workspacesQuery.data ?? []);
  let workspaceId = $state("");
  $effect(() => {
    if (!workspaceId && workspaces.length > 0) workspaceId = workspaces[0].id;
  });

  // ── Tool selection + args form ─────────────────────────────────────────
  let selectedToolName = $state("");
  const selectedTool = $derived(tools.find((t) => t.name === selectedToolName) ?? null);

  interface SchemaField {
    key: string;
    type: "string" | "number" | "boolean" | "json";
    description?: string;
    required: boolean;
  }

  /** Flatten the selected tool's input schema into a flat field list. */
  const fields = $derived.by((): SchemaField[] => {
    const schema = selectedTool?.inputSchema;
    if (!schema || typeof schema !== "object") return [];
    const props = (schema as { properties?: Record<string, unknown> }).properties;
    if (!props || typeof props !== "object") return [];
    const required = new Set(
      Array.isArray((schema as { required?: unknown }).required)
        ? ((schema as { required: unknown[] }).required.filter(
            (r) => typeof r === "string",
          ) as string[])
        : [],
    );
    return Object.entries(props).map(([key, raw]) => {
      const def = (raw ?? {}) as { type?: unknown; description?: unknown };
      const t = def.type;
      const type: SchemaField["type"] =
        t === "string"
          ? "string"
          : t === "number" || t === "integer"
            ? "number"
            : t === "boolean"
              ? "boolean"
              : "json";
      return {
        key,
        type,
        description: typeof def.description === "string" ? def.description : undefined,
        required: required.has(key),
      };
    });
  });

  // Raw string values per field, keyed by `${toolName}:${fieldKey}` so
  // switching tools doesn't bleed values across forms.
  let fieldValues = $state<Record<string, string>>({});
  let fieldBools = $state<Record<string, boolean>>({});

  function fieldKey(key: string): string {
    return `${selectedToolName}:${key}`;
  }

  /** Build the args object from the form, coercing per declared type. */
  function buildArgs(): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    const args: Record<string, unknown> = {};
    for (const field of fields) {
      const fk = fieldKey(field.key);
      if (field.type === "boolean") {
        if (fieldBools[fk] !== undefined) args[field.key] = fieldBools[fk];
        continue;
      }
      const raw = fieldValues[fk] ?? "";
      if (raw.trim() === "") {
        if (field.required) return { ok: false, error: `"${field.key}" is required` };
        continue;
      }
      if (field.type === "number") {
        const n = Number(raw);
        if (Number.isNaN(n)) return { ok: false, error: `"${field.key}" must be a number` };
        args[field.key] = n;
      } else if (field.type === "json") {
        try {
          args[field.key] = JSON.parse(raw);
        } catch {
          return { ok: false, error: `"${field.key}" must be valid JSON` };
        }
      } else {
        args[field.key] = raw;
      }
    }
    return { ok: true, args };
  }

  // ── Invocation ─────────────────────────────────────────────────────────
  const invokeMut = useInvokeMCPTool();
  let invokeError = $state<string | null>(null);
  let invokeOutput = $state<unknown>(undefined);
  let hasRun = $state(false);

  async function invoke(): Promise<void> {
    if (!selectedToolName || invokeMut.isPending) return;
    if (!workspaceId) {
      invokeError = "Pick a workspace context first.";
      return;
    }
    const built = buildArgs();
    if (!built.ok) {
      invokeError = built.error;
      return;
    }
    invokeError = null;
    invokeOutput = undefined;
    hasRun = true;
    try {
      const res = await invokeMut.mutateAsync({
        id: serverId,
        toolName: selectedToolName,
        args: built.args,
        workspaceId,
      });
      if (res.ok) {
        invokeOutput = res.output;
      } else {
        invokeError = res.error;
      }
    } catch (e) {
      invokeError = e instanceof Error ? e.message : String(e);
    }
  }

  /** Render the output: MCP tools usually return `{ content: [{type,text}] }`. */
  const outputText = $derived.by((): string => {
    const out = invokeOutput;
    if (out && typeof out === "object" && "content" in out) {
      const content = (out as { content: unknown }).content;
      if (Array.isArray(content)) {
        const texts = content
          .map((c) =>
            c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
              ? (c as { text: string }).text
              : null,
          )
          .filter((t): t is string => t !== null);
        if (texts.length > 0) return texts.join("\n");
      }
    }
    return JSON.stringify(out, null, 2);
  });
</script>

<div class="invoker">
  {#if !loadRequested}
    <div class="load-prompt">
      <p class="load-hint">
        Pick a tool, fill its inputs, and invoke it directly to see the real output. Loading the
        tool list opens a connection to the server.
      </p>
      <button type="button" class="load-btn" onclick={() => (loadRequested = true)}>
        Load tools
      </button>
    </div>
  {:else if probeQuery.isLoading || probeQuery.isFetching}
    <p class="status-line">
      <span class="spinner"><IconSmall.Progress /></span>
      Connecting to the server…
    </p>
  {:else if probeQuery.isError}
    <div class="error-box" role="alert">
      <p>Couldn't load tools: {probeQuery.error?.message ?? "unknown error"}</p>
      <button type="button" class="retry-btn" onclick={() => probeQuery.refetch()}>Retry</button>
    </div>
  {:else if probeResult && !probeResult.ok}
    <div class="error-box" role="alert">
      <p>{probeResult.error}</p>
      <button type="button" class="retry-btn" onclick={() => probeQuery.refetch()}>
        {probeResult.retryable ? "Try again" : "Retry"}
      </button>
    </div>
  {:else if tools.length === 0}
    <p class="status-line muted">This server exposes no tools to invoke.</p>
  {:else}
    <div class="controls">
      <label class="control">
        <span class="control-label">Tool</span>
        <select class="control-input" bind:value={selectedToolName}>
          <option value="">Select a tool…</option>
          {#each tools as tool (tool.name)}
            <option value={tool.name}>{tool.name}</option>
          {/each}
        </select>
      </label>

      <label class="control">
        <span class="control-label">Workspace context</span>
        <select class="control-input" bind:value={workspaceId}>
          {#if workspaces.length === 0}
            <option value="">No workspaces</option>
          {/if}
          {#each workspaces as ws (ws.id)}
            <option value={ws.id}>{ws.name}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if selectedTool}
      {#if selectedTool.description}
        <p class="tool-desc">{selectedTool.description}</p>
      {/if}

      {#if fields.length === 0}
        <p class="status-line muted">This tool takes no inputs.</p>
      {:else}
        <div class="arg-form">
          {#each fields as field (field.key)}
            <div class="arg-field">
              <div class="arg-label-row">
                <code class="arg-key">{field.key}</code>
                {#if field.required}<span class="arg-required">required</span>{/if}
                <span class="arg-type">{field.type === "json" ? "json" : field.type}</span>
              </div>
              {#if field.description}
                <p class="arg-desc">{field.description}</p>
              {/if}
              {#if field.type === "boolean"}
                <label class="arg-bool">
                  <input type="checkbox" bind:checked={fieldBools[fieldKey(field.key)]} />
                  <span>{fieldBools[fieldKey(field.key)] ? "true" : "false"}</span>
                </label>
              {:else if field.type === "json"}
                <textarea
                  class="arg-input mono"
                  rows="2"
                  placeholder="JSON value"
                  bind:value={fieldValues[fieldKey(field.key)]}
                ></textarea>
              {:else}
                <input
                  class="arg-input mono"
                  type={field.type === "number" ? "number" : "text"}
                  bind:value={fieldValues[fieldKey(field.key)]}
                />
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <div class="invoke-row">
        <button
          type="button"
          class="invoke-btn"
          onclick={invoke}
          disabled={invokeMut.isPending}
        >
          {invokeMut.isPending ? "Invoking…" : "Invoke tool"}
        </button>
      </div>
    {/if}

    {#if invokeError}
      <div class="error-box" role="alert">
        <p>{invokeError}</p>
      </div>
    {:else if hasRun && !invokeMut.isPending}
      <div class="output">
        <span class="output-label">Output</span>
        <pre class="output-block">{outputText}</pre>
      </div>
    {/if}
  {/if}
</div>

<style>
  .invoker {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .load-prompt {
    align-items: flex-start;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .load-hint {
    color: var(--text);
    font-size: var(--font-size-3);
    margin: 0;
    max-inline-size: 64ch;
  }

  .load-btn,
  .invoke-btn {
    background-color: var(--surface-bright);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-2);
    color: var(--text-bright);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    padding: var(--size-1-5) var(--size-3);
  }

  .load-btn:hover,
  .invoke-btn:hover:not(:disabled) {
    background-color: var(--highlight);
  }

  .invoke-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .status-line {
    align-items: center;
    color: var(--text);
    display: flex;
    font-size: var(--font-size-3);
    gap: var(--size-1-5);
    margin: 0;
  }

  .status-line.muted {
    color: var(--text);
  }

  .spinner {
    align-items: center;
    display: inline-flex;
  }

  .spinner :global(svg) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
  }

  .control {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-1);
    min-inline-size: 16ch;
  }

  .control-label,
  .output-label {
    color: var(--text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .control-input {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    font: inherit;
    font-size: var(--font-size-3);
    padding: var(--size-1-5) var(--size-2);
  }

  .tool-desc {
    color: var(--text);
    font-size: var(--font-size-3);
    margin: 0;
  }

  .arg-form {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .arg-field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .arg-label-row {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .arg-key {
    color: var(--text-bright);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .arg-required {
    color: var(--yellow-primary);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .arg-type {
    color: var(--text);
    font-size: var(--font-size-2);
  }

  .arg-desc {
    color: var(--text);
    font-size: var(--font-size-2);
    margin: 0;
  }

  .arg-input {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    font: inherit;
    font-size: var(--font-size-3);
    padding: var(--size-1-5) var(--size-2);
  }

  .arg-input.mono {
    font-family: var(--font-family-monospace);
  }

  textarea.arg-input {
    resize: vertical;
  }

  .arg-bool {
    align-items: center;
    color: var(--text);
    display: flex;
    font-size: var(--font-size-3);
    gap: var(--size-1-5);
  }

  .invoke-row {
    display: flex;
  }

  .error-box {
    background-color: color-mix(in srgb, var(--red-primary), transparent 92%);
    border: 1px solid color-mix(in srgb, var(--red-primary), transparent 70%);
    border-radius: var(--radius-2);
    color: var(--text);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-3);
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .error-box p {
    margin: 0;
  }

  .retry-btn {
    align-self: flex-start;
    background: none;
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-1);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-2);
    padding: var(--size-0-5) var(--size-2);
  }

  .output {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .output-block {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    margin: 0;
    max-block-size: 24rem;
    overflow: auto;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>

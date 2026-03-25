<!--
  Agent editing surface for the right sidebar.

  Shows prompt textarea (blur-to-save) and model picker (save-on-change)
  for the selected agent step node. Bundled agents show prompt only;
  inline LLMs show prompt + model. When the step's entry actions include
  an outputType, a read-only "Produces" section shows the document type
  name and schema fields.

  @component
  @param {import("@atlas/config").TopologyNode} node - Selected agent step node
  @param {string} workspaceId - Active workspace ID
  @param {import("@atlas/config").WorkspaceConfig | null} config - Workspace config for schema lookup
-->

<script lang="ts">
  import type { TopologyNode, WorkspaceConfig } from "@atlas/config";
  import { deriveAllEntryActions } from "@atlas/config/entry-actions";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { getDaemonClient } from "$lib/daemon-client";
  import { z } from "zod";

  type Props = { node: TopologyNode; workspaceId: string; config: WorkspaceConfig | null };

  let { node, workspaceId, config }: Props = $props();

  const queryClient = useQueryClient();
  const client = getDaemonClient();

  const agentType = $derived(node.metadata.type === "agent" ? "agent" : "llm");
  const agentId = $derived(node.id);
  const isLLM = $derived(agentType === "llm");

  let prompt = $derived(typeof node.metadata.prompt === "string" ? node.metadata.prompt : "");
  let model = $derived(typeof node.metadata.model === "string" ? node.metadata.model : "");
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  // Clear stale errors when switching nodes
  $effect(() => {
    void node.id;
    saveError = null;
  });

  // ---------------------------------------------------------------------------
  // Produces — output document type and schema from entry actions
  // ---------------------------------------------------------------------------

  interface SchemaField {
    name: string;
    type: string;
    description?: string;
  }

  /** Find the first outputType from this node's entry actions. */
  const outputType = $derived.by((): string | null => {
    if (!config) return null;
    const actionsMap = deriveAllEntryActions(config);
    const actions = actionsMap.get(node.id);
    if (!actions) return null;
    for (const action of actions) {
      if (action.outputType) return action.outputType;
    }
    return null;
  });

  /** Look up the JSON Schema from fsm.documentTypes for the outputType. */
  const schemaFields = $derived.by((): SchemaField[] => {
    if (!outputType || !config?.jobs || !node.jobId) return [];

    const job = config.jobs[node.jobId];
    if (!job) return [];

    // job.fsm is z.any() in JobSpecificationSchema — navigate defensively
    const schema = job.fsm?.documentTypes?.[outputType];
    if (!schema || typeof schema !== "object") return [];

    const props: Record<string, Record<string, unknown>> | undefined = schema.properties;
    if (!props) return [];

    return Object.entries(props).map(([name, prop]) => ({
      name,
      type: typeof prop.type === "string" ? prop.type : "unknown",
      ...(typeof prop.description === "string" ? { description: prop.description } : {}),
    }));
  });

  async function saveAgent(updates: Record<string, unknown>) {
    saving = true;
    saveError = null;
    try {
      const configClient = client.workspaceConfig(workspaceId);
      const body = isLLM
        ? { type: "llm" as const, ...updates }
        : { type: "agent" as const, ...updates };

      const res = await configClient.agents[":agentId"].$put({ param: { agentId }, json: body });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        const parsed = z.object({ error: z.string() }).safeParse(err);
        saveError = parsed.success ? parsed.data.error : "Save failed";
        return;
      }

      // Invalidate config cache so diagram and sidebar refetch
      queryClient.invalidateQueries({ queryKey: ["daemon", "workspace", workspaceId, "config"] });
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Save failed";
    } finally {
      saving = false;
    }
  }

  function handlePromptBlur() {
    const current = typeof node.metadata.prompt === "string" ? node.metadata.prompt : "";
    if (prompt !== current) {
      saveAgent({ prompt });
    }
  }

  function handleModelChange() {
    const current = typeof node.metadata.model === "string" ? node.metadata.model : "";
    if (model !== current) {
      saveAgent({ model });
    }
  }
</script>

<div class="agent-editor">
  <div class="section">
    <h3 class="section-title">{isLLM ? "LLM" : "Agent"}</h3>
    <p class="agent-id">{node.metadata.agentId ?? node.label}</p>
  </div>

  {#if isLLM}
    <div class="section">
      <label class="field-label" for="agent-model">Model</label>
      <input
        id="agent-model"
        class="model-input"
        type="text"
        bind:value={model}
        onchange={handleModelChange}
        placeholder="e.g. claude-sonnet-4-20250514"
        disabled={saving}
      />
    </div>
  {/if}

  <div class="section">
    <label class="field-label" for="agent-prompt">Prompt</label>
    <textarea
      id="agent-prompt"
      class="prompt-textarea"
      bind:value={prompt}
      onblur={handlePromptBlur}
      placeholder="Agent system prompt..."
      disabled={saving}
      rows="12"
    ></textarea>
  </div>

  {#if saving}
    <p class="save-status">Saving...</p>
  {/if}

  {#if saveError}
    <p class="save-error">{saveError}</p>
  {/if}

  {#if outputType}
    <div class="section">
      <h3 class="section-title">Produces</h3>
      <p class="output-type">{outputType}</p>
      {#if schemaFields.length > 0}
        <div class="schema-fields">
          {#each schemaFields as field}
            <div class="schema-field">
              <span class="field-name">{field.name}</span>
              <span class="field-type">{field.type}</span>
              {#if field.description}
                <p class="field-description">{field.description}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .agent-editor {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-title {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .agent-id {
    color: var(--color-text);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    word-break: break-all;
  }

  .field-label {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .model-input {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
    transition: border-color 150ms ease;
  }

  .model-input:focus {
    border-color: var(--color-info);
    outline: none;
  }

  .prompt-textarea {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: 1.5;
    min-block-size: 200px;
    padding: var(--size-3);
    resize: vertical;
    transition: border-color 150ms ease;
  }

  .prompt-textarea:focus {
    border-color: var(--color-info);
    outline: none;
  }

  .save-status {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .save-error {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }

  .output-type {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .schema-fields {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .schema-field {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--size-2);
  }

  .field-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .field-type {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .field-description {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-basis: 100%;
    font-size: var(--font-size-1);
    line-height: 1.4;
    margin: 0;
  }
</style>

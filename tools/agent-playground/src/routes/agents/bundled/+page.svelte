<script lang="ts">
  import { Button } from "@atlas/ui";
  import { getClient, type Client } from "$lib/client.ts";
  import AgentSelector from "$lib/components/agent-selector.svelte";
  import EnvEditor from "$lib/components/env-editor.svelte";
  import ExecutionStream from "$lib/components/execution-stream.svelte";
  import TracePanel from "$lib/components/trace-panel.svelte";
  import type { DoneStats } from "$lib/server/lib/sse.ts";
  import type { InferResponseType } from "hono/client";

  type AgentsEndpoint = Client["api"]["agents"]["$get"];
  type AgentsResponse = InferResponseType<AgentsEndpoint>;
  type AgentMetadata = AgentsResponse["agents"][number];

  type SSEEvent =
    | { type: "progress"; data: { type: string; [key: string]: unknown } }
    | { type: "log"; data: { level: string; message: string; [key: string]: unknown } }
    | {
        type: "trace";
        data: { spanId: string; name: string; durationMs: number; [key: string]: unknown };
      }
    | { type: "result"; data: unknown }
    | { type: "done"; data: { durationMs: number; totalTokens?: number; stepCount?: number } }
    | { type: "error"; data: { error: string } };

  let selectedAgent = $state<AgentMetadata | null>(null);
  let input = $state("");
  let env = $state<Record<string, string>>({});
  let events = $state<SSEEvent[]>([]);
  let executing = $state(false);
  let cancelled = $state(false);
  let activeReader = $state<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const canExecute = $derived(selectedAgent !== null && input.trim().length > 0 && !executing);

  /** Trace entries extracted from SSE events. */
  const traces = $derived(
    events.filter((e): e is SSEEvent & { type: "trace" } => e.type === "trace").map((e) => e.data),
  );

  /** Done stats from the completed execution, or null while running. */
  const doneStats = $derived<DoneStats | null>(
    events.find((e): e is SSEEvent & { type: "done" } => e.type === "done")?.data ?? null,
  );

  function handleExampleClick(example: string) {
    input = example;
  }

  /** Cancel the active SSE stream. Triggers server-side abort via stream close. */
  function cancel() {
    if (!activeReader) return;
    cancelled = true;
    activeReader.cancel();
    activeReader = null;
  }

  /**
   * Parse SSE text stream into typed events.
   * Handles `event:` / `data:` line protocol with `\n\n` delimiters.
   */
  function parseSSEStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    activeReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const segments = buffer.split("\n\n");
          buffer = segments.pop() ?? "";

          for (const segment of segments) {
            const lines = segment.split("\n");
            let eventType = "";
            let eventData = "";

            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                eventData = line.slice(6);
              }
            }

            if (eventType && eventData) {
              try {
                const parsed = JSON.parse(eventData);
                events = [...events, { type: eventType, data: parsed } as SSEEvent];
              } catch {
                console.warn("Failed to parse SSE data:", eventData);
              }
            }
          }
        }
      } catch {
        if (!cancelled) {
          events = [...events, { type: "error", data: { error: "Connection lost" } }];
        }
      } finally {
        activeReader = null;
        executing = false;
      }
    })();
  }

  /** Execute the selected bundled agent. */
  async function execute() {
    if (!selectedAgent || !input.trim()) return;

    if (activeReader) {
      activeReader.cancel();
      activeReader = null;
    }
    events = [];
    executing = true;
    cancelled = false;

    try {
      const res = await getClient().api.execute.$post({
        json: {
          agentId: selectedAgent.id,
          input: input.trim(),
          env: Object.keys(env).length > 0 ? env : undefined,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        events = [{ type: "error", data: { error: `HTTP ${res.status}: ${text}` } }];
        executing = false;
        return;
      }
      if (!res.body) {
        events = [{ type: "error", data: { error: "No response body" } }];
        executing = false;
        return;
      }

      parseSSEStream(res.body);
    } catch {
      if (!cancelled) {
        events = [...events, { type: "error", data: { error: "Connection lost" } }];
      }
      executing = false;
    }
  }
</script>

<div class="shell">
  <aside class="config-panel">
    <header class="panel-header">
      <h1>Friday Agents</h1>
    </header>

    <div class="config-content">
      <AgentSelector
        onSelect={(agent) => {
          selectedAgent = agent;
        }}
        onExampleClick={handleExampleClick}
      />

      {#if selectedAgent}
        <div class="config-section">
          <label class="section-label" for="prompt-input">Prompt</label>
          <textarea
            id="prompt-input"
            class="prompt-textarea"
            bind:value={input}
            placeholder="Enter your prompt..."
            rows="4"
            onkeydown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canExecute) {
                execute();
              }
            }}
          ></textarea>
        </div>

        {#if (selectedAgent.requiredConfig?.length ?? 0) > 0 || (selectedAgent.optionalConfig?.length ?? 0) > 0}
          <div class="config-section">
            <span class="section-label">Environment</span>
            <EnvEditor
              requiredConfig={selectedAgent.requiredConfig}
              optionalConfig={selectedAgent.optionalConfig}
              onEnvChange={(newEnv) => {
                env = newEnv;
              }}
            />
          </div>
        {/if}

        {#if executing}
          <Button variant="secondary" onclick={cancel}>Cancel</Button>
        {:else}
          <Button variant="primary" disabled={!canExecute} onclick={execute}>Execute</Button>
        {/if}
      {/if}
    </div>
  </aside>

  <main class="output-panel">
    <section class="output-stream">
      <h2>Output</h2>
      <ExecutionStream {events} {executing} {cancelled} />
    </section>

    {#if doneStats || traces.length > 0}
      <section class="output-stats">
        <h2>Stats</h2>
        <TracePanel {traces} stats={doneStats} />
      </section>
    {/if}
  </main>
</div>

<style>
  .config-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-5);
    overflow-y: auto;
    padding-block: var(--size-4);
    padding-inline: var(--size-5);
  }

  .config-panel {
    background-color: var(--color-surface-1);
    border-inline-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    inline-size: 360px;
    overflow: hidden;
  }

  .config-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .output-panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    overflow: hidden;
  }

  .output-stats {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-3);
    max-block-size: 40%;
    overflow-y: auto;
    padding-block: var(--size-3);
    padding-inline: var(--size-5);
  }

  .output-stream {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-3);
    min-block-size: 0;
    overflow-y: auto;
    padding-block: var(--size-4);
    padding-inline: var(--size-5);
  }

  .panel-header {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    padding-block: var(--size-4);
    padding-inline: var(--size-5);

    h1 {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-6);
    }
  }

  .prompt-textarea {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-3);
    inline-size: 100%;
    line-height: var(--font-lineheight-3);
    padding: var(--size-2-5);
    resize: vertical;
  }

  .prompt-textarea:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    outline: none;
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .shell {
    block-size: 100%;
    display: flex;
    flex-direction: row;
    overflow: hidden;
  }

  h2 {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }
</style>

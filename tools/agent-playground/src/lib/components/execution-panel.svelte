<script lang="ts">
  /**
   * Execution panel for workspace FSM execution.
   *
   * Provides a mock/real mode toggle, run/cancel buttons, and streams SSE
   * execution output. Captures the execution report for downstream panels
   * (FSM state diagram, results accumulator, action trace).
   *
   * Requires a `prompt` prop (from the generate flow). The panel calls
   * `POST /api/workspace/execute` with the prompt and selected mode.
   */
  import { Button } from "@atlas/ui";
  import { getClient } from "$lib/client.ts";
  import ExecutionStream from "./execution-stream.svelte";

  type ExecutionMode = "mock" | "real";

  /** SSE event types matching the workspace execute endpoint. */
  type StreamEvent =
    | { type: "progress"; data: { type: string; [key: string]: unknown } }
    | { type: "log"; data: { level: string; message: string; [key: string]: unknown } }
    | {
        type: "trace";
        data: { spanId: string; name: string; durationMs: number; [key: string]: unknown };
      }
    | { type: "result"; data: unknown }
    | { type: "done"; data: { durationMs: number; totalTokens?: number; stepCount?: number } }
    | { type: "error"; data: { error: string } };

  type SSEEvent = StreamEvent | { type: "artifact"; data: { name: string; content: string } };

  /** Execution report shape from the server. */
  type ExecutionReport = {
    success: boolean;
    finalState: string;
    stateTransitions: Array<{ from: string; to: string; signal: string; timestamp: number }>;
    resultSnapshots: Record<string, Record<string, Record<string, unknown>>>;
    actionTrace: Array<{
      state: string;
      actionType: string;
      actionId?: string;
      input?: { task?: string; config?: Record<string, unknown> };
      status: "started" | "completed" | "failed";
      error?: string;
    }>;
    assertions: Array<{ check: string; passed: boolean; detail?: string }>;
    error?: string;
    durationMs: number;
  };

  type Props = {
    /** The generation prompt used to create this workspace. */
    prompt: string;
    /** Called when execution completes with the execution report. */
    onreport?: (reports: ExecutionReport[]) => void;
  };

  let { prompt, onreport }: Props = $props();

  let executionMode = $state<ExecutionMode>("mock");
  let events = $state<SSEEvent[]>([]);
  let executing = $state(false);
  let cancelled = $state(false);
  let activeReader = $state<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const canRun = $derived(prompt.trim().length > 0 && !executing);

  /** Events compatible with ExecutionStream (filters out workspace-only types). */
  const streamEvents = $derived(events.filter((e): e is StreamEvent => e.type !== "artifact"));

  /** Extract execution report from artifact events when execution completes. */
  $effect(() => {
    const doneEvent = events.find((e) => e.type === "done");
    if (!doneEvent) return;

    const reportArtifact = events.find(
      (e): e is SSEEvent & { type: "artifact" } =>
        e.type === "artifact" && e.data.name === "execution-report",
    );
    if (reportArtifact && onreport) {
      try {
        const reports = JSON.parse(reportArtifact.data.content) as ExecutionReport[];
        onreport(reports);
      } catch {
        // Report parsing failed — not fatal
      }
    }
  });

  /** Parse SSE text stream into typed events. */
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

  /** Run workspace execution with the selected mode. */
  async function run() {
    if (!prompt.trim()) return;

    if (activeReader) {
      activeReader.cancel();
      activeReader = null;
    }
    events = [];
    executing = true;
    cancelled = false;

    try {
      const res = await getClient().api.workspace.execute.$post({
        json: { prompt: prompt.trim(), real: executionMode === "real" },
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

  /** Cancel in-progress execution. */
  function cancel() {
    if (!activeReader) return;
    cancelled = true;
    activeReader.cancel();
    activeReader = null;
  }
</script>

<div class="execution-panel">
  <div class="controls">
    <div class="mode-toggle">
      <button
        class="mode-option"
        class:active={executionMode === "mock"}
        onclick={() => {
          executionMode = "mock";
        }}
        disabled={executing}
      >
        Mock
      </button>
      <button
        class="mode-option"
        class:active={executionMode === "real"}
        onclick={() => {
          executionMode = "real";
        }}
        disabled={executing}
      >
        Real
      </button>
    </div>

    {#if executing}
      <Button variant="secondary" onclick={cancel}>Cancel</Button>
    {:else}
      <Button variant="primary" disabled={!canRun} onclick={run}>Run</Button>
    {/if}
  </div>

  {#if events.length > 0 || executing}
    <div class="stream-container">
      <ExecutionStream events={streamEvents} {executing} {cancelled} />
    </div>
  {:else}
    <div class="empty">Click Run to execute the workspace FSMs.</div>
  {/if}
</div>

<style>
  .controls {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
    padding-block: var(--size-4);
  }

  .execution-panel {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .mode-option {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-2-5);
    block-size: var(--size-6);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    padding-inline: var(--size-2);
    transition: all 150ms ease;
  }

  .mode-option:hover:not(.active):not(:disabled) {
    border-color: var(--color-border-1);
  }

  .mode-option.active {
    border-color: var(--color-border-1);
    color: var(--color-text);
  }

  .mode-option:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .mode-toggle {
    display: flex;
    gap: var(--size-1);
  }

  .stream-container {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    max-block-size: 400px;
    overflow-y: auto;
    padding: var(--size-3);
  }
</style>

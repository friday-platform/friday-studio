/**
 * Reactive execution context for workspace FSM execution.
 *
 * Encapsulates the execution lifecycle (SSE streaming, report parsing,
 * stepper state) as a class-based Svelte 5 reactive controller. Provided
 * via Svelte context so multiple child components (prompt bar, drawer,
 * FSM diagram, state cards) can share a single source of truth.
 *
 * @module
 */
import { getContext, setContext } from "svelte";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** SSE event types matching the workspace execute endpoint. */
export type StreamEvent =
  | { type: "progress"; data: { type: string; [key: string]: unknown } }
  | { type: "log"; data: { level: string; message: string; [key: string]: unknown } }
  | {
      type: "trace";
      data: { spanId: string; name: string; durationMs: number; [key: string]: unknown };
    }
  | { type: "result"; data: unknown }
  | { type: "done"; data: { durationMs: number; totalTokens?: number; stepCount?: number } }
  | { type: "error"; data: { error: string } };

export type SSEEvent = StreamEvent | { type: "artifact"; data: { name: string; content: string } };

/** Zod schema for a single SSE event from the wire. */
const SSEEventSchema = z.union([
  z.object({ type: z.literal("progress"), data: z.object({ type: z.string() }).passthrough() }),
  z.object({
    type: z.literal("log"),
    data: z.object({ level: z.string(), message: z.string() }).passthrough(),
  }),
  z.object({
    type: z.literal("trace"),
    data: z.object({ spanId: z.string(), name: z.string(), durationMs: z.number() }).passthrough(),
  }),
  z.object({ type: z.literal("result"), data: z.unknown() }),
  z.object({
    type: z.literal("done"),
    data: z.object({
      durationMs: z.number(),
      totalTokens: z.number().optional(),
      stepCount: z.number().optional(),
    }),
  }),
  z.object({ type: z.literal("error"), data: z.object({ error: z.string() }) }),
  z.object({
    type: z.literal("artifact"),
    data: z.object({ name: z.string(), content: z.string() }),
  }),
]);

export type StateTransition = { from: string; to: string; signal: string; timestamp: number };

// ---------------------------------------------------------------------------
// Execution report Zod schema
// ---------------------------------------------------------------------------

const StateTransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  signal: z.string(),
  timestamp: z.number(),
});

const ExecutionReportSchema = z.object({
  success: z.boolean(),
  finalState: z.string(),
  stateTransitions: z.array(StateTransitionSchema),
  resultSnapshots: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))),
  actionTrace: z.array(
    z.object({
      state: z.string(),
      actionType: z.string(),
      actionId: z.string().optional(),
      input: z
        .object({
          task: z.string().optional(),
          config: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
      status: z.enum(["started", "completed", "failed"]),
      error: z.string().optional(),
    }),
  ),
  assertions: z.array(
    z.object({ check: z.string(), passed: z.boolean(), detail: z.string().optional() }),
  ),
  error: z.string().optional(),
  durationMs: z.number(),
});

export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;

/** A single action trace entry. */
export type ActionEntry = ExecutionReport["actionTrace"][number];

/** Result snapshots keyed by state name. */
export type ResultSnapshots = Record<string, Record<string, Record<string, unknown>>>;

const ExecutionReportsSchema = z.array(ExecutionReportSchema);

export type ExecutionStatus = "idle" | "running" | "complete" | "error";

// ---------------------------------------------------------------------------
// Context key
// ---------------------------------------------------------------------------

const EXECUTION_CTX = "__execution_state";

// ---------------------------------------------------------------------------
// ExecutionState class
// ---------------------------------------------------------------------------

/**
 * Reactive execution state controller.
 *
 * All `$state` fields are reactive and can be read in Svelte templates or
 * `$derived`/`$effect` blocks. The class owns the SSE stream lifecycle,
 * report extraction, and stepper position.
 */
class ExecutionState {
  // --- Reactive fields ---
  status = $state<ExecutionStatus>("idle");
  events = $state<SSEEvent[]>([]);
  report = $state<ExecutionReport | null>(null);
  stepIndex = $state(-1);
  error = $state<string | null>(null);
  drawerOpen = $state(false);

  /**
   * Live transitions accumulated from SSE progress events during execution.
   * Replaced by report transitions once the execution-report artifact arrives.
   */
  liveTransitions = $state<StateTransition[]>([]);

  /** Live action trace accumulated from SSE action-execution events. */
  liveActions = $state<ActionEntry[]>([]);

  /** Live result snapshots extracted from enriched transition events. */
  liveResultSnapshots = $state<ResultSnapshots>({});

  // --- Internal ---
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #cancelled = false;

  // --- Derived getters ---

  get isRunning(): boolean {
    return this.status === "running";
  }

  get isComplete(): boolean {
    return this.status === "complete";
  }

  /** State transitions — live during execution, from report after completion. */
  get transitions(): StateTransition[] {
    return this.report?.stateTransitions ?? this.liveTransitions;
  }

  /** Ordered list of states visited (by transition target). */
  get stateOrder(): string[] {
    return this.transitions.map((t) => t.to);
  }

  /** The currently active state based on stepper position. */
  get activeState(): string | null {
    if (this.transitions.length === 0) return null;
    if (this.stepIndex < 0) return null;
    const t = this.transitions[this.stepIndex];
    return t ? t.to : null;
  }

  /** Set of states visited up to (and including) the current step. */
  get visitedStates(): Set<string> {
    const visited = new Set<string>();
    for (let i = 0; i <= this.stepIndex; i++) {
      const t = this.transitions[i];
      if (t) {
        visited.add(t.from);
        visited.add(t.to);
      }
    }
    return visited;
  }

  /** Action trace — from report after completion, live during execution. */
  get actionTrace(): ActionEntry[] {
    return this.report?.actionTrace ?? this.liveActions;
  }

  /** Result snapshots — from report after completion, live during execution. */
  get resultSnapshots(): ResultSnapshots {
    return this.report?.resultSnapshots ?? this.liveResultSnapshots;
  }

  // --- Action methods ---

  /**
   * Start SSE execution. The `endpoint` callback should return the fetch
   * Response (e.g. from a Hono RPC call). The class handles streaming,
   * event accumulation, report extraction, and status transitions.
   *
   * @param endpoint - Async function that initiates the HTTP request
   */
  async execute(endpoint: () => Promise<Response>): Promise<void> {
    this.#abort();
    this.events = [];
    this.report = null;
    this.liveTransitions = [];
    this.liveActions = [];
    this.liveResultSnapshots = {};
    this.stepIndex = -1;
    this.error = null;
    this.status = "running";
    this.drawerOpen = true;
    this.#cancelled = false;

    try {
      const res = await endpoint();

      if (!res.ok) {
        const text = await res.text();
        this.error = `HTTP ${res.status}: ${text}`;
        this.status = "error";
        return;
      }

      if (!res.body) {
        this.error = "No response body";
        this.status = "error";
        return;
      }

      await this.#parseSSEStream(res.body);
    } catch {
      if (!this.#cancelled) {
        this.error = "Connection lost";
        this.status = "error";
      }
    }
  }

  /** Cancel in-progress execution. */
  cancel(): void {
    this.#cancelled = true;
    this.#abort();
    if (this.status === "running") {
      this.status = "idle";
    }
  }

  /** Reset to initial idle state. */
  reset(): void {
    this.#abort();
    this.events = [];
    this.report = null;
    this.liveTransitions = [];
    this.liveActions = [];
    this.liveResultSnapshots = {};
    this.stepIndex = -1;
    this.error = null;
    this.status = "idle";
    this.drawerOpen = false;
    this.#cancelled = false;
  }

  // --- Stepper methods ---

  stepNext(): void {
    if (this.stepIndex < this.transitions.length - 1) {
      this.stepIndex += 1;
    }
  }

  stepPrev(): void {
    if (this.stepIndex > -1) {
      this.stepIndex -= 1;
    }
  }

  stepReset(): void {
    this.stepIndex = -1;
  }

  stepToEnd(): void {
    if (this.transitions.length > 0) {
      this.stepIndex = this.transitions.length - 1;
    }
  }

  // --- Internal helpers ---

  #abort(): void {
    if (this.#reader) {
      this.#reader.cancel();
      this.#reader = null;
    }
  }

  /**
   * Parse an SSE text stream into typed events. Handles the `event:`/`data:`
   * line protocol with `\n\n` delimiters.
   *
   * Extracts the execution report from the `execution-report` artifact event
   * and transitions status to `complete` or `error` when the stream ends.
   */
  async #parseSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    this.#reader = reader;
    const decoder = new TextDecoder();
    let buffer = "";

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
              const parsed: unknown = JSON.parse(eventData);
              const result = SSEEventSchema.safeParse({ type: eventType, data: parsed });
              if (!result.success) continue;
              const event = result.data;
              this.events = [...this.events, event];

              // Accumulate live transitions from progress events
              if (
                event.type === "progress" &&
                event.data.type === "state-transition" &&
                typeof event.data["from"] === "string" &&
                typeof event.data["to"] === "string" &&
                typeof event.data["signal"] === "string" &&
                typeof event.data["timestamp"] === "number"
              ) {
                const transition: StateTransition = {
                  from: event.data["from"] as string,
                  to: event.data["to"] as string,
                  signal: event.data["signal"] as string,
                  timestamp: event.data["timestamp"] as number,
                };
                this.liveTransitions = [...this.liveTransitions, transition];
                this.stepIndex = this.liveTransitions.length - 1;

                // Extract enriched resultSnapshot from transition event
                const snapshot = event.data["resultSnapshot"];
                if (snapshot && typeof snapshot === "object") {
                  this.liveResultSnapshots = {
                    ...this.liveResultSnapshots,
                    [transition.to]: snapshot as Record<string, Record<string, unknown>>,
                  };
                }
              }

              // Accumulate live actions from action-execution events
              if (
                event.type === "progress" &&
                event.data.type === "action-execution" &&
                typeof event.data["state"] === "string" &&
                typeof event.data["actionType"] === "string" &&
                typeof event.data["status"] === "string"
              ) {
                const action: ActionEntry = {
                  state: event.data["state"] as string,
                  actionType: event.data["actionType"] as string,
                  actionId: event.data["actionId"] as string | undefined,
                  input: event.data["input"] as ActionEntry["input"],
                  status: event.data["status"] as ActionEntry["status"],
                  error: event.data["error"] as string | undefined,
                };
                this.liveActions = [...this.liveActions, action];
              }

              // Extract report from artifact
              if (event.type === "artifact" && event.data.name === "execution-report") {
                try {
                  const raw: unknown = JSON.parse(event.data.content);
                  const reports = ExecutionReportsSchema.parse(raw);
                  if (reports[0]) {
                    this.report = reports[0];
                    this.stepIndex = this.report.stateTransitions.length - 1;
                  }
                } catch {
                  // Report parsing failed — not fatal
                }
              }
            } catch {
              console.warn("Failed to parse SSE data:", eventData);
            }
          }
        }
      }

      // Stream ended naturally
      if (!this.#cancelled) {
        const hasError = this.events.some((e) => e.type === "error");
        this.status = hasError ? "error" : "complete";
        if (hasError) {
          const errorEvent = this.events.find((e) => e.type === "error");
          if (errorEvent && errorEvent.type === "error") {
            this.error = errorEvent.data.error;
          }
        }
      }
    } catch {
      if (!this.#cancelled) {
        this.error = "Connection lost";
        this.status = "error";
      }
    } finally {
      this.#reader = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/**
 * Create and provide an `ExecutionState` instance via Svelte context.
 * Call once in the parent component that owns the execution lifecycle.
 */
export function provideExecutionState(): ExecutionState {
  const state = new ExecutionState();
  setContext(EXECUTION_CTX, state);
  return state;
}

/**
 * Retrieve the `ExecutionState` from Svelte context.
 * Must be called during component initialization in a descendant of the
 * provider component.
 */
export function useExecutionState(): ExecutionState {
  return getContext<ExecutionState>(EXECUTION_CTX);
}

import { describe, expect, it, vi } from "vitest";
import { InMemoryDocumentStore } from "../../document-store/node.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition, FSMEvent } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";

describe("FSM Engine - Core Mechanics", () => {
  describe("Lifecycle & Transitions", () => {
    const lifecycleFSM: FSMDefinition = {
      id: "lifecycle-test",
      initial: "A",
      states: {
        A: {
          entry: [{ type: "emit", event: "entry_A" }],
          on: {
            // Self-transition: Should trigger exit_A -> entry_A
            SELF: { target: "A" },
            // External transition
            TO_B: { target: "B" },
          },
        },
        B: { entry: [{ type: "emit", event: "entry_B" }], on: { TO_A: { target: "A" } } },
      },
    };

    it("should run entry actions on initialization", async () => {
      const { engine } = await createTestEngine(lifecycleFSM);

      const events = engine.emittedEvents;
      expect(events.length).toEqual(1);
      expect(events[0]?.event).toEqual("entry_A");
    });

    it("should run entry actions on self-transition", async () => {
      const { engine } = await createTestEngine(lifecycleFSM, { initialState: "A" });

      const initEventsCount = engine.emittedEvents.length;

      await engine.signal({ type: "SELF" });

      const newEvents = engine.emittedEvents.slice(initEventsCount);
      expect(newEvents.length).toEqual(1);
      expect(newEvents[0]?.event).toEqual("entry_A");
    });

    it("should run entry actions on external transition", async () => {
      const { engine } = await createTestEngine(lifecycleFSM, { initialState: "A" });
      const initEventsCount = engine.emittedEvents.length;

      await engine.signal({ type: "TO_B" });

      const newEvents = engine.emittedEvents.slice(initEventsCount);
      expect(newEvents.length).toEqual(1);
      expect(newEvents[0]?.event).toEqual("entry_B");
      expect(engine.state).toEqual("B");
    });

    it("should NOT run entry actions when restoring state", async () => {
      // 1. Setup: Run engine, transition to B, persist.
      const { store, scope } = await createTestEngine(lifecycleFSM);
      const engine1 = new FSMEngine(lifecycleFSM, { documentStore: store, scope });
      await engine1.initialize();
      await engine1.signal({ type: "TO_B" });

      // 2. Create NEW engine. Restore from B.
      const engine2 = new FSMEngine(lifecycleFSM, { documentStore: store, scope });
      await engine2.initialize();

      // 3. Verify: Should NOT run entry_B again during initialize().
      // The engine.emittedEvents should be empty (new instance).
      expect(engine2.emittedEvents.length).toEqual(0);
      expect(engine2.state).toEqual("B");
    });

    // Skip: requires Deno Web Workers not available in Node.js/vitest
    it.skip("should prioritize guarded transitions", async () => {
      const priorityFSM: FSMDefinition = {
        id: "priority",
        initial: "start",
        states: {
          start: {
            on: { NEXT: [{ target: "guarded", guards: ["isTrue"] }, { target: "default" }] },
          },
          guarded: {},
          default: {},
        },
        functions: {
          isTrue: { type: "guard", code: "export default () => true" },
          isFalse: { type: "guard", code: "export default () => false" },
        },
      };

      const { engine } = await createTestEngine(priorityFSM);
      await engine.signal({ type: "NEXT" });
      expect(engine.state).toEqual("guarded");
    });

    // Skip: requires Deno Web Workers not available in Node.js/vitest
    it.skip("should fallback to default transition if guards fail", async () => {
      const priorityFSM: FSMDefinition = {
        id: "priority-fallback",
        initial: "start",
        states: {
          start: {
            on: { NEXT: [{ target: "guarded", guards: ["isFalse"] }, { target: "default" }] },
          },
          guarded: {},
          default: {},
          default2: {},
        },
        functions: { isFalse: { type: "guard", code: "export default () => false" } },
      };

      const { engine } = await createTestEngine(priorityFSM);
      await engine.signal({ type: "NEXT" });
      expect(engine.state).toEqual("default");
    });
  });

  describe("Robustness & Error Handling", () => {
    it("should handle guard function failures", async () => {
      const fsm: FSMDefinition = {
        id: "guard-failure",
        initial: "start",
        states: {
          start: { on: { NEXT: { target: "end", guards: ["badGuard"] } } },
          end: { type: "final" },
        },
        functions: {
          badGuard: {
            type: "guard",
            code: "export default () => { throw new Error('Guard Boom'); }",
          },
        },
      };

      const { engine } = await createTestEngine(fsm, { initialState: "start" });

      await expect(engine.signal({ type: "NEXT" })).rejects.toThrow('Guard "badGuard" threw error');

      // State should not change
      expect(engine.state).toEqual("start");
    });

    it("should handle action function exceptions", async () => {
      const fsm: FSMDefinition = {
        id: "action-failure",
        initial: "start",
        states: {
          start: {
            on: { NEXT: { target: "end", actions: [{ type: "code", function: "badAction" }] } },
          },
          end: { type: "final" },
        },
        functions: {
          badAction: {
            type: "action",
            code: "export default () => { throw new Error('Action Boom'); }",
          },
        },
      };

      const { engine } = await createTestEngine(fsm, { initialState: "start" });

      await expect(engine.signal({ type: "NEXT" })).rejects.toThrow(
        'Action "badAction" threw error',
      );
    });

    it("should include failStep reason in error message, not [object Object]", async () => {
      const fsm: FSMDefinition = {
        id: "llm-failstep",
        initial: "start",
        states: {
          start: {
            on: {
              RUN_LLM: {
                target: "end",
                actions: [{ type: "llm", provider: "test", model: "test", prompt: "test" }],
              },
            },
          },
          end: { type: "final" },
        },
      };

      const { store, scope } = await createTestEngine(fsm, { initialState: "start" });

      // Create engine with mock LLM provider that returns failStep in AgentResult format
      const mockLLMProvider = {
        call: (params: { agentId: string; prompt: string }) =>
          Promise.resolve({
            agentId: params.agentId,
            timestamp: new Date().toISOString(),
            input: params.prompt,
            ok: true as const,
            data: { response: "" },
            toolCalls: [
              {
                type: "tool-call" as const,
                toolCallId: "mock-failStep",
                toolName: "failStep",
                input: { reason: "Missing required data" },
              },
            ],
            durationMs: 0,
          }),
      };

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        llmProvider: mockLLMProvider,
      });
      await engine.initialize();

      await expect(engine.signal({ type: "RUN_LLM" })).rejects.toThrow(
        '"reason":"Missing required data"',
      );
    });

    it("should enforce recursion depth limits", async () => {
      const fsm: FSMDefinition = {
        id: "recursion",
        initial: "loop",
        states: {
          loop: { on: { PING: { target: "loop", actions: [{ type: "emit", event: "PING" }] } } },
        },
      };

      const { engine } = await createTestEngine(fsm, { initialState: "loop" });

      await expect(engine.signal({ type: "PING" })).rejects.toThrow("Maximum signal cascade depth");
    });

    it("should fail when referencing missing functions", async () => {
      const fsm: FSMDefinition = {
        id: "missing-func",
        initial: "start",
        states: {
          start: {
            on: { NEXT: { target: "end", actions: [{ type: "code", function: "missingAction" }] } },
          },
          end: { type: "final" },
        },
      };

      const { engine } = await createTestEngine(fsm, { initialState: "start" });

      await expect(engine.signal({ type: "NEXT" })).rejects.toThrow(
        'Action function "missingAction" not found',
      );
    });

    it("should auto-fix apostrophes in single-quoted strings (ATLAS-125)", async () => {
      // This is the exact error pattern that caused ATLAS-125:
      // AI-generated code with apostrophe in single-quoted string like 'couldn't'
      const fsm: FSMDefinition = {
        id: "auto-fix-apostrophe",
        initial: "start",
        states: {
          start: {
            on: { NEXT: { target: "end", actions: [{ type: "code", function: "fixableAction" }] } },
          },
          end: { type: "final" },
        },
        functions: {
          fixableAction: {
            type: "action",
            // This would normally fail: apostrophe breaks the single-quoted string
            // But auto-fix converts 'couldn't' to "couldn't"
            code: "export default function fixableAction(context, event) { const x = 'couldn't proceed'; }",
          },
        },
      };

      // Should succeed - auto-fix repairs the apostrophe issue
      const { engine } = await createTestEngine(fsm, { initialState: "start" });
      expect(engine.state).toEqual("start");
    });

    it("should catch unfixable syntax errors at compile time", async () => {
      const fsm: FSMDefinition = {
        id: "syntax-error",
        initial: "start",
        states: {
          start: {
            on: { NEXT: { target: "end", actions: [{ type: "code", function: "badSyntax" }] } },
          },
          end: { type: "final" },
        },
        functions: {
          badSyntax: {
            type: "action",
            // Truly broken syntax that can't be auto-fixed
            code: "export default function badSyntax(context, event) { const x = ; }",
          },
        },
      };

      // Should fail during initialization (compile time)
      await expect(createTestEngine(fsm)).rejects.toThrow(/Syntax error in function "badSyntax"/);
    });
  });

  describe("Event Streaming", () => {
    // Skip: requires Deno Web Workers not available in Node.js/vitest
    it.skip("should route events to correct callback with sequential signals", async () => {
      const fsm: FSMDefinition = {
        id: "sequential-test",
        initial: "idle",
        states: {
          idle: {
            on: {
              START: { target: "processing", actions: [{ type: "code", function: "doWork" }] },
            },
          },
          processing: { on: { DONE: { target: "idle" } } },
        },
        functions: { doWork: { type: "action", code: "export default () => {}" } },
      };

      const { engine } = await createTestEngine(fsm);

      const events1: FSMEvent[] = [];
      const events2: FSMEvent[] = [];

      const callback1 = (e: FSMEvent) => events1.push(e);
      const callback2 = (e: FSMEvent) => events2.push(e);

      // Process signals with different callbacks
      await engine.signal(
        { type: "START" },
        { sessionId: "session-1", workspaceId: "ws", onEvent: callback1 },
      );

      await engine.signal(
        { type: "DONE" },
        { sessionId: "session-1", workspaceId: "ws", onEvent: callback1 },
      );

      await engine.signal(
        { type: "START" },
        { sessionId: "session-2", workspaceId: "ws", onEvent: callback2 },
      );

      // Events should go to their respective callbacks
      const session1Events = events1.filter((e) => e.data.sessionId === "session-1");
      const session2Events = events2.filter((e) => e.data.sessionId === "session-2");

      expect(session1Events.length > 0).toEqual(true);
      expect(session2Events.length > 0).toEqual(true);

      // No cross-contamination
      expect(events1.filter((e) => e.data.sessionId === "session-2").length).toEqual(0);
      expect(events2.filter((e) => e.data.sessionId === "session-1").length).toEqual(0);
    });

    it("should emit state transition events", async () => {
      const fsm: FSMDefinition = {
        id: "transition-events",
        initial: "A",
        states: { A: { on: { NEXT: { target: "B" } } }, B: { type: "final" } },
      };

      const { engine } = await createTestEngine(fsm);

      const events: FSMEvent[] = [];
      await engine.signal(
        { type: "NEXT" },
        { sessionId: "test-session", workspaceId: "test-ws", onEvent: (e) => events.push(e) },
      );

      const transitionEvents = events.filter((e) => e.type === "data-fsm-state-transition");
      expect(transitionEvents.length).toEqual(1);

      const event = transitionEvents[0];
      expect(event?.data.fromState).toEqual("A");
      expect(event?.data.toState).toEqual("B");
      expect(event?.data.triggeringSignal).toEqual("NEXT");
      expect(event?.data.sessionId).toEqual("test-session");
      expect(event?.data.workspaceId).toEqual("test-ws");
    });

    // Skip: requires Deno Web Workers not available in Node.js/vitest
    it.skip("should emit action execution events", async () => {
      const fsm: FSMDefinition = {
        id: "action-events",
        initial: "start",
        states: {
          start: {
            on: { RUN: { target: "end", actions: [{ type: "code", function: "myAction" }] } },
          },
          end: { type: "final" },
        },
        functions: { myAction: { type: "action", code: "export default () => {}" } },
      };

      const { engine } = await createTestEngine(fsm);

      const events: FSMEvent[] = [];
      await engine.signal(
        { type: "RUN" },
        { sessionId: "test-session", workspaceId: "test-ws", onEvent: (e) => events.push(e) },
      );

      const actionEvents = events.filter((e) => e.type === "data-fsm-action-execution");
      expect(actionEvents.length).toEqual(2); // started + completed

      const startedEvent = actionEvents[0];
      expect(startedEvent?.data.status).toEqual("started");
      expect(startedEvent?.data.actionType).toEqual("code");
      expect(startedEvent?.data.actionId).toEqual("myAction");

      const completedEvent = actionEvents[1];
      expect(completedEvent?.data.status).toEqual("completed");
      expect(typeof completedEvent?.data.durationMs).toEqual("number");
    });

    it("should inherit callback context for cascaded signals", async () => {
      const fsm: FSMDefinition = {
        id: "cascade-test",
        initial: "start",
        states: {
          start: {
            on: { TRIGGER: { target: "middle", actions: [{ type: "emit", event: "NEXT" }] } },
          },
          middle: { on: { NEXT: { target: "end" } } },
          end: { type: "final" },
        },
      };

      const { engine } = await createTestEngine(fsm);

      const events: FSMEvent[] = [];
      await engine.signal(
        { type: "TRIGGER" },
        { sessionId: "cascade-session", workspaceId: "test-ws", onEvent: (e) => events.push(e) },
      );

      // Should receive events for both transitions (TRIGGER and cascaded NEXT)
      const transitionEvents = events.filter((e) => e.type === "data-fsm-state-transition");
      expect(transitionEvents.length).toEqual(2);

      // All events should have the same session ID from parent context
      transitionEvents.forEach((event) => {
        expect(event.data.sessionId).toEqual("cascade-session");
      });
    });

    it("should replace parent signal data with explicit emit data while preserving _context", async () => {
      const onStreamEvent = vi.fn();
      const onEvent = vi.fn();

      const capturedSignals: Array<{
        agentId: string;
        type: string;
        data?: Record<string, unknown>;
        hasContext: boolean;
        contextSessionId?: string;
        contextWorkspaceId?: string;
        hasOnStreamEvent: boolean;
        hasOnEvent: boolean;
      }> = [];

      const fsm: FSMDefinition = {
        id: "cascade-data-merge",
        initial: "idle",
        states: {
          idle: { on: { TRIGGER: { target: "step_plan" } } },
          step_plan: {
            entry: [{ type: "agent", agentId: "planner", outputTo: "plan_result" }],
            on: { PLAN_COMPLETE: { target: "step_dispatch" } },
          },
          step_dispatch: {
            entry: [{ type: "agent", agentId: "dispatcher", outputTo: "dispatch_result" }],
            on: { DISPATCH_COMPLETE: { target: "done" } },
          },
          done: { type: "final" },
        },
      };

      const store = new InMemoryDocumentStore();
      const scope = { workspaceId: "test", sessionId: "test-session" };

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        agentExecutor: async (action, ctx, signal) => {
          capturedSignals.push({
            agentId: action.agentId,
            type: signal.type,
            data: signal.data ? { ...signal.data } : undefined,
            hasContext: !!signal._context,
            contextSessionId: signal._context?.sessionId,
            contextWorkspaceId: signal._context?.workspaceId,
            hasOnStreamEvent: typeof signal._context?.onStreamEvent === "function",
            hasOnEvent: typeof signal._context?.onEvent === "function",
          });

          if (action.agentId === "planner") {
            await ctx.emit?.({ type: "PLAN_COMPLETE", data: { planResult: "some-plan-output" } });
          } else if (action.agentId === "dispatcher") {
            await ctx.emit?.({ type: "DISPATCH_COMPLETE" });
          }

          return {
            ok: true as const,
            agentId: action.agentId,
            timestamp: new Date().toISOString(),
            input: "",
            data: { done: true },
            durationMs: 10,
          };
        },
      });
      await engine.initialize();

      await engine.signal(
        {
          type: "TRIGGER",
          data: {
            streamId: "chat-123",
            datetime: { timezone: "UTC", timestamp: "2026-04-14T00:00:00Z" },
          },
        },
        { sessionId: "sess-1", workspaceId: "ws-1", onEvent, onStreamEvent },
      );

      expect(capturedSignals).toHaveLength(2);

      // Planner receives the original TRIGGER signal with session data
      const plannerSig = capturedSignals[0];
      expect(plannerSig?.agentId).toEqual("planner");
      expect(plannerSig?.data?.streamId).toEqual("chat-123");
      expect(plannerSig?.data?.datetime).toEqual({
        timezone: "UTC",
        timestamp: "2026-04-14T00:00:00Z",
      });
      expect(plannerSig?.hasContext).toBe(true);
      expect(plannerSig?.contextSessionId).toEqual("sess-1");
      expect(plannerSig?.contextWorkspaceId).toEqual("ws-1");
      expect(plannerSig?.hasOnStreamEvent).toBe(true);
      expect(plannerSig?.hasOnEvent).toBe(true);

      // Dispatcher receives the cascaded PLAN_COMPLETE signal with ONLY
      // the emitted data (explicit data replaces parent's data).
      // Critically, _context (onStreamEvent, onEvent) must still propagate —
      // the workspace runtime reads these to wire up streaming and event callbacks.
      const dispatcherSig = capturedSignals[1];
      expect(dispatcherSig?.agentId).toEqual("dispatcher");
      expect(dispatcherSig?.type).toEqual("PLAN_COMPLETE");
      expect(dispatcherSig?.data?.planResult).toEqual("some-plan-output");
      expect(dispatcherSig?.data).not.toHaveProperty("streamId");
      expect(dispatcherSig?.data).not.toHaveProperty("datetime");
      expect(dispatcherSig?.hasContext).toBe(true);
      expect(dispatcherSig?.contextSessionId).toEqual("sess-1");
      expect(dispatcherSig?.contextWorkspaceId).toEqual("ws-1");
      expect(dispatcherSig?.hasOnStreamEvent).toBe(true);
      expect(dispatcherSig?.hasOnEvent).toBe(true);
    });

    it("should persist prepareResult across cascaded states via __lastPrepare", async () => {
      const capturedInputs: Array<{ agentId: string; input: Record<string, unknown> | undefined }> =
        [];

      const fsm: FSMDefinition = {
        id: "prepare-persist",
        initial: "idle",
        states: {
          idle: { on: { TRIGGER: { target: "step_plan" } } },
          step_plan: {
            entry: [
              { type: "code", function: "prepare_plan" },
              { type: "agent", agentId: "planner", outputTo: "plan_result" },
            ],
            on: { PLAN_DONE: { target: "step_dispatch" } },
          },
          step_dispatch: {
            entry: [{ type: "agent", agentId: "dispatcher", outputTo: "dispatch_result" }],
            on: { DISPATCH_DONE: { target: "done" } },
          },
          done: { type: "final" },
        },
        functions: {
          prepare_plan: {
            type: "action",
            code: `export default function prepare_plan() {
              return { config: { workDir: "/workspace/atlas", platformUrl: "http://localhost:8080" } };
            }`,
          },
        },
      };

      const store = new InMemoryDocumentStore();
      const scope = { workspaceId: "test", sessionId: "test-session" };

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        agentExecutor: async (action, ctx, _signal) => {
          capturedInputs.push({
            agentId: action.agentId,
            input: ctx.input as Record<string, unknown> | undefined,
          });

          if (action.agentId === "planner") {
            await ctx.emit?.({ type: "PLAN_DONE" });
          } else if (action.agentId === "dispatcher") {
            await ctx.emit?.({ type: "DISPATCH_DONE" });
          }

          return {
            ok: true as const,
            agentId: action.agentId,
            timestamp: new Date().toISOString(),
            input: "",
            data: { done: true },
            durationMs: 10,
          };
        },
      });
      await engine.initialize();

      await engine.signal({ type: "TRIGGER" });

      expect(capturedInputs).toHaveLength(2);

      // Planner receives input.config from the code action's return value
      const plannerInput = capturedInputs[0];
      expect(plannerInput?.agentId).toEqual("planner");
      expect(plannerInput?.input).toBeDefined();
      expect((plannerInput?.input as Record<string, unknown>)?.config).toEqual({
        workDir: "/workspace/atlas",
        platformUrl: "http://localhost:8080",
      });

      // Dispatcher also receives input.config — the write side persisted
      // __lastPrepare after step_plan, and the read side picked it up
      // when step_dispatch's executeActions started (cascaded signal).
      const dispatcherInput = capturedInputs[1];
      expect(dispatcherInput?.agentId).toEqual("dispatcher");
      expect(dispatcherInput?.input).toBeDefined();
      expect((dispatcherInput?.input as Record<string, unknown>)?.config).toEqual({
        workDir: "/workspace/atlas",
        platformUrl: "http://localhost:8080",
      });
    });
  });
});

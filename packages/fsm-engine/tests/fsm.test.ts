import { describe, expect, it, vi } from "vitest";
import { getDocumentStore } from "../../document-store/node.ts";
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
  });

  describe("Robustness & Error Handling", () => {
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
  });

  describe("Event Streaming", () => {
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

      const store = getDocumentStore();
      const scope = {
        workspaceId: `test-${crypto.randomUUID()}`,
        sessionId: `test-session-${crypto.randomUUID()}`,
      };

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
  });
});

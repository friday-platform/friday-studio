import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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
      assertEquals(events.length, 1);
      assertEquals(events[0]?.event, "entry_A");
    });

    it("should run entry actions on self-transition", async () => {
      const { engine } = await createTestEngine(lifecycleFSM, { initialState: "A" });

      const initEventsCount = engine.emittedEvents.length;

      await engine.signal({ type: "SELF" });

      const newEvents = engine.emittedEvents.slice(initEventsCount);
      assertEquals(newEvents.length, 1);
      assertEquals(newEvents[0]?.event, "entry_A");
    });

    it("should run entry actions on external transition", async () => {
      const { engine } = await createTestEngine(lifecycleFSM, { initialState: "A" });
      const initEventsCount = engine.emittedEvents.length;

      await engine.signal({ type: "TO_B" });

      const newEvents = engine.emittedEvents.slice(initEventsCount);
      assertEquals(newEvents.length, 1);
      assertEquals(newEvents[0]?.event, "entry_B");
      assertEquals(engine.state, "B");
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
      assertEquals(engine2.emittedEvents.length, 0);
      assertEquals(engine2.state, "B");
    });

    it("should prioritize guarded transitions", async () => {
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
      assertEquals(engine.state, "guarded");
    });

    it("should fallback to default transition if guards fail", async () => {
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
      assertEquals(engine.state, "default");
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

      const error = await assertRejects(async () => await engine.signal({ type: "NEXT" }));

      assertStringIncludes(String(error), 'Guard "badGuard" threw error');
      assertStringIncludes(String(error), "Guard Boom");

      // State should not change
      assertEquals(engine.state, "start");
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

      const error = await assertRejects(async () => await engine.signal({ type: "NEXT" }));

      assertStringIncludes(String(error), 'Action "badAction" threw error');
      assertStringIncludes(String(error), "Action Boom");
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

      // Create engine with mock LLM provider that returns failStep
      const mockLLMProvider = {
        call: () =>
          Promise.resolve({
            content: "",
            calledTool: { name: "failStep", args: { reason: "Missing required data" } },
          }),
      };

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        llmProvider: mockLLMProvider,
      });
      await engine.initialize();

      const error = await assertRejects(async () => await engine.signal({ type: "RUN_LLM" }));

      // Should contain the actual reason, not [object Object]
      assertStringIncludes(String(error), '"reason":"Missing required data"');
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

      const error = await assertRejects(async () => await engine.signal({ type: "PING" }));

      assertStringIncludes(String(error), "Maximum signal cascade depth");
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

      const error = await assertRejects(async () => await engine.signal({ type: "NEXT" }));

      assertStringIncludes(String(error), 'Action function "missingAction" not found');
    });
  });

  describe("Event Streaming", () => {
    it("should route events to correct callback with sequential signals", async () => {
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

      assertEquals(session1Events.length > 0, true, "Session 1 should receive events");
      assertEquals(session2Events.length > 0, true, "Session 2 should receive events");

      // No cross-contamination
      assertEquals(
        events1.filter((e) => e.data.sessionId === "session-2").length,
        0,
        "Session 1 should not receive session 2 events",
      );
      assertEquals(
        events2.filter((e) => e.data.sessionId === "session-1").length,
        0,
        "Session 2 should not receive session 1 events",
      );
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
      assertEquals(transitionEvents.length, 1);

      const event = transitionEvents[0];
      assertEquals(event?.data.fromState, "A");
      assertEquals(event?.data.toState, "B");
      assertEquals(event?.data.triggeringSignal, "NEXT");
      assertEquals(event?.data.sessionId, "test-session");
      assertEquals(event?.data.workspaceId, "test-ws");
    });

    it("should emit action execution events", async () => {
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
      assertEquals(actionEvents.length, 2); // started + completed

      const startedEvent = actionEvents[0];
      assertEquals(startedEvent?.data.status, "started");
      assertEquals(startedEvent?.data.actionType, "code");
      assertEquals(startedEvent?.data.actionId, "myAction");

      const completedEvent = actionEvents[1];
      assertEquals(completedEvent?.data.status, "completed");
      assertEquals(typeof completedEvent?.data.duration, "number");
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
      assertEquals(transitionEvents.length, 2);

      // All events should have the same session ID from parent context
      transitionEvents.forEach((event) => {
        assertEquals(event.data.sessionId, "cascade-session");
      });
    });
  });
});

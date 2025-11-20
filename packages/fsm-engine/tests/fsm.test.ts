import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition } from "../types.ts";
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
});

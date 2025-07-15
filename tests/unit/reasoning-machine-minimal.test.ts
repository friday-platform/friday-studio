/**
 * Minimal tests for ReasoningMachine state machine mechanics
 * Just verifies the XState machine works correctly, not LLM behavior
 */

import { assertEquals } from "@std/assert";
import { createReasoningMachine } from "@atlas/reasoning";
import { createActor, toPromise } from "xstate";

Deno.test("ReasoningMachine - State Machine Mechanics", async () => {
  // Simple callbacks that immediately complete
  const machine = createReasoningMachine({
    think: async () => ({
      thinking: "ACTION: complete\nREASONING: Test complete",
      confidence: 1.0,
    }),

    parseAction: () => ({
      type: "complete" as const,
      parameters: {},
      reasoning: "Test complete",
    }),

    executeAction: async () => ({
      result: { done: true },
      observation: "Completed",
    }),
  });

  const actor = createActor(machine, { input: { test: true } });
  actor.start();

  const result = await toPromise(actor);

  // Just verify the machine completes successfully
  assertEquals(result.status, "completed");
  assertEquals(result.reasoning.steps.length, 1);
});

Deno.test("ReasoningMachine - Pause/Resume Mechanics", async () => {
  let isPaused = false;

  const machine = createReasoningMachine({
    think: async () => {
      // Slow think to allow pause
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        thinking: "ACTION: complete",
        confidence: 1.0,
      };
    },

    parseAction: () => ({
      type: "complete" as const,
      parameters: {},
      reasoning: "Done",
    }),

    executeAction: async () => ({
      result: null,
      observation: "Done",
    }),
  });

  const actor = createActor(machine, { input: {} });

  actor.subscribe((snapshot) => {
    if (snapshot.value === "paused") isPaused = true;
  });

  actor.start();

  // Pause quickly
  setTimeout(() => actor.send({ type: "PAUSE" }), 10);

  // Resume after a bit
  setTimeout(() => actor.send({ type: "RESUME" }), 200);

  const result = await toPromise(actor);

  assertEquals(isPaused, true, "Should have paused");
  assertEquals(result.status, "completed");
});

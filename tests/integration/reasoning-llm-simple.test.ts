/**
 * Simple integration test for ReasoningMachine with real LLM
 * Focuses on verifying the LLM can complete a reasoning task
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createReasoningMachine, generateThinking, parseAction } from "@atlas/reasoning";
import { createActor, toPromise } from "xstate";

// Skip test if no API key
const skipIfNoKey = !Deno.env.get("ANTHROPIC_API_KEY");

Deno.test({
  name: "ReasoningMachine - Real LLM Integration",
  ignore: skipIfNoKey,
  sanitizeResources: false, // Disable resource leak detection for logger
  fn: async () => {
    const userContext = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
      task:
        "Calculate 25 + 17 and then complete the task. You have no tools available, just provide the answer.",
    };

    let finalAnswer: any = null;
    let stepCount = 0;
    let parseCount = 0;

    const machine = createReasoningMachine({
      think: async (context) => {
        stepCount++;
        console.log(`\n=== STEP ${stepCount} - THINKING ===`);
        console.log("Context:", JSON.stringify(context.userContext, null, 2));
        console.log("Previous steps:", context.steps.length);

        const result = await generateThinking(context);

        console.log("\n--- LLM RESPONSE ---");
        console.log(result.thinking);
        console.log(`\nConfidence: ${result.confidence}`);

        return result;
      },
      parseAction: (thinking) => {
        parseCount++;
        const action = parseAction(thinking);

        // Only log the first parse to avoid duplicate output
        if (parseCount === 1) {
          console.log("\n--- PARSED ACTION ---");
          console.log(JSON.stringify(action, null, 2));

          // If it's a complete action, extract the answer here since executeAction won't be called
          if (action?.type === "complete" && action.parameters.answer) {
            finalAnswer = action.parameters.answer;
            console.log("Extracted answer from complete action:", finalAnswer);
          }
        }

        return action;
      },
      executeAction: async (action) => {
        console.log("\n--- EXECUTING ACTION ---");
        console.log(`Type: ${action.type}`);
        console.log(`Parameters:`, action.parameters);

        if (action.type === "complete") {
          // Extract answer from parameters - it's a string "42"
          finalAnswer = action.parameters.answer;
          return {
            result: { answer: finalAnswer },
            observation: "Task completed with answer: " + finalAnswer,
          };
        }
        return { result: null, observation: "Action executed" };
      },
    }, {
      maxIterations: 3,
    });

    const actor = createActor(machine, { input: userContext });

    // Subscribe to state changes
    let previousState: any = null;
    actor.subscribe((snapshot) => {
      const currentState = typeof snapshot.value === "object"
        ? JSON.stringify(snapshot.value)
        : snapshot.value;
      if (currentState !== previousState) {
        console.log(`\n>>> STATE TRANSITION: ${previousState || "initial"} → ${currentState}`);
        previousState = currentState;
      }
    });

    actor.start();

    const result = await toPromise(actor);

    console.log("\n=== FINAL RESULT ===");
    console.log(`Status: ${result.status}`);
    console.log(`Total steps: ${result.reasoning.steps.length}`);
    console.log(`Final answer: ${finalAnswer}`);

    // Verify the LLM completed the task
    assertEquals(result.status, "completed");
    assertEquals(result.reasoning.steps.length > 0, true);

    // The LLM should have completed with the calculation
    const lastAction = result.reasoning.steps[result.reasoning.steps.length - 1].action;
    assertEquals(lastAction?.type, "complete");
  },
});

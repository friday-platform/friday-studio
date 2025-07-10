/**
 * Integration test for ReasoningMachine with real LLM and tool usage
 * Shows the full Think→Act→Observe loop
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createReasoningMachine, generateThinking, parseAction } from "@atlas/reasoning";
import { createActor, toPromise } from "xstate";

// Skip test if no API key
const skipIfNoKey = !Deno.env.get("ANTHROPIC_API_KEY");

// Mock tools for testing
const mockTools = {
  calculator: {
    add: (a: number, b: number) => a + b,
    multiply: (a: number, b: number) => a * b,
    divide: (a: number, b: number) => a / b,
  },
  file_reader: {
    read: (path: string) => {
      if (path === "data.txt") {
        return "The secret number is 10";
      }
      throw new Error(`File not found: ${path}`);
    },
  },
};

Deno.test({
  name: "ReasoningMachine - Real LLM with Tools",
  ignore: skipIfNoKey,
  sanitizeResources: false, // Disable resource leak detection for logger
  fn: async () => {
    const userContext = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
      task:
        "Read the number from data.txt, multiply it by 4, add 2, then complete with the final answer. Available tools: calculator (add, multiply, divide), file_reader (read).",
    };

    let finalAnswer: any = null;
    let stepCount = 0;
    const executionLog: string[] = [];

    const machine = createReasoningMachine({
      think: async (context) => {
        stepCount++;
        console.log(`\n=== STEP ${stepCount} - THINKING ===`);
        console.log("Task:", context.userContext.task);
        console.log("Previous observations:", context.steps.map((s) => s.observation).join(" | "));
        console.log("Working memory keys:", Array.from(context.workingMemory.keys()));

        const result = await generateThinking(context);

        console.log("\n--- LLM RESPONSE ---");
        console.log(result.thinking);
        console.log(`\nConfidence: ${result.confidence}`);

        return result;
      },

      parseAction: (thinking) => {
        const action = parseAction(thinking);

        console.log("\n--- PARSED ACTION ---");
        console.log(JSON.stringify(action, null, 2));

        // Extract answer from complete action since it won't go through executeAction
        if (action?.type === "complete") {
          finalAnswer = action.parameters.answer || action.parameters.result ||
            action.parameters.value;
          if (finalAnswer !== undefined) {
            console.log("Extracted final answer from complete action:", finalAnswer);
          }
        }

        return action;
      },

      executeAction: async (action, context) => {
        console.log("\n--- EXECUTING ACTION ---");
        console.log(`Type: ${action.type}`);
        console.log(`Tool: ${action.toolName}`);
        console.log(`Parameters:`, action.parameters);

        executionLog.push(`${action.type}: ${action.toolName || "N/A"}`);

        if (action.type === "tool_call") {
          try {
            // Handle file_reader tool (with or without .read suffix)
            if (action.toolName === "file_reader" || action.toolName === "file_reader.read") {
              const path = action.parameters.path || action.parameters.file ||
                action.parameters.filename;
              const content = mockTools.file_reader.read(path as string);
              console.log(`→ File content: "${content}"`);
              return {
                result: { content },
                observation: `Successfully read file: ${content}`,
              };
            }

            // Handle calculator tool (detect operation from parameters)
            if (action.toolName === "calculator" || action.toolName?.startsWith("calculator.")) {
              const operation = action.parameters.operation ||
                (action.toolName.includes("multiply")
                  ? "multiply"
                  : action.toolName.includes("add")
                  ? "add"
                  : null);

              if (operation === "multiply") {
                const a = action.parameters.a || action.parameters.x || action.parameters.num1 ||
                  action.parameters.number1;
                const b = action.parameters.b || action.parameters.y || action.parameters.num2 ||
                  action.parameters.number2 || action.parameters.factor;
                const result = mockTools.calculator.multiply(Number(a), Number(b));
                console.log(`→ ${a} × ${b} = ${result}`);
                return {
                  result: { value: result },
                  observation: `Multiplied ${a} × ${b} = ${result}`,
                };
              }

              if (operation === "add") {
                const a = action.parameters.a || action.parameters.x || action.parameters.num1 ||
                  action.parameters.number1;
                const b = action.parameters.b || action.parameters.y || action.parameters.num2 ||
                  action.parameters.number2 || action.parameters.addend;
                const result = mockTools.calculator.add(Number(a), Number(b));
                console.log(`→ ${a} + ${b} = ${result}`);
                return {
                  result: { value: result },
                  observation: `Added ${a} + ${b} = ${result}`,
                };
              }
            }

            // Handle direct multiply/add tool names
            if (action.toolName === "multiply") {
              const a = action.parameters.a || action.parameters.x || action.parameters.num1 ||
                action.parameters.number1;
              const b = action.parameters.b || action.parameters.y || action.parameters.num2 ||
                action.parameters.number2 || action.parameters.factor;
              const result = mockTools.calculator.multiply(Number(a), Number(b));
              console.log(`→ ${a} × ${b} = ${result}`);
              return {
                result: { value: result },
                observation: `Multiplied ${a} × ${b} = ${result}`,
              };
            }

            if (action.toolName === "add") {
              const a = action.parameters.a || action.parameters.x || action.parameters.num1 ||
                action.parameters.number1;
              const b = action.parameters.b || action.parameters.y || action.parameters.num2 ||
                action.parameters.number2 || action.parameters.addend;
              const result = mockTools.calculator.add(Number(a), Number(b));
              console.log(`→ ${a} + ${b} = ${result}`);
              return {
                result: { value: result },
                observation: `Added ${a} + ${b} = ${result}`,
              };
            }

            return {
              result: null,
              observation: `Unknown tool: ${action.toolName}`,
            };
          } catch (error) {
            return {
              result: null,
              observation: `Tool execution failed: ${error.message}`,
            };
          }
        }

        if (action.type === "complete") {
          finalAnswer = action.parameters.answer || action.parameters.result ||
            action.parameters.value;
          console.log(`→ Completing with answer: ${finalAnswer}`);
          return {
            result: { answer: finalAnswer },
            observation: "Task completed successfully",
          };
        }

        return {
          result: null,
          observation: "Action not recognized",
        };
      },
    }, {
      maxIterations: 5, // Allow more steps for multi-tool usage
    });

    const actor = createActor(machine, { input: userContext });

    // Subscribe to state changes
    let previousState: any = null;
    actor.subscribe((snapshot) => {
      const currentState = typeof snapshot.value === "object"
        ? JSON.stringify(snapshot.value)
        : snapshot.value;
      if (currentState !== previousState && previousState !== null) {
        console.log(`\n>>> STATE: ${currentState}`);
        previousState = currentState;
      } else if (previousState === null) {
        previousState = currentState;
      }
    });

    actor.start();

    const result = await toPromise(actor);

    console.log("\n=== FINAL RESULT ===");
    console.log(`Status: ${result.status}`);
    console.log(`Total steps: ${result.reasoning.steps.length}`);
    console.log(`Execution sequence:`, executionLog.join(" → "));
    console.log(`Final answer: ${finalAnswer}`);
    console.log("\n=== REASONING STEPS ===");
    result.reasoning.steps.forEach((step, i) => {
      console.log(`\nStep ${i + 1}:`);
      console.log(`  Action: ${step.action?.type} ${step.action?.toolName || ""}`);
      console.log(`  Observation: ${step.observation}`);
      console.log(`  Result:`, step.result);
    });

    // Verify the task was completed correctly
    assertEquals(result.status, "completed");
    assertEquals(
      result.reasoning.steps.length >= 3,
      true,
      "Should have at least 3 steps (read, multiply, add)",
    );
    assertEquals(finalAnswer, 42, "Should calculate (10 × 4) + 2 = 42");

    // Verify the LLM used the tools in sequence
    const hasFileRead = executionLog.some((log) => log.includes("file_reader"));
    const hasCalculator = executionLog.some((log) => log.includes("calculator"));

    assertEquals(hasFileRead, true, "Should have used file_reader");
    assertEquals(hasCalculator, true, "Should have used calculator");
    assertEquals(executionLog.length >= 3, true, "Should have at least 3 tool calls");
  },
});

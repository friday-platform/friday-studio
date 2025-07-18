/**
 * Integration test for ReasoningMachine with real LLM and tool usage
 * Shows the full Think→Act→Observe loop
 */

import { assertEquals } from "@std/assert";
import { createReasoningMachine, generateThinking, parseAction } from "@atlas/reasoning";
import { createActor, toPromise } from "xstate";
import { tool } from "ai";
import { z } from "zod";

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

// LLM-compatible tool definitions using AI SDK format
const llmTools = {
  file_reader: tool({
    description: "Read content from a file",
    parameters: z.object({
      path: z.string().describe("Path to the file to read"),
    }),
    execute: async ({ path }: { path: string }) => {
      return { content: mockTools.file_reader.read(path) };
    },
  }),
  calculator: tool({
    description: "Perform mathematical calculations",
    parameters: z.object({
      operation: z.enum(["add", "multiply", "divide"]).describe("The operation to perform"),
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    }),
    execute: async ({ operation, a, b }: { operation: string; a: number; b: number }) => {
      switch (operation) {
        case "add":
          return { result: mockTools.calculator.add(a, b) };
        case "multiply":
          return { result: mockTools.calculator.multiply(a, b) };
        case "divide":
          return { result: mockTools.calculator.divide(a, b) };
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
  }),
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

    let finalAnswer: string | number | null = null;
    let stepCount = 0;
    const executionLog: string[] = [];

    const machine = createReasoningMachine(
      {
        think: async (context) => {
          stepCount++;
          const result = await generateThinking(context);
          return result;
        },

        parseAction: (thinking, completion) => {
          // First check if there are tool calls from the LLM
          if (completion?.toolCalls && completion.toolCalls.length > 0) {
            const toolCall = completion.toolCalls[0]; // Process first tool call
            return {
              type: "tool_call" as const,
              toolName: toolCall.toolName,
              parameters: toolCall.args,
              reasoning: `Using tool ${toolCall.toolName}`,
            };
          }

          // Fall back to text-based parsing
          const action = parseAction(thinking);

          // Extract answer from complete action since it won't go through executeAction
          if (action?.type === "complete") {
            const answer = action.parameters.answer ||
              action.parameters.result ||
              action.parameters.value;
            if (typeof answer === "string" || typeof answer === "number") {
              finalAnswer = answer;
            }
          }

          return action;
        },

        executeAction: (action) => {
          executionLog.push(`${action.type}: ${action.toolName || "N/A"}`);

          if (action.type === "tool_call") {
            try {
              // Handle file_reader tool (with or without .read suffix)
              if (
                action.toolName === "file_reader" ||
                action.toolName === "file_reader.read"
              ) {
                const path = action.parameters.path ||
                  action.parameters.file ||
                  action.parameters.filename;
                const content = mockTools.file_reader.read(path as string);
                return Promise.resolve({
                  result: { content },
                  observation: `Successfully read file: ${content}`,
                });
              }

              // Handle calculator tool (detect operation from parameters)
              if (
                action.toolName === "calculator" ||
                action.toolName?.startsWith("calculator.")
              ) {
                const operation = action.parameters.operation ||
                  (action.toolName.includes("multiply")
                    ? "multiply"
                    : action.toolName.includes("add")
                    ? "add"
                    : null);

                if (operation === "multiply") {
                  const a = action.parameters.a ||
                    action.parameters.x ||
                    action.parameters.num1 ||
                    action.parameters.number1;
                  const b = action.parameters.b ||
                    action.parameters.y ||
                    action.parameters.num2 ||
                    action.parameters.number2 ||
                    action.parameters.factor;
                  const result = mockTools.calculator.multiply(
                    Number(a),
                    Number(b),
                  );
                  return Promise.resolve({
                    result: { value: result },
                    observation: `Multiplied ${a} × ${b} = ${result}`,
                  });
                }

                if (operation === "add") {
                  const a = action.parameters.a ||
                    action.parameters.x ||
                    action.parameters.num1 ||
                    action.parameters.number1;
                  const b = action.parameters.b ||
                    action.parameters.y ||
                    action.parameters.num2 ||
                    action.parameters.number2 ||
                    action.parameters.addend;
                  const result = mockTools.calculator.add(Number(a), Number(b));
                  return Promise.resolve({
                    result: { value: result },
                    observation: `Added ${a} + ${b} = ${result}`,
                  });
                }
              }

              // Handle direct multiply/add tool names
              if (action.toolName === "multiply") {
                const a = action.parameters.a ||
                  action.parameters.x ||
                  action.parameters.num1 ||
                  action.parameters.number1;
                const b = action.parameters.b ||
                  action.parameters.y ||
                  action.parameters.num2 ||
                  action.parameters.number2 ||
                  action.parameters.factor;
                const result = mockTools.calculator.multiply(
                  Number(a),
                  Number(b),
                );
                return Promise.resolve({
                  result: { value: result },
                  observation: `Multiplied ${a} × ${b} = ${result}`,
                });
              }

              if (action.toolName === "add") {
                const a = action.parameters.a ||
                  action.parameters.x ||
                  action.parameters.num1 ||
                  action.parameters.number1;
                const b = action.parameters.b ||
                  action.parameters.y ||
                  action.parameters.num2 ||
                  action.parameters.number2 ||
                  action.parameters.addend;
                const result = mockTools.calculator.add(Number(a), Number(b));
                return Promise.resolve({
                  result: { value: result },
                  observation: `Added ${a} + ${b} = ${result}`,
                });
              }

              return Promise.resolve({
                result: null,
                observation: `Unknown tool: ${action.toolName}`,
              });
            } catch (error) {
              return Promise.resolve({
                result: null,
                observation: `Tool execution failed: ${error.message}`,
              });
            }
          }

          if (action.type === "complete") {
            const answer = action.parameters.answer ||
              action.parameters.result ||
              action.parameters.value;
            if (typeof answer === "string" || typeof answer === "number") {
              finalAnswer = answer;
            }
            return Promise.resolve({
              result: { answer: finalAnswer },
              observation: "Task completed successfully",
            });
          }

          return Promise.resolve({
            result: null,
            observation: "Action not recognized",
          });
        },
      },
      {
        maxIterations: 5, // Allow more steps for multi-tool usage
        tools: llmTools,
      },
    );

    const actor = createActor(machine, { input: userContext });

    // Subscribe to state changes
    let previousState: string | null = null;
    actor.subscribe((snapshot) => {
      const currentState = typeof snapshot.value === "object"
        ? JSON.stringify(snapshot.value)
        : snapshot.value;
      if (currentState !== previousState && previousState !== null) {
        previousState = currentState;
      } else if (previousState === null) {
        previousState = currentState;
      }
    });

    actor.start();

    const result = await toPromise(actor);

    // Verify the task was completed correctly
    assertEquals(result.status, "completed");
    assertEquals(
      result.reasoning.steps.length >= 3,
      true,
      "Should have at least 3 steps (read, multiply, add)",
    );
    // Handle both numeric and string responses
    const expectedAnswer = 42;
    if (typeof finalAnswer === "string") {
      // Extract number from string like "The final answer is 42."
      const match = finalAnswer.match(/\d+/);
      const numericAnswer = match ? parseInt(match[0], 10) : null;
      assertEquals(numericAnswer, expectedAnswer, "Should calculate (10 × 4) + 2 = 42");
    } else {
      assertEquals(finalAnswer, expectedAnswer, "Should calculate (10 × 4) + 2 = 42");
    }

    // Verify the LLM used the tools in sequence
    const hasFileRead = executionLog.some((log) => log.includes("file_reader"));
    const hasCalculator = executionLog.some((log) => log.includes("calculator"));

    console.log(executionLog);
    console.log(result);

    assertEquals(hasFileRead, true, "Should have used file_reader");
    assertEquals(hasCalculator, true, "Should have used calculator");
    assertEquals(
      executionLog.length >= 3,
      true,
      "Should have at least 3 tool calls",
    );
  },
});

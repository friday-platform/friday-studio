#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file

// Minimal test of tool calling to identify the issue
import { LLMProviderManager } from "./src/core/agents/llm-provider-manager.ts";
import { jsonSchema, Tool } from "ai";

// Very simple tool with proper JSON Schema using jsonSchema helper
const simpleTools: Record<string, Tool> = {
  greet: {
    description: "Provide a greeting",
    parameters: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name to greet",
        },
      },
      required: ["name"],
      additionalProperties: false,
    }),
    execute: async ({ name }) => {
      return `Hello, ${name}!`;
    },
  },
};

async function testSimpleTool() {
  console.log("🧠 Testing Simple Tool Calling");

  try {
    console.log("Making LLM call...");

    const result = await LLMProviderManager.generateTextWithTools("Say hello to Alice", {
      systemPrompt:
        "You are a helpful assistant. Use the greet tool when someone asks you to greet someone.",
      tools: simpleTools,
      model: "claude-3-5-haiku-20241022",
      temperature: 0.3,
      maxSteps: 1,
      toolChoice: "auto",
    });

    console.log("Success!");
    console.log("Tool calls:", result.toolCalls.length);
    console.log("Response:", result.text);
  } catch (error) {
    console.error("Error:", error);
    if (error instanceof Error) {
      console.error("Stack:", error.stack);
    }
  }
}

if (import.meta.main) {
  await testSimpleTool();
}

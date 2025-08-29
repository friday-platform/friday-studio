import type { SessionUIMessagePart } from "@atlas/core";
import { assertEquals, assertExists } from "@std/assert";
import { formatMessage, getNormalizedToolName } from "./utils.ts";

Deno.test("formatMessage - returns undefined for unsupported message types", () => {
  const unsupportedMessage: SessionUIMessagePart = { type: "unsupported-type" };

  const result = formatMessage(unsupportedMessage);
  assertEquals(result, undefined);
});

Deno.test("formatMessage - formats user message correctly", () => {
  const userMessage: SessionUIMessagePart = { type: "data-user-message", data: "Hello from user" };

  const result = formatMessage(userMessage);
  assertExists(result);
  assertEquals(result.type, "request");
  assertEquals(result.content, "Hello from user");
  assertEquals(result.author, Deno.env.get("USER") || Deno.env.get("USERNAME") || "You");
});

Deno.test("formatMessage - formats completed reasoning correctly", () => {
  const reasoningMessage: SessionUIMessagePart = {
    type: "reasoning",
    state: "done",
    text: "I need to analyze this request...",
  };

  const result = formatMessage(reasoningMessage);
  assertExists(result);
  assertEquals(result.type, "thinking");
  assertEquals(result.content, "I need to analyze this request...");
  assertEquals(result.author, "Atlas");
});

Deno.test("formatMessage - formats completed text message correctly", () => {
  const textMessage: SessionUIMessagePart = {
    type: "text",
    state: "done",
    text: "Here is my response",
  };

  const result = formatMessage(textMessage);
  assertExists(result);
  assertEquals(result.type, "text");
  assertEquals(result.content, "Here is my response");
  assertEquals(result.author, "Atlas");
});

Deno.test("formatMessage - formats tool calls correctly", () => {
  const toolMessage: SessionUIMessagePart = {
    type: "tool-atlas_todo_read",
    toolName: "atlas_todo_read",
  };

  const result = formatMessage(toolMessage);
  assertExists(result);
  assertEquals(result.type, "tool_call");
  assertEquals(result.author, "Atlas");
  assertEquals(result.metadata?.toolName, "atlas_todo_read");
});

Deno.test("formatMessage - formats dynamic tool calls correctly", () => {
  const dynamicToolMessage: SessionUIMessagePart = {
    type: "dynamic-tool",
    toolName: "custom_tool",
  };

  const result = formatMessage(dynamicToolMessage);
  assertExists(result);
  assertEquals(result.type, "tool_call");
  assertEquals(result.metadata?.toolName, "custom_tool");
});

Deno.test("formatMessage - formats error messages correctly", () => {
  const errorMessage: SessionUIMessagePart = {
    type: "data-agent-error", // Use data-error instead of tool-error to avoid startsWith("tool-") conflict
  };

  const result = formatMessage(errorMessage);
  assertExists(result);
  assertEquals(result.type, "error");
  assertEquals(result.content, "Something went wrong");
  assertEquals(result.author, "Atlas");
});

Deno.test("formatMessage - formats tool results as tool calls (due to startsWith logic)", () => {
  const toolResultMessage: SessionUIMessagePart = { type: "tool-result-atlas_todo_read" };

  const result = formatMessage(toolResultMessage);
  assertExists(result);
  assertEquals(result.type, "tool_call");
  assertEquals(result.metadata?.toolName, "result-atlas_todo_read"); // "tool-" prefix removed
});

Deno.test("getNormalizedToolName - normalizes known tool names", () => {
  assertEquals(getNormalizedToolName("atlas_todo_read"), "Reading Todos");
  assertEquals(getNormalizedToolName("atlas_workspace_list"), "Reading Workspaces");
  assertEquals(getNormalizedToolName("atlas_workspace_create"), "Creating Workspace");
});

Deno.test("getNormalizedToolName - returns original name for unknown tools", () => {
  assertEquals(getNormalizedToolName("custom_tool"), "custom_tool");
  assertEquals(getNormalizedToolName("unknown_tool_name"), "unknown_tool_name");
});

/**
 * Tests for message formatting, particularly around streaming edge cases.
 *
 * These tests verify behavior when tool call parts have incomplete data,
 * which happens during streaming before tool execution completes.
 */

import type { AtlasUIMessage, AtlasUIMessagePart } from "@atlas/agent-sdk";
import { assertEquals } from "@std/assert";
import { formatMessage } from "./format.ts";

// Helper to create a minimal mock message
// Using `unknown` cast because we only need the fields that formatMessage uses
function mockMessage(role: "user" | "assistant"): AtlasUIMessage {
  return { id: "test-id", role, parts: [] } as unknown as AtlasUIMessage;
}

// Helper to create a mock part - uses unknown cast to simulate streaming edge cases
// where the full type structure isn't yet populated
function mockPart(partial: Record<string, unknown>): AtlasUIMessagePart {
  return partial as unknown as AtlasUIMessagePart;
}

Deno.test("formatMessage - connect_service tool", async (t) => {
  await t.step("returns empty provider when output is undefined (streaming race)", () => {
    const message = mockMessage("assistant");
    // Simulates streaming state where output hasn't been populated yet
    const part = mockPart({ type: "tool-connect_service", output: undefined });

    const result = formatMessage(message, part);

    assertEquals(result?.type, "tool_call");
    assertEquals(result?.metadata?.toolName, "connect_service");
    // Documents current behavior: provider defaults to empty string
    // The template guard `&& message.metadata?.provider` prevents rendering
    assertEquals(result?.metadata?.provider, "");
  });

  await t.step("returns provider when output is populated", () => {
    const message = mockMessage("assistant");
    const part = mockPart({ type: "tool-connect_service", output: { provider: "linear" } });

    const result = formatMessage(message, part);

    assertEquals(result?.type, "tool_call");
    assertEquals(result?.metadata?.toolName, "connect_service");
    assertEquals(result?.metadata?.provider, "linear");
  });

  await t.step("returns empty provider when output.provider is missing", () => {
    const message = mockMessage("assistant");
    const part = mockPart({
      type: "tool-connect_service",
      output: {}, // Output exists but provider is missing
    });

    const result = formatMessage(message, part);

    assertEquals(result?.metadata?.provider, "");
  });
});

Deno.test("formatMessage - display_artifact tool", async (t) => {
  await t.step("returns empty artifactId when output is undefined", () => {
    const message = mockMessage("assistant");
    const part = mockPart({ type: "tool-display_artifact", output: undefined });

    const result = formatMessage(message, part);

    assertEquals(result?.metadata?.toolName, "display_artifact");
    assertEquals(result?.metadata?.artifactId, "");
  });

  await t.step("returns artifactId when output is populated", () => {
    const message = mockMessage("assistant");
    const part = mockPart({ type: "tool-display_artifact", output: { artifactId: "art-123" } });

    const result = formatMessage(message, part);

    assertEquals(result?.metadata?.artifactId, "art-123");
  });
});

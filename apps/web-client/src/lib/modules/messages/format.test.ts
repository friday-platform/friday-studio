/**
 * Tests for message formatting, particularly around streaming edge cases.
 *
 * These tests verify behavior when tool call parts have incomplete data,
 * which happens during streaming before tool execution completes.
 */

import type { AtlasUIMessage, AtlasUIMessagePart } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { formatMessage } from "./format.ts";
import type { ConnectServiceEntry, DisplayArtifactEntry } from "./types.ts";

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

describe("formatMessage - connect_service tool", () => {
  it("returns empty provider when output is undefined (streaming race)", () => {
    const message = mockMessage("assistant");
    // Simulates streaming state where output hasn't been populated yet
    const part = mockPart({ type: "tool-connect_service", output: undefined });

    const result = formatMessage(message, part) as ConnectServiceEntry;

    expect(result.type).toEqual("connect_service");
    // Documents current behavior: provider defaults to empty string
    // The template guard `&& message.metadata?.provider` prevents rendering
    expect(result.provider).toEqual("");
  });

  it("returns provider when output is populated", () => {
    const message = mockMessage("assistant");
    const part = mockPart({ type: "tool-connect_service", output: { provider: "linear" } });

    const result = formatMessage(message, part) as ConnectServiceEntry;

    expect(result.type).toEqual("connect_service");
    expect(result.provider).toEqual("linear");
  });

  it("returns empty provider when output.provider is missing", () => {
    const message = mockMessage("assistant");
    const part = mockPart({
      type: "tool-connect_service",
      output: {}, // Output exists but provider is missing
    });

    const result = formatMessage(message, part) as ConnectServiceEntry;

    expect(result.provider).toEqual("");
  });
});

describe("formatMessage - display_artifact tool", () => {
  it("returns empty artifactId when output is undefined", () => {
    const message = mockMessage("assistant");
    const part = mockPart({ type: "tool-display_artifact", output: undefined });

    const result = formatMessage(message, part) as DisplayArtifactEntry;

    expect(result.type).toEqual("display_artifact");
    expect(result.artifactId).toEqual("");
  });

  it("returns artifactId when output is populated", () => {
    const message = mockMessage("assistant");
    const part = mockPart({ type: "tool-display_artifact", output: { artifactId: "art-123" } });

    const result = formatMessage(message, part) as DisplayArtifactEntry;

    expect(result.artifactId).toEqual("art-123");
  });
});

import type { AtlasUIMessage, AtlasUIMessagePart } from "@atlas/agent-sdk";
import { assertEquals } from "@std/assert";
import { extractArtifactIds } from "./artifacts.ts";

/**
 * Creates a minimal AtlasUIMessage for testing.
 * Uses 'as AtlasUIMessage' because Vercel AI SDK's UIMessage has many optional
 * fields we don't need to populate for these tests.
 */
function createMessage(parts: AtlasUIMessagePart[]): AtlasUIMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    createdAt: new Date(),
    parts,
  } as AtlasUIMessage;
}

/**
 * Creates a display_artifact tool part.
 * The Vercel AI SDK transforms tool calls to type "tool-{toolName}".
 * Cast through unknown because the SDK types are strict about required fields
 * we don't need for testing extractArtifactIds.
 */
function createDisplayArtifactPart(artifactId: string): AtlasUIMessagePart {
  return {
    type: "tool-display_artifact",
    toolCallId: crypto.randomUUID(),
    output: { success: true, artifactId },
  } as unknown as AtlasUIMessagePart;
}

/**
 * Creates a generic tool part (not display_artifact).
 */
function createOtherToolPart(toolName: string): AtlasUIMessagePart {
  return {
    type: `tool-${toolName}`,
    toolCallId: crypto.randomUUID(),
    output: { result: "ok" },
  } as unknown as AtlasUIMessagePart;
}

/**
 * Creates a text part.
 */
function createTextPart(text: string): AtlasUIMessagePart {
  return { type: "text", text } as AtlasUIMessagePart;
}

Deno.test("extractArtifactIds - extracts artifact IDs from display_artifact parts", () => {
  const messages = [
    createMessage([
      createTextPart("Here's the artifact:"),
      createDisplayArtifactPart("artifact-123"),
    ]),
  ];

  const ids = extractArtifactIds(messages);

  assertEquals(ids, ["artifact-123"]);
});

Deno.test("extractArtifactIds - deduplicates artifact IDs across messages", () => {
  const messages = [
    createMessage([createDisplayArtifactPart("artifact-aaa")]),
    createMessage([
      createDisplayArtifactPart("artifact-bbb"),
      createDisplayArtifactPart("artifact-aaa"), // duplicate
    ]),
    createMessage([createDisplayArtifactPart("artifact-ccc")]),
  ];

  const ids = extractArtifactIds(messages);

  assertEquals(ids.length, 3);
  assertEquals(ids.includes("artifact-aaa"), true);
  assertEquals(ids.includes("artifact-bbb"), true);
  assertEquals(ids.includes("artifact-ccc"), true);
});

Deno.test("extractArtifactIds - ignores other tool call types", () => {
  const messages = [
    createMessage([
      createOtherToolPart("take_note"),
      createDisplayArtifactPart("artifact-xyz"),
      createOtherToolPart("workspace_summary"),
      createTextPart("Some text"),
    ]),
  ];

  const ids = extractArtifactIds(messages);

  assertEquals(ids, ["artifact-xyz"]);
});

Deno.test("extractArtifactIds - handles malformed/missing output gracefully", () => {
  const messages = [
    createMessage([
      // Missing output entirely
      {
        type: "tool-display_artifact",
        toolCallId: crypto.randomUUID(),
      } as unknown as AtlasUIMessagePart,
      // Output is null
      {
        type: "tool-display_artifact",
        toolCallId: crypto.randomUUID(),
        output: null,
      } as unknown as AtlasUIMessagePart,
      // Output missing artifactId
      {
        type: "tool-display_artifact",
        toolCallId: crypto.randomUUID(),
        output: { success: false, error: "not found" },
      } as unknown as AtlasUIMessagePart,
      // artifactId is not a string
      {
        type: "tool-display_artifact",
        toolCallId: crypto.randomUUID(),
        output: { artifactId: 12345 },
      } as unknown as AtlasUIMessagePart,
      // Valid one should still be extracted
      createDisplayArtifactPart("artifact-valid"),
    ]),
  ];

  const ids = extractArtifactIds(messages);

  assertEquals(ids, ["artifact-valid"]);
});

Deno.test("extractArtifactIds - returns empty array for no messages", () => {
  const ids = extractArtifactIds([]);
  assertEquals(ids, []);
});

Deno.test("extractArtifactIds - returns empty array when no display_artifact parts", () => {
  const messages = [createMessage([createTextPart("Hello"), createOtherToolPart("take_note")])];

  const ids = extractArtifactIds(messages);

  assertEquals(ids, []);
});

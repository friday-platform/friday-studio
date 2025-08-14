import { assertEquals } from "@std/assert";
import { StreamEventSchema } from "../../src/types/streaming.ts";

Deno.test("Stream Event Format Compatibility", async (t) => {
  await t.step("should accept structured tool call/result/thinking/text events", () => {
    const toolCall = { type: "tool-call" as const, toolName: "search", args: { query: "test" } };
    const toolResult = {
      type: "tool-result" as const,
      toolName: "database_query",
      result: { rows: 5 },
    };
    const thinking = { type: "thinking" as const, content: "Analyzing the request..." };
    const text = { type: "text" as const, content: "Plain text message" };

    assertEquals(StreamEventSchema.parse(toolCall), toolCall);
    assertEquals(StreamEventSchema.parse(toolResult), toolResult);
    assertEquals(StreamEventSchema.parse(thinking), thinking);
    assertEquals(StreamEventSchema.parse(text), text);
  });

  await t.step("should accept progress events with or without percentage", () => {
    const withPct = { type: "progress", percentage: 50, message: "Processing data" } as const;
    const zeroPct = { type: "progress", percentage: 0, message: "Starting" } as const;
    const fullPct = { type: "progress", percentage: 100, message: "Complete" } as const;
    const noPct = { type: "progress", message: "Working" } as const;

    assertEquals(StreamEventSchema.parse(withPct), withPct);
    assertEquals(StreamEventSchema.parse(zeroPct), zeroPct);
    assertEquals(StreamEventSchema.parse(fullPct), fullPct);
    assertEquals(StreamEventSchema.parse(noPct), noPct);
  });

  await t.step("should allow wrapping unknown MCP content in custom events", () => {
    const custom = {
      type: "custom",
      eventType: "mcp.unknown",
      data: { type: "image", data: "base64data", mimeType: "image/png" },
    } as const;
    assertEquals(StreamEventSchema.parse(custom), custom);
  });
});

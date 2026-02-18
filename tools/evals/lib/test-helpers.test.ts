import { describe, expect, it } from "vitest";
import { createMockModel } from "./test-helpers.ts";

describe("createMockModel", () => {
  it("generates tool calls with correct content shape", async () => {
    const model = createMockModel({
      toolCalls: [{ toolName: "get_weather", input: '{"city":"Tokyo"}' }],
    });
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const toolCalls = result.content.filter(
      (c): c is Extract<typeof c, { type: "tool-call" }> => c.type === "tool-call",
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
      input: '{"city":"Tokyo"}',
    });
  });

  it("streams chunks in protocol-correct order", async () => {
    const model = createMockModel({ text: "streamed" });
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const reader = stream.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const types = chunks.map((c) => c.type);
    expect(types).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"]);

    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    const combined = textDeltas.map((c) => ("delta" in c ? c.delta : "")).join("");
    expect(combined).toBe("streamed");
  });
});

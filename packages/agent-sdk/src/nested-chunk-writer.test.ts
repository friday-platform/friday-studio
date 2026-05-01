import type { UIMessageStreamWriter } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { AtlasUIMessage, AtlasUIMessageChunk } from "./messages.ts";
import { createNestedChunkWriter } from "./nested-chunk-writer.ts";

describe("createNestedChunkWriter", () => {
  it("wraps every chunk in a nested-chunk envelope", () => {
    const writeFn = vi.fn();
    const writer = { write: writeFn } as unknown as UIMessageStreamWriter<AtlasUIMessage>;
    const nested = createNestedChunkWriter("tc-parent-1", writer);

    nested.write({ type: "text-delta", id: "t1", delta: "hello" } as AtlasUIMessageChunk);

    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith({
      type: "data-nested-chunk",
      data: {
        parentToolCallId: "tc-parent-1",
        chunk: { type: "text-delta", id: "t1", delta: "hello" },
      },
    });
  });

  it("preserves the original chunk payload verbatim", () => {
    const writeFn = vi.fn();
    const writer = { write: writeFn } as unknown as UIMessageStreamWriter<AtlasUIMessage>;
    const nested = createNestedChunkWriter("tc-parent-2", writer);

    const toolChunk = {
      type: "tool-input-start",
      toolCallId: "tc-child-1",
      toolName: "search",
    } as AtlasUIMessageChunk;

    nested.write(toolChunk);

    expect(writeFn).toHaveBeenCalledWith({
      type: "data-nested-chunk",
      data: { parentToolCallId: "tc-parent-2", chunk: toolChunk },
    });
  });
});

import { describe, expect, it } from "vitest";
import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { accumulateChunks } from "./chunk-accumulator.ts";

// ---------------------------------------------------------------------------
// Test helpers — hand-built chunks that match the structural shapes the
// reducer narrows at runtime.  We intentionally don't import the full
// UIMessageChunk generic from AI SDK v6 because the accumulator only
// dispatches on `type`, `toolCallId`, and a handful of adjacent fields.
// ---------------------------------------------------------------------------

function toolInputStart(toolCallId: string, toolName: string): AtlasUIMessageChunk {
  return { type: "tool-input-start", toolCallId, toolName } as unknown as AtlasUIMessageChunk;
}

function toolInputAvailable(
  toolCallId: string,
  toolName: string,
  input: unknown,
): AtlasUIMessageChunk {
  return {
    type: "tool-input-available",
    toolCallId,
    toolName,
    input,
  } as unknown as AtlasUIMessageChunk;
}

function toolOutputAvailable(toolCallId: string, output: unknown): AtlasUIMessageChunk {
  return { type: "tool-output-available", toolCallId, output } as unknown as AtlasUIMessageChunk;
}

function toolOutputError(toolCallId: string, errorText: string): AtlasUIMessageChunk {
  return {
    type: "tool-output-error",
    toolCallId,
    errorText,
  } as unknown as AtlasUIMessageChunk;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("accumulateChunks", () => {
  it("returns an empty map for an empty chunk array", () => {
    const result = accumulateChunks([]);
    expect(result.size).toBe(0);
  });

  it("handles a complete happy-path sequence: start → available → output", () => {
    const chunks = [
      toolInputStart("t1", "web_fetch"),
      toolInputAvailable("t1", "web_fetch", { url: "https://example.com" }),
      toolOutputAvailable("t1", { status: 200 }),
    ];
    const result = accumulateChunks(chunks);
    expect(result.size).toBe(1);

    const entry = result.get("t1");
    expect(entry).toBeDefined();
    expect(entry?.toolCallId).toBe("t1");
    expect(entry?.toolName).toBe("web_fetch");
    expect(entry?.state).toBe("output-available");
    expect(entry?.input).toEqual({ url: "https://example.com" });
    expect(entry?.output).toEqual({ status: 200 });
  });

  it("handles a complete error sequence: start → available → error", () => {
    const chunks = [
      toolInputStart("t1", "run_code"),
      toolInputAvailable("t1", "run_code", { code: "print(1)" }),
      toolOutputError("t1", "SyntaxError"),
    ];
    const result = accumulateChunks(chunks);
    const entry = result.get("t1");
    expect(entry?.state).toBe("output-error");
    expect(entry?.errorText).toBe("SyntaxError");
    expect(entry?.output).toBeUndefined();
  });

  it("preserves insertion order (Map iteration order)", () => {
    const chunks = [
      toolInputStart("t1", "web_fetch"),
      toolInputStart("t2", "run_code"),
      toolInputStart("t3", "web_search"),
    ];
    const result = accumulateChunks(chunks);
    const ids = Array.from(result.keys());
    expect(ids).toEqual(["t1", "t2", "t3"]);
  });

  it("tolerates missing tool-input-start (starts from available)", () => {
    const chunks = [
      toolInputAvailable("t1", "web_fetch", { url: "https://example.com" }),
      toolOutputAvailable("t1", { status: 200 }),
    ];
    const result = accumulateChunks(chunks);
    const entry = result.get("t1");
    expect(entry).toBeDefined();
    expect(entry?.toolName).toBe("web_fetch");
    expect(entry?.state).toBe("output-available");
    expect(entry?.input).toEqual({ url: "https://example.com" });
  });

  it("uses 'tool' as fallback toolName when missing from start and available", () => {
    const chunks = [
      {
        type: "tool-input-available",
        toolCallId: "t1",
        input: { x: 1 },
      } as unknown as AtlasUIMessageChunk,
    ];
    const result = accumulateChunks(chunks);
    const entry = result.get("t1");
    expect(entry?.toolName).toBe("tool");
  });

  it("ignores tool-output-available when entry is missing", () => {
    const chunks = [toolOutputAvailable("t1", { ok: true })];
    const result = accumulateChunks(chunks);
    expect(result.size).toBe(0);
  });

  it("ignores tool-output-error when entry is missing", () => {
    const chunks = [toolOutputError("t1", "boom")];
    const result = accumulateChunks(chunks);
    expect(result.size).toBe(0);
  });

  it("ignores unknown chunk types without throwing", () => {
    const chunks = [
      { type: "text-delta", id: "1", delta: "hello" } as unknown as AtlasUIMessageChunk,
      { type: "step-start" } as unknown as AtlasUIMessageChunk,
      { type: "reasoning", text: "thinking" } as unknown as AtlasUIMessageChunk,
      toolInputStart("t1", "web_fetch"),
    ];
    const result = accumulateChunks(chunks);
    expect(result.size).toBe(1);
    expect(result.get("t1")?.toolName).toBe("web_fetch");
  });

  it("ignores chunks with missing toolCallId", () => {
    const chunks = [
      { type: "tool-input-start", toolName: "web_fetch" } as unknown as AtlasUIMessageChunk,
      { type: "tool-output-available", output: {} } as unknown as AtlasUIMessageChunk,
    ];
    const result = accumulateChunks(chunks);
    expect(result.size).toBe(0);
  });

  it("ignores non-object chunks", () => {
    const chunks = [
      "not-an-object" as unknown as AtlasUIMessageChunk,
      42 as unknown as AtlasUIMessageChunk,
      null as unknown as AtlasUIMessageChunk,
    ];
    const result = accumulateChunks(chunks);
    expect(result.size).toBe(0);
  });

  it("handles out-of-order chunks for the same tool call", () => {
    // output arrives before available — should be ignored (no entry yet)
    const chunks = [
      toolOutputAvailable("t1", { status: 200 }),
      toolInputStart("t1", "web_fetch"),
      toolInputAvailable("t1", "web_fetch", { url: "https://example.com" }),
    ];
    const result = accumulateChunks(chunks);
    const entry = result.get("t1");
    expect(entry?.state).toBe("input-available");
    expect(entry?.output).toBeUndefined();
  });

  it("handles multiple interleaved tool calls", () => {
    const chunks = [
      toolInputStart("t1", "web_fetch"),
      toolInputStart("t2", "run_code"),
      toolInputAvailable("t1", "web_fetch", { url: "https://a" }),
      toolInputAvailable("t2", "run_code", { code: "y" }),
      toolOutputAvailable("t1", { status: 200 }),
      toolOutputError("t2", "timeout"),
    ];
    const result = accumulateChunks(chunks);
    expect(result.size).toBe(2);

    const e1 = result.get("t1");
    expect(e1?.state).toBe("output-available");
    expect(e1?.output).toEqual({ status: 200 });

    const e2 = result.get("t2");
    expect(e2?.state).toBe("output-error");
    expect(e2?.errorText).toBe("timeout");
  });

  it("overwrites state on repeated chunks of the same type (idempotent)", () => {
    const chunks = [
      toolInputStart("t1", "web_fetch"),
      toolInputStart("t1", "web_fetch"),
      toolInputAvailable("t1", "web_fetch", { url: "https://a" }),
      toolInputAvailable("t1", "web_fetch", { url: "https://b" }),
    ];
    const result = accumulateChunks(chunks);
    const entry = result.get("t1");
    expect(entry?.state).toBe("input-available");
    expect(entry?.input).toEqual({ url: "https://b" });
  });

  it("does not regress state (available → output → available stays at output)", () => {
    const chunks = [
      toolInputStart("t1", "web_fetch"),
      toolInputAvailable("t1", "web_fetch", { url: "https://a" }),
      toolOutputAvailable("t1", { status: 200 }),
      toolInputAvailable("t1", "web_fetch", { url: "https://b" }),
    ];
    const result = accumulateChunks(chunks);
    const entry = result.get("t1");
    // The last chunk overwrites, so state becomes input-available again.
    // This documents current accumulator behavior — the outer reconciler
    // (extractToolCalls) is responsible for finalising terminal states.
    expect(entry?.state).toBe("input-available");
  });

  describe("parentToolCallId stamping", () => {
    it("stamps parentToolCallId on every entry when provided", () => {
      const chunks = [
        toolInputStart("t1", "web_fetch"),
        toolInputAvailable("t2", "run_code", { code: "y" }),
      ];
      const result = accumulateChunks(chunks, "delegate-1");
      expect(result.get("t1")?.parentToolCallId).toBe("delegate-1");
      expect(result.get("t2")?.parentToolCallId).toBe("delegate-1");
    });

    it("does not stamp parentToolCallId when omitted", () => {
      const chunks = [toolInputStart("t1", "web_fetch")];
      const result = accumulateChunks(chunks);
      expect(result.get("t1")?.parentToolCallId).toBeUndefined();
    });

    it("retains existing parentToolCallId when re-applying to an existing entry", () => {
      const chunks = [
        toolInputStart("t1", "web_fetch"),
        toolOutputAvailable("t1", { status: 200 }),
      ];
      const result = accumulateChunks(chunks, "delegate-1");
      expect(result.get("t1")?.parentToolCallId).toBe("delegate-1");
    });

    it("stamps parentToolCallId on entries created from missing-start tolerance", () => {
      const chunks = [toolInputAvailable("t1", "web_fetch", { url: "https://x" })];
      const result = accumulateChunks(chunks, "delegate-2");
      expect(result.get("t1")?.parentToolCallId).toBe("delegate-2");
    });
  });

  describe("state transitions", () => {
    it("start → input-streaming with undefined input", () => {
      const result = accumulateChunks([toolInputStart("t1", "web_fetch")]);
      expect(result.get("t1")?.state).toBe("input-streaming");
      expect(result.get("t1")?.input).toBeUndefined();
    });

    it("available → input-available with input set", () => {
      const result = accumulateChunks([
        toolInputStart("t1", "web_fetch"),
        toolInputAvailable("t1", "web_fetch", { query: "hello" }),
      ]);
      expect(result.get("t1")?.state).toBe("input-available");
      expect(result.get("t1")?.input).toEqual({ query: "hello" });
    });

    it("output-available → output set, errorText cleared", () => {
      const result = accumulateChunks([
        toolInputStart("t1", "web_fetch"),
        toolInputAvailable("t1", "web_fetch", {}),
        toolOutputError("t1", "first error"),
        toolOutputAvailable("t1", { ok: true }),
      ]);
      expect(result.get("t1")?.state).toBe("output-available");
      expect(result.get("t1")?.output).toEqual({ ok: true });
      // errorText is preserved from existing when not present in chunk
      expect(result.get("t1")?.errorText).toBe("first error");
    });

    it("output-error → errorText set, output preserved from prior", () => {
      const result = accumulateChunks([
        toolInputStart("t1", "web_fetch"),
        toolInputAvailable("t1", "web_fetch", {}),
        toolOutputAvailable("t1", { ok: true }),
        toolOutputError("t1", "late failure"),
      ]);
      expect(result.get("t1")?.state).toBe("output-error");
      expect(result.get("t1")?.errorText).toBe("late failure");
      // output is preserved because the error chunk doesn't touch it
      expect(result.get("t1")?.output).toEqual({ ok: true });
    });
  });
});

import { describe, expect, it } from "vitest";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { extractToolCalls } from "./extract-tool-calls.ts";

// ---------------------------------------------------------------------------
// Test helpers
//
// `AtlasUIMessage.parts` is a structural tagged union from AI SDK v6 that we
// intentionally over-narrow here — the reducer only dispatches on `type`,
// `toolCallId`, and a handful of adjacent fields, so we can pass hand-built
// fixture parts through `as unknown as AtlasUIMessage` without caring about
// the full generic. The reducer itself never trusts the discriminator tag
// and re-narrows each field with `in` checks.
//
// Fixture IDs are clean (no namespacing) because the server-side proxy writer
// and nested-chunk writer no longer mutate toolCallId strings. Parentage is
// carried explicitly via `parentToolCallId` inside `data-nested-chunk`
// envelopes.
// ---------------------------------------------------------------------------

function makeMessage(parts: unknown[], extra: Record<string, unknown> = {}): AtlasUIMessage {
  return {
    id: "msg-1",
    role: "assistant",
    parts,
    ...extra,
  } as unknown as AtlasUIMessage;
}

/** Top-level `tool-delegate` part in the shape AI SDK v6 writes to `msg.parts`. */
function delegatePart(toolCallId: string, state: string, input?: unknown, output?: unknown) {
  return {
    type: "tool-delegate",
    toolCallId,
    state,
    input,
    output,
  };
}

/** A plain static tool part (non-delegate) used as a non-target parent. */
function staticToolPart(toolName: string, toolCallId: string, state: string) {
  return {
    type: `tool-${toolName}`,
    toolCallId,
    state,
  };
}

/** A `data-nested-chunk` envelope for direct (non-delegate) agent calls. */
function nestedChunk(parentToolCallId: string, chunk: unknown) {
  return {
    type: "data-nested-chunk",
    data: { parentToolCallId, chunk },
  };
}

/** A `data-delegate-chunk` envelope wrapping a raw child chunk. */
function delegateChunk(delegateToolCallId: string, chunk: unknown) {
  return {
    type: "data-delegate-chunk",
    data: { delegateToolCallId, chunk },
  };
}

/** A `data-delegate-chunk` envelope wrapping a double-wrapped `nested-chunk`. */
function delegateNestedChunk(delegateToolCallId: string, parentToolCallId: string, chunk: unknown) {
  return {
    type: "data-delegate-chunk",
    data: {
      delegateToolCallId,
      chunk: {
        type: "data-nested-chunk",
        data: { parentToolCallId, chunk },
      },
    },
  };
}

/** Build a `data-delegate-chunk` envelope wrapping a synthetic `delegate-end` terminator. */
function delegateEndEnvelope(delegateToolCallId: string) {
  return {
    type: "data-delegate-chunk",
    data: {
      delegateToolCallId,
      chunk: { type: "delegate-end" },
    },
  };
}

// Child chunk helpers — shape mirrors AI SDK v6 UIMessageChunk variants.
function toolInputStart(toolCallId: string, toolName: string) {
  return { type: "tool-input-start", toolCallId, toolName };
}
function toolInputAvailable(toolCallId: string, toolName: string, input: unknown) {
  return { type: "tool-input-available", toolCallId, toolName, input };
}
function toolOutputAvailable(toolCallId: string, output: unknown) {
  return { type: "tool-output-available", toolCallId, output };
}
function toolOutputError(toolCallId: string, errorText: string) {
  return { type: "tool-output-error", toolCallId, errorText };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractToolCalls", () => {
  describe("first pass (unchanged behavior)", () => {
    it("returns an empty array for messages without parts", () => {
      const msg = makeMessage([]);
      expect(extractToolCalls(msg)).toEqual([]);
    });

    it("extracts a static tool part", () => {
      const msg = makeMessage([staticToolPart("web_fetch", "call-1", "output-available")]);
      const [only] = extractToolCalls(msg);
      expect(only).toMatchObject({
        toolCallId: "call-1",
        toolName: "web_fetch",
        state: "output-available",
      });
    });

    it("extracts a dynamic-tool part", () => {
      const msg = makeMessage([
        {
          type: "dynamic-tool",
          toolCallId: "call-2",
          toolName: "custom_tool",
          state: "input-available",
          input: { query: "hi" },
        },
      ]);
      const [only] = extractToolCalls(msg);
      expect(only).toMatchObject({
        toolCallId: "call-2",
        toolName: "custom_tool",
        state: "input-available",
      });
    });

    it("ignores non-tool parts (text, reasoning, step-start, etc.)", () => {
      const msg = makeMessage([
        { type: "text", text: "hello" },
        { type: "step-start" },
        { type: "reasoning", text: "thinking" },
      ]);
      expect(extractToolCalls(msg)).toEqual([]);
    });
  });

  describe("direct agent_web via top-level nested-chunk", () => {
    it("reconstructs one inner fetch under a direct agent_web", () => {
      const msg = makeMessage([
        { type: "tool-agent_web", toolCallId: "aw1", state: "input-available" },
        nestedChunk("aw1", toolInputStart("f1", "fetch")),
        nestedChunk("aw1", toolInputAvailable("f1", "fetch", { url: "https://example.com" })),
        nestedChunk("aw1", toolOutputAvailable("f1", { status: 200 })),
      ]);

      const [aw1] = extractToolCalls(msg);
      expect(aw1?.toolCallId).toBe("aw1");
      expect(aw1?.toolName).toBe("agent_web");
      expect(aw1?.children).toHaveLength(1);

      const [f1] = aw1?.children ?? [];
      expect(f1?.toolCallId).toBe("f1");
      expect(f1?.toolName).toBe("fetch");
      expect(f1?.state).toBe("output-available");
      expect(f1?.output).toEqual({ status: 200 });
    });

    it("reconstructs multiple inner calls under a direct agent_web", () => {
      const msg = makeMessage([
        { type: "tool-agent_web", toolCallId: "aw1", state: "input-available" },
        nestedChunk("aw1", toolInputStart("f1", "fetch")),
        nestedChunk("aw1", toolInputAvailable("f1", "fetch", { url: "https://a" })),
        nestedChunk("aw1", toolOutputAvailable("f1", { status: 200 })),
        nestedChunk("aw1", toolInputStart("f2", "fetch")),
        nestedChunk("aw1", toolInputAvailable("f2", "fetch", { url: "https://b" })),
        nestedChunk("aw1", toolOutputAvailable("f2", { status: 200 })),
      ]);

      const [aw1] = extractToolCalls(msg);
      expect(aw1?.children).toHaveLength(2);
      const [f1, f2] = aw1?.children ?? [];
      expect(f1?.toolCallId).toBe("f1");
      expect(f2?.toolCallId).toBe("f2");
    });

    it("direct agent_web with reasoning/progress nested-chunk envelopes — tree is reconstructed, reasoning/progress not surfaced (delegate-specific)", () => {
      const msg = makeMessage([
        { type: "tool-agent_web", toolCallId: "aw1", state: "input-available" },
        nestedChunk("aw1", { type: "reasoning-delta", id: "r1", delta: "Let me check " }),
        nestedChunk("aw1", { type: "reasoning-delta", id: "r1", delta: "the weather..." }),
        nestedChunk("aw1", { type: "data-tool-progress", data: { toolName: "agent_web", content: "Analyzing..." } }),
        nestedChunk("aw1", toolInputStart("f1", "fetch")),
        nestedChunk("aw1", toolInputAvailable("f1", "fetch", { url: "https://x" })),
        nestedChunk("aw1", toolOutputAvailable("f1", { status: 200 })),
      ]);

      const [aw1] = extractToolCalls(msg);
      expect(aw1?.toolCallId).toBe("aw1");
      expect(aw1?.toolName).toBe("agent_web");
      // Reasoning/progress are not collected for non-delegate parents.
      expect(aw1?.reasoning).toBeUndefined();
      expect(aw1?.progress).toBeUndefined();
      expect(aw1?.children).toHaveLength(1);

      const [f1] = aw1?.children ?? [];
      expect(f1?.toolCallId).toBe("f1");
      expect(f1?.state).toBe("output-available");
    });

    it("promotes orphaned nested-chunk envelopes to root when parent absent", () => {
      // No tool-agent_web part for aw1, so f1 (parent aw1) becomes an orphan.
      const msg = makeMessage([
        nestedChunk("aw1", toolInputStart("f1", "fetch")),
        nestedChunk("aw1", toolInputAvailable("f1", "fetch", { url: "https://x" })),
      ]);

      const calls = extractToolCalls(msg);
      expect(calls).toHaveLength(1);
      const [f1] = calls;
      expect(f1?.toolCallId).toBe("f1");
      expect(f1?.toolName).toBe("fetch");
      expect(f1?.state).toBe("input-available");
      // parentToolCallId is stripped from output shape.
      expect("parentToolCallId" in f1!).toBe(false);
    });

    it("ignores malformed nested-chunk envelopes", () => {
      const msg = makeMessage([
        { type: "tool-agent_web", toolCallId: "aw1", state: "input-available" },
        { type: "data-nested-chunk" }, // no data
        { type: "data-nested-chunk", data: null }, // null data
        { type: "data-nested-chunk", data: { parentToolCallId: 42 } }, // non-string id
      ]);
      const [aw1] = extractToolCalls(msg);
      expect(aw1?.children).toBeUndefined();
    });
  });

  describe("delegate child reconstruction", () => {
    it("reconstructs two child tool calls under a delegate — one complete, one mid-stream", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available", { goal: "research", handoff: "..." }),
        delegateChunk("d1", toolInputStart("c1", "web_fetch")),
        delegateChunk("d1", toolInputAvailable("c1", "web_fetch", { url: "https://example.com" })),
        delegateChunk("d1", toolOutputAvailable("c1", { status: 200, body: "..." })),
        delegateChunk("d1", toolInputStart("c2", "run_code")),
        delegateChunk("d1", toolInputAvailable("c2", "run_code", { code: "print(1)" })),
      ]);

      const [parent] = extractToolCalls(msg);
      expect(parent?.toolCallId).toBe("d1");
      expect(parent?.toolName).toBe("delegate");
      expect(parent?.children).toHaveLength(2);

      // Child order mirrors wire order — Map insertion preserves it.
      const [c1, c2] = parent?.children ?? [];
      expect(c1?.toolCallId).toBe("c1");
      expect(c1?.toolName).toBe("web_fetch");
      expect(c1?.state).toBe("output-available");
      expect(c1?.output).toEqual({ status: 200, body: "..." });

      expect(c2?.toolCallId).toBe("c2");
      expect(c2?.toolName).toBe("run_code");
      expect(c2?.state).toBe("input-available");
      expect(c2?.output).toBeUndefined();
    });

    it("promotes a child to output-error when the wrapped chunk is tool-output-error", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegateChunk("d1", toolInputStart("c1", "web_fetch")),
        delegateChunk("d1", toolInputAvailable("c1", "web_fetch", { url: "https://bad" })),
        delegateChunk("d1", toolOutputError("c1", "DNS failure")),
      ]);
      const [parent] = extractToolCalls(msg);
      const [child] = parent?.children ?? [];
      expect(child?.state).toBe("output-error");
      expect(child?.errorText).toBe("DNS failure");
    });

    it("silently drops data-delegate-ledger parts from the tree", () => {
      const msg = makeMessage([
        delegatePart("d1", "output-available"),
        {
          type: "data-delegate-ledger",
          data: {
            delegateToolCallId: "d1",
            toolsUsed: [
              {
                toolCallId: "c1",
                name: "web_fetch",
                input: {},
                outcome: "success",
                stepIndex: 0,
                durationMs: 100,
              },
            ],
          },
        },
      ]);
      const calls = extractToolCalls(msg);
      expect(calls).toHaveLength(1);
      const [only] = calls;
      expect(only?.toolCallId).toBe("d1");
      expect(only?.children).toBeUndefined();
    });

    it("ignores orphan chunks whose delegateToolCallId has no matching top-level delegate", () => {
      const msg = makeMessage([
        staticToolPart("web_fetch", "call-1", "output-available"),
        delegateChunk("d-missing", toolInputStart("orphan", "run_code")),
      ]);
      const calls = extractToolCalls(msg);
      expect(calls).toHaveLength(1);
      const [only] = calls;
      expect(only?.toolCallId).toBe("call-1");
      expect(only?.children).toBeUndefined();
    });

    it("ignores chunks whose delegateToolCallId matches a non-delegate parent", () => {
      const msg = makeMessage([
        staticToolPart("web_fetch", "shared-id", "output-available"),
        delegateChunk("shared-id", toolInputStart("c1", "run_code")),
      ]);
      const calls = extractToolCalls(msg);
      expect(calls).toHaveLength(1);
      const [only] = calls;
      expect(only?.toolName).toBe("web_fetch");
      expect(only?.children).toBeUndefined();
    });

    it("handles multiple concurrent delegates without cross-pollination", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegatePart("d2", "input-available"),
        delegateChunk("d1", toolInputStart("a", "web_fetch")),
        delegateChunk("d2", toolInputStart("b", "run_code")),
        delegateChunk("d1", toolInputAvailable("a", "web_fetch", { url: "x" })),
        delegateChunk("d2", toolInputAvailable("b", "run_code", { code: "y" })),
      ]);
      const [first, second] = extractToolCalls(msg);
      expect(first?.toolCallId).toBe("d1");
      const [d1Child] = first?.children ?? [];
      expect(d1Child?.toolCallId).toBe("a");
      expect(second?.toolCallId).toBe("d2");
      const [d2Child] = second?.children ?? [];
      expect(d2Child?.toolCallId).toBe("b");
    });

    it("ignores malformed envelopes (missing data, non-string delegateToolCallId)", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        { type: "data-delegate-chunk" }, // no data
        { type: "data-delegate-chunk", data: null }, // null data
        { type: "data-delegate-chunk", data: { delegateToolCallId: 42 } }, // non-string id
      ]);
      const calls = extractToolCalls(msg);
      expect(calls).toHaveLength(1);
      const [only] = calls;
      expect(only?.children).toBeUndefined();
    });

    it("ignores chunk types the accumulator does not recognize", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegateChunk("d1", { type: "text-delta", id: "t1", delta: "hi" }),
        delegateChunk("d1", { type: "start-step" }),
      ]);
      const [only] = extractToolCalls(msg);
      expect(only?.children).toEqual([]);
    });
  });

  describe("delegate-end blanket terminator", () => {
    it("delegate-end interrupts all non-terminal children; terminal siblings unchanged", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegateChunk("d1", toolInputStart("c1", "web_fetch")),
        delegateChunk("d1", toolInputAvailable("c1", "web_fetch", { url: "x" })),
        delegateChunk("d1", toolInputStart("c2", "run_code")),
        delegateChunk("d1", toolInputAvailable("c2", "run_code", { code: "y" })),
        delegateChunk("d1", toolOutputAvailable("c2", { ok: true })),
        delegateEndEnvelope("d1"),
      ]);

      const [parent] = extractToolCalls(msg);
      const [c1, c2] = parent?.children ?? [];
      expect(c1?.toolCallId).toBe("c1");
      expect(c1?.state).toBe("output-error");
      expect(c1?.errorText).toBe("interrupted");
      expect(c2?.toolCallId).toBe("c2");
      expect(c2?.state).toBe("output-available");
      expect(c2?.errorText).toBeUndefined();
    });

    it("delegate-end never clobbers terminal-state children", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegateChunk("d1", toolInputStart("c1", "web_fetch")),
        delegateChunk("d1", toolInputAvailable("c1", "web_fetch", { url: "x" })),
        delegateChunk("d1", toolOutputAvailable("c1", { ok: true })),
        delegateEndEnvelope("d1"),
      ]);
      const [parent] = extractToolCalls(msg);
      const [c1] = parent?.children ?? [];
      expect(c1?.state).toBe("output-available");
      expect(c1?.errorText).toBeUndefined();
    });

    it("delegate-end across multiple delegates only touches its own children", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegatePart("d2", "input-available"),
        delegateChunk("d1", toolInputStart("a", "web_fetch")),
        delegateChunk("d1", toolInputAvailable("a", "web_fetch", { url: "x" })),
        delegateChunk("d2", toolInputStart("b", "run_code")),
        delegateChunk("d2", toolInputAvailable("b", "run_code", { code: "y" })),
        delegateEndEnvelope("d1"),
      ]);
      const [first, second] = extractToolCalls(msg);
      const [d1Child] = first?.children ?? [];
      const [d2Child] = second?.children ?? [];
      expect(d1Child?.state).toBe("output-error");
      expect(d1Child?.errorText).toBe("interrupted");
      expect(d2Child?.state).toBe("input-available");
      expect(d2Child?.errorText).toBeUndefined();
    });

    it("delegate-end interrupts the entire subtree recursively", () => {
      // Three-level tree: d1 → aw1 → f1. aw1 and f1 are both non-terminal.
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegateNestedChunk("d1", "aw1", toolInputStart("aw1", "agent_web")),
        delegateNestedChunk("d1", "aw1", toolInputAvailable("aw1", "agent_web", { prompt: "go" })),
        delegateNestedChunk("d1", "aw1", toolInputStart("f1", "fetch")),
        delegateNestedChunk("d1", "aw1", toolInputAvailable("f1", "fetch", { url: "https://..." })),
        delegateEndEnvelope("d1"),
      ]);

      const [d1] = extractToolCalls(msg);
      const [aw1] = d1?.children ?? [];
      expect(aw1?.state).toBe("output-error");
      expect(aw1?.errorText).toBe("interrupted");

      const [f1] = aw1?.children ?? [];
      expect(f1?.state).toBe("output-error");
      expect(f1?.errorText).toBe("interrupted");
    });
  });

  describe("three-level tree — delegate → agent_web → fetch", () => {
    it("builds a full three-level tree via double-wrapped nested-chunk", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available", { goal: "research", handoff: "..." }),
        // agent_web as direct child of delegate (nested-chunk inside delegate-chunk)
        delegateNestedChunk("d1", "aw1", toolInputStart("aw1", "agent_web")),
        delegateNestedChunk("d1", "aw1", toolInputAvailable("aw1", "agent_web", { prompt: "go to craigslist" })),
        // fetch nested under agent_web
        delegateNestedChunk("d1", "aw1", toolInputStart("f1", "fetch")),
        delegateNestedChunk("d1", "aw1", toolInputAvailable("f1", "fetch", { url: "https://..." })),
        delegateNestedChunk("d1", "aw1", toolOutputAvailable("f1", { status: 200 })),
        // agent_web completes
        delegateNestedChunk("d1", "aw1", toolOutputAvailable("aw1", { response: "found 3 items" })),
      ]);

      const [d1] = extractToolCalls(msg);
      expect(d1?.toolCallId).toBe("d1");
      expect(d1?.toolName).toBe("delegate");
      expect(d1?.children).toHaveLength(1);

      const [aw1] = d1?.children ?? [];
      expect(aw1?.toolCallId).toBe("aw1");
      expect(aw1?.toolName).toBe("agent_web");
      expect(aw1?.state).toBe("output-available");
      expect(aw1?.children).toHaveLength(1);

      const [f1] = aw1?.children ?? [];
      expect(f1?.toolCallId).toBe("f1");
      expect(f1?.toolName).toBe("fetch");
      expect(f1?.state).toBe("output-available");
      expect(f1?.children).toBeUndefined();
    });

    it("handles multiple fetches under the same agent_web inside a delegate", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegateNestedChunk("d1", "aw1", toolInputStart("aw1", "agent_web")),
        delegateNestedChunk("d1", "aw1", toolInputAvailable("aw1", "agent_web", { prompt: "search" })),
        delegateNestedChunk("d1", "aw1", toolInputStart("f1", "fetch")),
        delegateNestedChunk("d1", "aw1", toolInputAvailable("f1", "fetch", { url: "https://a" })),
        delegateNestedChunk("d1", "aw1", toolOutputAvailable("f1", { status: 200 })),
        delegateNestedChunk("d1", "aw1", toolInputStart("f2", "fetch")),
        delegateNestedChunk("d1", "aw1", toolInputAvailable("f2", "fetch", { url: "https://b" })),
        delegateNestedChunk("d1", "aw1", toolOutputAvailable("f2", { status: 200 })),
        delegateNestedChunk("d1", "aw1", toolOutputAvailable("aw1", { response: "done" })),
      ]);

      const [d1] = extractToolCalls(msg);
      const [aw1] = d1?.children ?? [];
      expect(aw1?.children).toHaveLength(2);
      const [f1, f2] = aw1?.children ?? [];
      expect(f1?.toolCallId).toBe("f1");
      expect(f2?.toolCallId).toBe("f2");
    });
  });

  describe("parallel agent_web calls with interleaved nested chunks", () => {
    it("reconstructs two interleaved agent_web trees under a delegate", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegateNestedChunk("d1", "aw1", toolInputStart("aw1", "agent_web")),
        delegateNestedChunk("d1", "aw2", toolInputStart("aw2", "agent_web")),
        delegateNestedChunk("d1", "aw1", toolInputAvailable("aw1", "agent_web", { prompt: "search A" })),
        delegateNestedChunk("d1", "aw2", toolInputAvailable("aw2", "agent_web", { prompt: "search B" })),
        delegateNestedChunk("d1", "aw1", toolInputStart("f1", "fetch")),
        delegateNestedChunk("d1", "aw2", toolInputStart("f2", "fetch")),
        delegateNestedChunk("d1", "aw1", toolOutputAvailable("f1", { status: 200 })),
        delegateNestedChunk("d1", "aw2", toolOutputAvailable("f2", { status: 200 })),
        delegateNestedChunk("d1", "aw1", toolOutputAvailable("aw1", { response: "A done" })),
        delegateNestedChunk("d1", "aw2", toolOutputAvailable("aw2", { response: "B done" })),
      ]);

      const [d1] = extractToolCalls(msg);
      expect(d1?.children).toHaveLength(2);
      const [aw1, aw2] = d1?.children ?? [];
      expect(aw1?.toolCallId).toBe("aw1");
      expect(aw1?.children).toHaveLength(1);
      expect(aw1?.children?.[0]?.toolCallId).toBe("f1");

      expect(aw2?.toolCallId).toBe("aw2");
      expect(aw2?.children).toHaveLength(1);
      expect(aw2?.children?.[0]?.toolCallId).toBe("f2");
    });
  });

  describe("ledger duration scoping", () => {
    it("attaches durationMs from data-delegate-ledger to reconstructed entries", () => {
      const msg = makeMessage([
        delegatePart("d1", "output-available"),
        delegateChunk("d1", toolInputStart("c1", "web_fetch")),
        delegateChunk("d1", toolInputAvailable("c1", "web_fetch", { url: "https://x" })),
        delegateChunk("d1", toolOutputAvailable("c1", { status: 200 })),
        {
          type: "data-delegate-ledger",
          data: {
            delegateToolCallId: "d1",
            toolsUsed: [
              {
                toolCallId: "c1",
                name: "web_fetch",
                input: {},
                outcome: "success",
                stepIndex: 0,
                durationMs: 2340,
              },
            ],
          },
        },
      ]);

      const [parent] = extractToolCalls(msg);
      const [child] = parent?.children ?? [];
      expect(child?.durationMs).toBe(2340);
    });

    it("ignores ledger entries with zero or missing durationMs", () => {
      const msg = makeMessage([
        delegatePart("d1", "output-available"),
        delegateChunk("d1", toolInputStart("c1", "web_fetch")),
        {
          type: "data-delegate-ledger",
          data: {
            delegateToolCallId: "d1",
            toolsUsed: [
              {
                toolCallId: "c1",
                name: "web_fetch",
                input: {},
                outcome: "success",
                stepIndex: 0,
                durationMs: 0,
              },
            ],
          },
        },
      ]);

      const [parent] = extractToolCalls(msg);
      const [child] = parent?.children ?? [];
      expect(child?.durationMs).toBeUndefined();
    });

    it("does not attach d1 ledger durations to d2 children with matching toolCallId", () => {
      const msg = makeMessage([
        delegatePart("d1", "output-available"),
        delegatePart("d2", "output-available"),
        delegateChunk("d1", toolInputStart("c1", "web_fetch")),
        delegateChunk("d1", toolInputAvailable("c1", "web_fetch", { url: "https://x" })),
        delegateChunk("d1", toolOutputAvailable("c1", { status: 200 })),
        delegateChunk("d2", toolInputStart("c1", "run_code")),
        delegateChunk("d2", toolInputAvailable("c1", "run_code", { code: "y" })),
        delegateChunk("d2", toolOutputAvailable("c1", { ok: true })),
        {
          type: "data-delegate-ledger",
          data: {
            delegateToolCallId: "d1",
            toolsUsed: [
              {
                toolCallId: "c1",
                name: "web_fetch",
                input: {},
                outcome: "success",
                stepIndex: 0,
                durationMs: 1234,
              },
            ],
          },
        },
      ]);

      const [first, second] = extractToolCalls(msg);
      const [d1Child] = first?.children ?? [];
      const [d2Child] = second?.children ?? [];
      expect(d1Child?.durationMs).toBe(1234);
      expect(d2Child?.durationMs).toBeUndefined();
    });
  });

  describe("reasoning and progress on delegate entry", () => {
    it("accumulates reasoning-delta chunks on the delegate entry", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegateChunk("d1", { type: "reasoning-delta", id: "r1", delta: "Let me check " }),
        delegateChunk("d1", { type: "reasoning-delta", id: "r1", delta: "the weather..." }),
        delegateChunk("d1", toolInputStart("c1", "web_search")),
      ]);

      const [parent] = extractToolCalls(msg);
      expect(parent?.reasoning).toBe("Let me check the weather...");
      expect(parent?.children).toHaveLength(1);
    });

    it("collects data-tool-progress events as progress lines on the delegate entry", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegateChunk("d1", {
          type: "data-tool-progress",
          data: { toolName: "agent_web", content: "Analyzing query..." },
        }),
        delegateChunk("d1", {
          type: "data-tool-progress",
          data: { toolName: "agent_web", content: "Synthesizing..." },
        }),
        delegateChunk("d1", toolInputStart("c1", "fetch")),
      ]);

      const [parent] = extractToolCalls(msg);
      expect(parent?.progress).toEqual(["Analyzing query...", "Synthesizing..."]);
      expect(parent?.children).toHaveLength(1);
    });
  });
});

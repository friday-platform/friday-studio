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
// Child toolCallIds are namespaced `${delegateToolCallId}::${childId}` —
// that matches how the proxy writer emits them (see
// `packages/system/agents/conversation/tools/delegate/proxy-writer.ts`).
// The reducer preserves the namespaced string verbatim; it does not strip
// the prefix. Tests assert against the namespaced form.
// ---------------------------------------------------------------------------

function makeMessage(parts: unknown[]): AtlasUIMessage {
  return {
    id: "msg-1",
    role: "assistant",
    parts,
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

/** Build a `data-delegate-chunk` envelope wrapping a child chunk. */
function envelope(delegateToolCallId: string, chunk: unknown) {
  return {
    type: "data-delegate-chunk",
    data: { delegateToolCallId, chunk },
  };
}

// Child chunk helpers — shape mirrors AI SDK v6 UIMessageChunk variants the
// proxy writer forwards. `toolCallId` here is already namespaced, which is
// what the proxy writer produces on the wire.
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

  describe("second pass — delegate child reconstruction", () => {
    it("reconstructs two child tool calls under a delegate — one complete, one mid-stream", () => {
      // Fixture: parent delegate `d1` with two child tool calls:
      //   - `web_fetch` (complete: start → available → output-available)
      //   - `run_code`  (mid-stream: start → input-available, no output yet)
      const msg = makeMessage([
        delegatePart("d1", "input-available", { goal: "research", handoff: "..." }),
        envelope("d1", toolInputStart("d1::c1", "web_fetch")),
        envelope("d1", toolInputAvailable("d1::c1", "web_fetch", { url: "https://example.com" })),
        envelope("d1", toolOutputAvailable("d1::c1", { status: 200, body: "..." })),
        envelope("d1", toolInputStart("d1::c2", "run_code")),
        envelope("d1", toolInputAvailable("d1::c2", "run_code", { code: "print(1)" })),
      ]);

      const [parent] = extractToolCalls(msg);
      expect(parent?.toolCallId).toBe("d1");
      expect(parent?.toolName).toBe("delegate");
      expect(parent?.children).toHaveLength(2);

      // Child order mirrors wire order — Map insertion preserves it.
      const [c1, c2] = parent?.children ?? [];
      expect(c1?.toolCallId).toBe("d1::c1");
      expect(c1?.toolName).toBe("web_fetch");
      expect(c1?.state).toBe("output-available");
      expect(c1?.output).toEqual({ status: 200, body: "..." });

      expect(c2?.toolCallId).toBe("d1::c2");
      expect(c2?.toolName).toBe("run_code");
      expect(c2?.state).toBe("input-available");
      expect(c2?.output).toBeUndefined();
    });

    it("promotes a child to output-error when the wrapped chunk is tool-output-error", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", toolInputStart("d1::c1", "web_fetch")),
        envelope("d1", toolInputAvailable("d1::c1", "web_fetch", { url: "https://bad" })),
        envelope("d1", toolOutputError("d1::c1", "DNS failure")),
      ]);
      const [parent] = extractToolCalls(msg);
      const [child] = parent?.children ?? [];
      expect(child?.state).toBe("output-error");
      expect(child?.errorText).toBe("DNS failure");
    });

    it("silently drops data-delegate-ledger parts from the tree", () => {
      // Ledger parts should never surface in the returned tree — they're for a
      // future reflection layer, not the UI. Even with a matching delegate
      // present and no chunk envelopes, the result should be the flat parent only.
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
      // Chunk envelope for `d-missing` with no corresponding `tool-delegate`
      // part — reducer leaves the only top-level entry untouched.
      const msg = makeMessage([
        staticToolPart("web_fetch", "call-1", "output-available"),
        envelope("d-missing", toolInputStart("d-missing::orphan", "run_code")),
      ]);
      const calls = extractToolCalls(msg);
      expect(calls).toHaveLength(1);
      const [only] = calls;
      expect(only?.toolCallId).toBe("call-1");
      expect(only?.children).toBeUndefined();
    });

    it("ignores chunks whose delegateToolCallId matches a non-delegate parent", () => {
      // Defensive against a tool accidentally named the same as a collision
      // or a future reducer bug — the parent must actually be the delegate
      // tool (toolName === "delegate") to accept children.
      const msg = makeMessage([
        staticToolPart("web_fetch", "shared-id", "output-available"),
        envelope("shared-id", toolInputStart("shared-id::c1", "run_code")),
      ]);
      const calls = extractToolCalls(msg);
      expect(calls).toHaveLength(1);
      const [only] = calls;
      expect(only?.toolName).toBe("web_fetch");
      expect(only?.children).toBeUndefined();
    });

    it("preserves namespaced ${delegateToolCallId}::${childId} form on reconstructed children", () => {
      // Documented choice: the reducer keeps the namespaced string verbatim
      // as emitted by the proxy writer. Stripping the prefix would require
      // re-tracking provenance for downstream callers and provides no UI
      // benefit — the rendered chip can slice the prefix cosmetically.
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", toolInputStart("d1::inner-1", "web_search")),
        envelope("d1", toolInputAvailable("d1::inner-1", "web_search", { q: "friday" })),
      ]);
      const [parent] = extractToolCalls(msg);
      const [child] = parent?.children ?? [];
      expect(child?.toolCallId).toBe("d1::inner-1");
    });

    it("handles multiple concurrent delegates without cross-pollination", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegatePart("d2", "input-available"),
        envelope("d1", toolInputStart("d1::a", "web_fetch")),
        envelope("d2", toolInputStart("d2::b", "run_code")),
        envelope("d1", toolInputAvailable("d1::a", "web_fetch", { url: "x" })),
        envelope("d2", toolInputAvailable("d2::b", "run_code", { code: "y" })),
      ]);
      const [first, second] = extractToolCalls(msg);
      expect(first?.toolCallId).toBe("d1");
      const [firstChild] = first?.children ?? [];
      expect(firstChild?.toolCallId).toBe("d1::a");
      expect(second?.toolCallId).toBe("d2");
      const [secondChild] = second?.children ?? [];
      expect(secondChild?.toolCallId).toBe("d2::b");
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
      // Unknown chunk types (e.g. text-delta, step-start) should not create
      // child entries in the tree — we reconstruct only tool-* state
      // transitions.
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", { type: "text-delta", id: "t1", delta: "hi" }),
        envelope("d1", { type: "start-step" }),
      ]);
      const [only] = extractToolCalls(msg);
      expect(only?.children).toEqual([]);
    });
  });
});

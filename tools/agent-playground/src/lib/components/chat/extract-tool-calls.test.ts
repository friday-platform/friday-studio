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
// Child toolCallIds are namespaced `${delegateToolCallId}-${childId}` —
// that matches how the proxy writer emits them (see
// `packages/system/agents/conversation/tools/delegate/proxy-writer.ts`).
// The reducer preserves the namespaced string verbatim; it does not strip
// the prefix. Tests assert against the namespaced form.
// ---------------------------------------------------------------------------

function makeMessage(parts: unknown[], extra: Record<string, unknown> = {}): AtlasUIMessage {
  return {
    id: "msg-1",
    role: "assistant",
    parts,
    ...extra,
  } as unknown as AtlasUIMessage;
}

/** Build a `data-delegate-chunk` envelope wrapping a synthetic `delegate-end` terminator. */
function delegateEndEnvelope(delegateToolCallId: string, pendingToolCallIds: string[]) {
  return {
    type: "data-delegate-chunk",
    data: {
      delegateToolCallId,
      chunk: { type: "delegate-end", pendingToolCallIds },
    },
  };
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
function toolTiming(toolCallId: string, durationMs: number) {
  return { type: "data-tool-timing", data: { toolCallId, durationMs } };
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
        envelope("d1", toolInputStart("d1-c1", "web_fetch")),
        envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "https://example.com" })),
        envelope("d1", toolOutputAvailable("d1-c1", { status: 200, body: "..." })),
        envelope("d1", toolInputStart("d1-c2", "run_code")),
        envelope("d1", toolInputAvailable("d1-c2", "run_code", { code: "print(1)" })),
      ]);

      const [parent] = extractToolCalls(msg);
      expect(parent?.toolCallId).toBe("d1");
      expect(parent?.toolName).toBe("delegate");
      expect(parent?.children).toHaveLength(2);

      // Child order mirrors wire order — Map insertion preserves it.
      const [c1, c2] = parent?.children ?? [];
      expect(c1?.toolCallId).toBe("d1-c1");
      expect(c1?.toolName).toBe("web_fetch");
      expect(c1?.state).toBe("output-available");
      expect(c1?.output).toEqual({ status: 200, body: "..." });

      expect(c2?.toolCallId).toBe("d1-c2");
      expect(c2?.toolName).toBe("run_code");
      expect(c2?.state).toBe("input-available");
      expect(c2?.output).toBeUndefined();
    });

    it("promotes a child to output-error when the wrapped chunk is tool-output-error", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", toolInputStart("d1-c1", "web_fetch")),
        envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "https://bad" })),
        envelope("d1", toolOutputError("d1-c1", "DNS failure")),
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
        envelope("d-missing", toolInputStart("d-missing-orphan", "run_code")),
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
        envelope("shared-id", toolInputStart("shared-id-c1", "run_code")),
      ]);
      const calls = extractToolCalls(msg);
      expect(calls).toHaveLength(1);
      const [only] = calls;
      expect(only?.toolName).toBe("web_fetch");
      expect(only?.children).toBeUndefined();
    });

    it("preserves namespaced ${delegateToolCallId}-${childId} form on reconstructed children", () => {
      // Documented choice: the reducer keeps the namespaced string verbatim
      // as emitted by the proxy writer. Stripping the prefix would require
      // re-tracking provenance for downstream callers and provides no UI
      // benefit — the rendered chip can slice the prefix cosmetically.
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", toolInputStart("d1-inner1", "web_search")),
        envelope("d1", toolInputAvailable("d1-inner1", "web_search", { q: "friday" })),
      ]);
      const [parent] = extractToolCalls(msg);
      const [child] = parent?.children ?? [];
      expect(child?.toolCallId).toBe("d1-inner1");
    });

    it("handles multiple concurrent delegates without cross-pollination", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        delegatePart("d2", "input-available"),
        envelope("d1", toolInputStart("d1-a", "web_fetch")),
        envelope("d2", toolInputStart("d2-b", "run_code")),
        envelope("d1", toolInputAvailable("d1-a", "web_fetch", { url: "x" })),
        envelope("d2", toolInputAvailable("d2-b", "run_code", { code: "y" })),
      ]);
      const [first, second] = extractToolCalls(msg);
      expect(first?.toolCallId).toBe("d1");
      const [firstChild] = first?.children ?? [];
      expect(firstChild?.toolCallId).toBe("d1-a");
      expect(second?.toolCallId).toBe("d2");
      const [secondChild] = second?.children ?? [];
      expect(secondChild?.toolCallId).toBe("d2-b");
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

  describe("Task #7 — delegate-end terminator + parent-state crash fallback", () => {
    it("delegate-end promotes listed pending children to output-error 'interrupted'; siblings unchanged", () => {
      // d1 has two children: c1 (mid-stream, listed in delegate-end) and
      // c2 (cleanly completed). The terminator must only touch c1.
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", toolInputStart("d1-c1", "web_fetch")),
        envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "x" })),
        envelope("d1", toolInputStart("d1-c2", "run_code")),
        envelope("d1", toolInputAvailable("d1-c2", "run_code", { code: "y" })),
        envelope("d1", toolOutputAvailable("d1-c2", { ok: true })),
        delegateEndEnvelope("d1", ["d1-c1"]),
      ]);

      const [parent] = extractToolCalls(msg);
      const [c1, c2] = parent?.children ?? [];
      expect(c1?.toolCallId).toBe("d1-c1");
      expect(c1?.state).toBe("output-error");
      expect(c1?.errorText).toBe("interrupted");
      expect(c2?.toolCallId).toBe("d1-c2");
      expect(c2?.state).toBe("output-available");
      expect(c2?.errorText).toBeUndefined();
    });

    it("delegate-end never clobbers terminal-state children", () => {
      // Pathological: delegate-end claims a child is pending, but the child
      // already reached output-available. Trust the terminal state.
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", toolInputStart("d1-c1", "web_fetch")),
        envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "x" })),
        envelope("d1", toolOutputAvailable("d1-c1", { ok: true })),
        delegateEndEnvelope("d1", ["d1-c1"]),
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
        envelope("d1", toolInputStart("d1-a", "web_fetch")),
        envelope("d1", toolInputAvailable("d1-a", "web_fetch", { url: "x" })),
        envelope("d2", toolInputStart("d2-b", "run_code")),
        envelope("d2", toolInputAvailable("d2-b", "run_code", { code: "y" })),
        delegateEndEnvelope("d1", ["d1-a"]),
      ]);
      const [first, second] = extractToolCalls(msg);
      const [d1Child] = first?.children ?? [];
      const [d2Child] = second?.children ?? [];
      expect(d1Child?.state).toBe("output-error");
      expect(d1Child?.errorText).toBe("interrupted");
      expect(d2Child?.state).toBe("input-available");
      expect(d2Child?.errorText).toBeUndefined();
    });

    it("parent.state === 'done' fallback promotes all in-progress children when no delegate-end seen", () => {
      // Crash-simulated: parent reached 'done' but no delegate-end ever
      // arrived. Both in-progress children get interrupted.
      const msg = makeMessage(
        [
          delegatePart("d1", "input-available"),
          envelope("d1", toolInputStart("d1-c1", "web_fetch")),
          // c1 stuck at input-streaming (no input-available)
          envelope("d1", toolInputStart("d1-c2", "run_code")),
          envelope("d1", toolInputAvailable("d1-c2", "run_code", { code: "y" })),
          // c2 stuck at input-available (no output)
        ],
        { state: "done" },
      );
      const [parent] = extractToolCalls(msg);
      const [c1, c2] = parent?.children ?? [];
      expect(c1?.state).toBe("output-error");
      expect(c1?.errorText).toBe("interrupted");
      expect(c2?.state).toBe("output-error");
      expect(c2?.errorText).toBe("interrupted");
    });

    it("parent.state === 'done' fallback leaves terminal-state children untouched", () => {
      // Regression: a completed child under a 'done' parent without a
      // delegate-end must stay output-available.
      const msg = makeMessage(
        [
          delegatePart("d1", "input-available"),
          envelope("d1", toolInputStart("d1-c1", "web_fetch")),
          envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "x" })),
          envelope("d1", toolOutputAvailable("d1-c1", { ok: true })),
        ],
        { state: "done" },
      );
      const [parent] = extractToolCalls(msg);
      const [c1] = parent?.children ?? [];
      expect(c1?.state).toBe("output-available");
      expect(c1?.errorText).toBeUndefined();
    });

    it("rule ordering: delegate-end takes precedence over parent.state fallback", () => {
      // Two delegates under a 'done' parent: dA has explicit delegate-end,
      // dB does not. Both still produce 'interrupted' on their pending
      // children, but via different rules.
      const msg = makeMessage(
        [
          delegatePart("dA", "input-available"),
          delegatePart("dB", "input-available"),
          envelope("dA", toolInputStart("dA-c1", "web_fetch")),
          envelope("dA", toolInputAvailable("dA-c1", "web_fetch", { url: "x" })),
          envelope("dB", toolInputStart("dB-c1", "run_code")),
          envelope("dB", toolInputAvailable("dB-c1", "run_code", { code: "y" })),
          delegateEndEnvelope("dA", ["dA-c1"]),
        ],
        { state: "done" },
      );
      const [pa, pb] = extractToolCalls(msg);
      const [aChild] = pa?.children ?? [];
      const [bChild] = pb?.children ?? [];
      expect(aChild?.state).toBe("output-error");
      expect(aChild?.errorText).toBe("interrupted");
      expect(bChild?.state).toBe("output-error");
      expect(bChild?.errorText).toBe("interrupted");
    });

    it("parent.state === 'done' does nothing when a delegate-end was already received (even with empty pendingToolCallIds)", () => {
      // delegate-end with [] means the delegate completed cleanly with no
      // pending children. The fallback rule must not second-guess it — a
      // still-streaming child here is genuinely unfinished, not crashed.
      const msg = makeMessage(
        [
          delegatePart("d1", "input-available"),
          envelope("d1", toolInputStart("d1-c1", "web_fetch")),
          envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "x" })),
          envelope("d1", toolOutputAvailable("d1-c1", { ok: true })),
          delegateEndEnvelope("d1", []),
        ],
        { state: "done" },
      );
      const [parent] = extractToolCalls(msg);
      const [c1] = parent?.children ?? [];
      expect(c1?.state).toBe("output-available");
      expect(c1?.errorText).toBeUndefined();
    });

    it("data-delegate-ledger parts remain ignored even with the new rules in play", () => {
      // Regression on Task #3's filter: ledger parts must not be interpreted
      // as terminators or otherwise affect the new rules.
      const msg = makeMessage(
        [
          delegatePart("d1", "input-available"),
          envelope("d1", toolInputStart("d1-c1", "web_fetch")),
          envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "x" })),
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
        ],
        { state: "done" },
      );
      const [parent] = extractToolCalls(msg);
      const [c1] = parent?.children ?? [];
      // No delegate-end → fallback applies → child gets interrupted.
      expect(c1?.state).toBe("output-error");
      expect(c1?.errorText).toBe("interrupted");
    });

    it("malformed delegate-end (non-array pendingToolCallIds) is ignored — fallback still applies", () => {
      const msg = makeMessage(
        [
          delegatePart("d1", "input-available"),
          envelope("d1", toolInputStart("d1-c1", "web_fetch")),
          envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "x" })),
          {
            type: "data-delegate-chunk",
            data: {
              delegateToolCallId: "d1",
              chunk: { type: "delegate-end", pendingToolCallIds: "not-an-array" },
            },
          },
        ],
        { state: "done" },
      );
      const [parent] = extractToolCalls(msg);
      const [c1] = parent?.children ?? [];
      // Malformed terminator is dropped → no delegate-end seen → fallback
      // promotes the in-progress child.
      expect(c1?.state).toBe("output-error");
      expect(c1?.errorText).toBe("interrupted");
    });
  });

  describe("nested delegate children — agent_web → fetch hierarchy", () => {
    it("builds a two-level tree: delegate → agent_web → fetch", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available", { goal: "research", handoff: "..." }),
        // agent_web as a direct child of delegate
        envelope("d1", toolInputStart("d1-aw1", "agent_web")),
        envelope("d1", toolInputAvailable("d1-aw1", "agent_web", { prompt: "go to craigslist" })),
        // fetch nested under agent_web
        envelope("d1", toolInputStart("d1-aw1-f1", "fetch")),
        envelope("d1", toolInputAvailable("d1-aw1-f1", "fetch", { url: "https://..." })),
        envelope("d1", toolOutputAvailable("d1-aw1-f1", { status: 200 })),
        // agent_web completes
        envelope("d1", toolOutputAvailable("d1-aw1", { response: "found 3 items" })),
      ]);

      const [parent] = extractToolCalls(msg);
      expect(parent?.toolCallId).toBe("d1");
      expect(parent?.toolName).toBe("delegate");
      expect(parent?.children).toHaveLength(1);

      const [aw1] = parent?.children ?? [];
      expect(aw1?.toolCallId).toBe("d1-aw1");
      expect(aw1?.toolName).toBe("agent_web");
      expect(aw1?.state).toBe("output-available");
      expect(aw1?.children).toHaveLength(1);

      const [f1] = aw1?.children ?? [];
      expect(f1?.toolCallId).toBe("d1-aw1-f1");
      expect(f1?.toolName).toBe("fetch");
      expect(f1?.state).toBe("output-available");
      expect(f1?.children).toBeUndefined();
    });

    it("handles multiple fetches under the same agent_web", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", toolInputStart("d1-aw1", "agent_web")),
        envelope("d1", toolInputAvailable("d1-aw1", "agent_web", { prompt: "search" })),
        envelope("d1", toolInputStart("d1-aw1-f1", "fetch")),
        envelope("d1", toolInputAvailable("d1-aw1-f1", "fetch", { url: "https://a" })),
        envelope("d1", toolOutputAvailable("d1-aw1-f1", { status: 200 })),
        envelope("d1", toolInputStart("d1-aw1-f2", "fetch")),
        envelope("d1", toolInputAvailable("d1-aw1-f2", "fetch", { url: "https://b" })),
        envelope("d1", toolOutputAvailable("d1-aw1-f2", { status: 200 })),
        envelope("d1", toolOutputAvailable("d1-aw1", { response: "done" })),
      ]);

      const [parent] = extractToolCalls(msg);
      const [aw1] = parent?.children ?? [];
      expect(aw1?.children).toHaveLength(2);
      const [f1, f2] = aw1?.children ?? [];
      expect(f1?.toolCallId).toBe("d1-aw1-f1");
      expect(f2?.toolCallId).toBe("d1-aw1-f2");
    });

    it("interrupts the entire subtree when delegate-end lists a parent agent tool", () => {
      // agent_web started but never completed; fetch also never got output.
      // delegate-end lists d1-aw1 as pending. Both aw1 and its child f1
      // should be marked output-error.
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", toolInputStart("d1-aw1", "agent_web")),
        envelope("d1", toolInputAvailable("d1-aw1", "agent_web", { prompt: "go" })),
        envelope("d1", toolInputStart("d1-aw1-f1", "fetch")),
        envelope("d1", toolInputAvailable("d1-aw1-f1", "fetch", { url: "https://..." })),
        // No output for f1 or aw1 — still in-flight.
        delegateEndEnvelope("d1", ["d1-aw1"]),
      ]);

      const [parent] = extractToolCalls(msg);
      const [aw1] = parent?.children ?? [];
      expect(aw1?.state).toBe("output-error");
      expect(aw1?.errorText).toBe("interrupted");

      const [f1] = aw1?.children ?? [];
      expect(f1?.state).toBe("output-error");
      expect(f1?.errorText).toBe("interrupted");
    });

    it("parentDone fallback interrupts all nested non-terminal children", () => {
      const msg = makeMessage(
        [
          delegatePart("d1", "input-available"),
          envelope("d1", toolInputStart("d1-aw1", "agent_web")),
          envelope("d1", toolInputAvailable("d1-aw1", "agent_web", { prompt: "go" })),
          envelope("d1", toolInputStart("d1-aw1-f1", "fetch")),
          envelope("d1", toolInputAvailable("d1-aw1-f1", "fetch", { url: "https://..." })),
          // fetch completed, agent_web did not
          envelope("d1", toolOutputAvailable("d1-aw1-f1", { status: 200 })),
        ],
        { state: "done" },
      );

      const [parent] = extractToolCalls(msg);
      const [aw1] = parent?.children ?? [];
      expect(aw1?.state).toBe("output-error");
      expect(aw1?.errorText).toBe("interrupted");

      const [f1] = aw1?.children ?? [];
      // f1 was already terminal — should NOT be clobbered.
      expect(f1?.state).toBe("output-available");
      expect(f1?.errorText).toBeUndefined();
    });

    it("accumulates reasoning-delta chunks on the delegate entry", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", { type: "reasoning-delta", id: "r1", delta: "Let me check " }),
        envelope("d1", { type: "reasoning-delta", id: "r1", delta: "the weather..." }),
        envelope("d1", toolInputStart("d1-c1", "web_search")),
      ]);

      const [parent] = extractToolCalls(msg);
      expect(parent?.reasoning).toBe("Let me check the weather...");
      expect(parent?.children).toHaveLength(1);
    });

    it("collects data-tool-progress events as progress lines on the delegate entry", () => {
      const msg = makeMessage([
        delegatePart("d1", "input-available"),
        envelope("d1", {
          type: "data-tool-progress",
          data: { toolName: "agent_web", content: "Analyzing query..." },
        }),
        envelope("d1", {
          type: "data-tool-progress",
          data: { toolName: "agent_web", content: "Synthesizing..." },
        }),
        envelope("d1", toolInputStart("d1-c1", "fetch")),
      ]);

      const [parent] = extractToolCalls(msg);
      expect(parent?.progress).toEqual(["Analyzing query...", "Synthesizing..."]);
      expect(parent?.children).toHaveLength(1);
    });

    it("attaches durationMs from data-delegate-ledger to reconstructed entries", () => {
      const msg = makeMessage([
        delegatePart("d1", "output-available"),
        envelope("d1", toolInputStart("d1-c1", "web_fetch")),
        envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "https://x" })),
        envelope("d1", toolOutputAvailable("d1-c1", { status: 200 })),
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
        envelope("d1", toolInputStart("d1-c1", "web_fetch")),
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

    it("attaches durationMs from data-tool-timing to reconstructed entries", () => {
      const msg = makeMessage([
        delegatePart("d1", "output-available"),
        envelope("d1", toolInputStart("d1-c1", "web_fetch")),
        envelope("d1", toolInputAvailable("d1-c1", "web_fetch", { url: "https://x" })),
        envelope("d1", toolTiming("d1-c1", 5230)),
        envelope("d1", toolOutputAvailable("d1-c1", { status: 200 })),
      ]);

      const [parent] = extractToolCalls(msg);
      const [child] = parent?.children ?? [];
      expect(child?.durationMs).toBe(5230);
    });

    it("attaches data-tool-timing durationMs to nested grandchildren", () => {
      const msg = makeMessage([
        delegatePart("d1", "output-available"),
        envelope("d1", toolInputStart("d1-aw1", "agent_web")),
        envelope("d1", toolInputAvailable("d1-aw1", "agent_web", { prompt: "go" })),
        envelope("d1", toolInputStart("d1-aw1-f1", "fetch")),
        envelope("d1", toolInputAvailable("d1-aw1-f1", "fetch", { url: "https://x" })),
        envelope("d1", toolTiming("d1-aw1-f1", 1890)),
        envelope("d1", toolOutputAvailable("d1-aw1-f1", { status: 200 })),
        envelope("d1", toolOutputAvailable("d1-aw1", { response: "done" })),
      ]);

      const [parent] = extractToolCalls(msg);
      const [aw1] = parent?.children ?? [];
      const [f1] = aw1?.children ?? [];
      expect(f1?.durationMs).toBe(1890);
    });

    it("ignores data-tool-timing when no matching accumulator entry exists", () => {
      const msg = makeMessage([
        delegatePart("d1", "output-available"),
        envelope("d1", toolTiming("d1-missing", 1234)),
      ]);

      const [parent] = extractToolCalls(msg);
      expect(parent?.children).toEqual([]);
    });
  });
});
